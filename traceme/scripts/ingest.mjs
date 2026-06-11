import { readFileSync } from 'node:fs';
import { openDb, upsertDailySummary } from './db.mjs';
import { todayISO } from './lib.mjs';
import { calcCost } from './pricing.mjs';

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

  // Backfill per-prompt durations from consecutive timestamp deltas
  const promptRows = db.prepare('SELECT id, timestamp, turn_index FROM prompts WHERE session_id=? ORDER BY turn_index').all(sessionId);
  const durationStmt = db.prepare('UPDATE prompts SET duration_ms=? WHERE id=?');
  for (let i = 0; i < promptRows.length; i++) {
    const start = new Date(promptRows[i].timestamp).getTime();
    const end = i + 1 < promptRows.length
      ? new Date(promptRows[i + 1].timestamp).getTime()
      : Date.now();
    durationStmt.run(Math.max(0, end - start), promptRows[i].id);
  }

  // Update daily summary
  const session = db.prepare('SELECT project, repo_origin FROM sessions WHERE id=?').get(sessionId);
  if (session) {
    upsertDailySummary(todayISO(), session.project, {
      session_count: 1,
      prompt_count: promptCount,
      total_tokens: totalInput + totalOutput + totalCacheRead + totalCacheCreate,
      total_cost: totalCost,
      top_model: topModel,
      repo_origin: session.repo_origin
    });
  }

  return { promptCount, apiRequests: apiRequests.length, totalCost, totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheCreate };
}

// --- Takeover trace scanning (NDJSON contract, no code dependency) ---

import { TRACEME_DIR } from './lib.mjs';
import { join } from 'node:path';

const TAKEOVER_TRACES_FILE = join(TRACEME_DIR, 'takeover_traces.jsonl');

export function scanTakeoverTraces(date, since = null) {
  const traces = [];
  let maxTs = since || null;
  try {
    const raw = readFileSync(TAKEOVER_TRACES_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.ts && rec.ts.slice(0, 10) === date) {
          if (since && rec.ts <= since) continue;
          traces.push(rec);
          if (!maxTs || rec.ts > maxTs) maxTs = rec.ts;
        }
      } catch {}
    }
  } catch {
    return { traces: [], totalTokens: 0, totalInput: 0, totalOutput: 0, byProvider: {}, maxTs };
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
    maxTs,
  };
}
