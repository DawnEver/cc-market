import { readFileSync } from 'node:fs';
import { openDb, upsertDailySummary } from './db.mjs';
import { todayISO } from './lib.mjs';

// Approximate pricing per 1M tokens (USD). Updated periodically.
const MODEL_PRICING = {
  // Claude models (API pricing per 1M tokens)
  // https://platform.claude.com/docs/zh-CN/about-claude/pricing  2026/06/10
  'claude-fable-5':          { input: 10.00, output: 50.00, cache_write: 12.50, cache_read: 1.00 },
  'claude-mythos-5':         { input: 10.00, output: 50.00, cache_write: 12.50, cache_read: 1.00 },
  'claude-opus-4.8':         { input: 5.00,  output: 25.00, cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4.7':         { input: 5.00,  output: 25.00, cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4.6':         { input: 5.00,  output: 25.00, cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4.5':         { input: 5.00,  output: 25.00, cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4':           { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-sonnet-4.6':       { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  'claude-sonnet-4.5':       { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  'claude-sonnet-4':         { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  'claude-haiku-4.5':        { input: 1.00,  output: 5.00,  cache_write: 1.25,  cache_read: 0.10 },
  'claude-haiku-3.5':        { input: 0.80,  output: 4.00,  cache_write: 1.00,  cache_read: 0.08 },
  // DeepSeek models (pricing per 1M tokens — flat input, no cache_write)
  // https://api-docs.deepseek.com/quick_start/pricing 2026/06/10
  'deepseek-v4-pro':         { input: 0.435, output: 0.87,  cache_hit: 0.003625 },
  'deepseek-v4-flash':       { input: 0.14,  output: 0.28,  cache_hit: 0.0028 },
};

function getPricing(model) {
  // Match prefix: "claude-sonnet-4-20250514" → "claude-sonnet-4"
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return price;
  }
  // Default: estimate based on model tier
  if (model.includes('opus')) return MODEL_PRICING['claude-opus-4.8'];
  if (model.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4.6'];
  if (model.includes('haiku')) return MODEL_PRICING['claude-haiku-4.5'];
  if (model.includes('fable')) return MODEL_PRICING['claude-fable-5'];
  if (model.includes('mythos')) return MODEL_PRICING['claude-mythos-5'];
  if (model.includes('deepseek')) return MODEL_PRICING['deepseek-v4-pro'];
  // Unknown: conservative default (claude-sonnet-4.6)
  return MODEL_PRICING['claude-sonnet-4.6'];
}

function calcCost(usage, model) {
  const p = getPricing(model);
  const inputCost      = (usage.input_tokens || 0) / 1_000_000 * p.input;
  const outputCost     = (usage.output_tokens || 0) / 1_000_000 * p.output;
  const cacheReadCost  = (usage.cache_read_input_tokens || 0) / 1_000_000 * (p.cache_hit || p.cache_read || 0);
  const cacheWriteCost = (usage.cache_creation_input_tokens || 0) / 1_000_000 * (p.cache_write || p.input);
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

export function ingestTranscript(transcriptPath, sessionId) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return; // transcript file not found/readable
  }

  const lines = raw.trim().split('\n');
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }

  const db = openDb();

  // Count user prompts (type=user, non-meta, with actual content)
  let promptCount = 0;
  for (const e of entries) {
    if (e.type === 'user' && !e.isMeta && e.message?.role === 'user') {
      const content = e.message.content;
      // Skip local-command-caveat and local-command-stdout wrappers
      if (typeof content === 'string' && !content.includes('<local-command') && !content.includes('<command-name>')) {
        promptCount++;
      } else if (Array.isArray(content) && content.some(c => c.type === 'text' && c.text)) {
        promptCount++;
      }
    }
  }

  // Extract unique API requests from assistant messages
  const seenMessageIds = new Set();
  const apiRequests = [];
  for (const e of entries) {
    if (e.type === 'assistant' && e.message?.usage && !seenMessageIds.has(e.message.id)) {
      seenMessageIds.add(e.message.id);
      apiRequests.push({
        message_id: e.message.id,
        model: e.message.model || 'unknown',
        usage: e.message.usage,
        timestamp: e.timestamp
      });
    }
  }

  // Aggregate token/cost data
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
  let totalCost = 0;
  const modelCounts = {};

  for (const req of apiRequests) {
    const u = req.usage;
    totalInput       += u.input_tokens || 0;
    totalOutput      += u.output_tokens || 0;
    totalCacheRead   += u.cache_read_input_tokens || 0;
    totalCacheCreate += u.cache_creation_input_tokens || 0;
    const cost = calcCost(u, req.model);
    totalCost += cost;
    modelCounts[req.model] = (modelCounts[req.model] || 0) + 1;
  }

  // Update session totals
  db.prepare('UPDATE sessions SET prompt_count=?, total_tokens=?, total_cost=? WHERE id=?')
    .run(promptCount, totalInput + totalOutput + totalCacheRead + totalCacheCreate, totalCost, sessionId);

  // Backfill individual prompt rows with aggregate token/cost data
  const avgTokens = promptCount > 0 ? Math.round((totalInput + totalOutput + totalCacheRead + totalCacheCreate) / promptCount) : 0;
  const avgCost = promptCount > 0 ? totalCost / promptCount : 0;
  const topModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  db.prepare('UPDATE prompts SET input_tokens=?, output_tokens=0, cache_tokens=0, cost_usd=?, model=? WHERE session_id=? AND cost_usd = 0')
    .run(avgTokens, avgCost, topModel, sessionId);

  // Update daily summary
  const session = db.prepare('SELECT project FROM sessions WHERE id=?').get(sessionId);
  if (session) {
    upsertDailySummary(todayISO(), session.project, {
      session_count: 1,
      prompt_count: promptCount,
      total_tokens: totalInput + totalOutput + totalCacheRead + totalCacheCreate,
      total_cost: totalCost,
      top_model: topModel
    });
  }

  return { promptCount, apiRequests: apiRequests.length, totalCost, totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheCreate };
}

// ── Takeover trace scanning (NDJSON contract, no code dependency) ─────────

import { TRACEME_DIR } from './lib.mjs';
import { join } from 'node:path';

const TAKEOVER_TRACES_FILE = join(TRACEME_DIR, 'takeover_traces.jsonl');

export function scanTakeoverTraces(date) {
  const traces = [];
  try {
    const raw = readFileSync(TAKEOVER_TRACES_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.ts && rec.ts.slice(0, 10) === date) traces.push(rec);
      } catch {}
    }
  } catch {
    return { traces: [], totalTokens: 0, totalInput: 0, totalOutput: 0, byProvider: {} };
  }

  let totalInput = 0, totalOutput = 0;
  const byProvider = {};

  for (const t of traces) {
    totalInput += t.input_tokens || 0;
    totalOutput += t.output_tokens || 0;
    const key = `${t.provider}/${t.model}`;
    if (!byProvider[key]) byProvider[key] = { provider: t.provider, model: t.model, input_tokens: 0, output_tokens: 0, count: 0 };
    byProvider[key].input_tokens += t.input_tokens || 0;
    byProvider[key].output_tokens += t.output_tokens || 0;
    byProvider[key].count++;
  }

  return {
    traces,
    totalTokens: totalInput + totalOutput,
    totalInput,
    totalOutput,
    byProvider: Object.values(byProvider),
  };
}
