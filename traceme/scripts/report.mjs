import { openDb, queryTopPrompts, queryToolUsage, querySkillUsage, querySessionStats, queryDbStats } from './db.mjs';
import { readMergedSnapshot } from './sync.mjs';
import { todayISO } from './lib.mjs';

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n) {
  return '$' + n.toFixed(4);
}

function truncate(str, len = 60) {
  if (!str) return '(none)';
  // Remove newlines and extra whitespace
  const cleaned = str.replace(/\s+/g, ' ').trim();
  return cleaned.length > len ? cleaned.slice(0, len) + '...' : cleaned;
}

// Normalize a project row to {project, sessions, prompts, tokens, cost} regardless
// of whether it came from querySessionStats (local) or merged.daily_summary (cross-device).
function normalizeProjectRow(row, isMerged) {
  return isMerged
    ? { project: row.project, sessions: row.session_count, prompts: row.prompt_count, tokens: row.total_tokens, cost: row.total_cost }
    : { project: row.project, sessions: row.sessions, prompts: row.prompts, tokens: row.tokens, cost: row.cost };
}

// Resolve the merged cross-device snapshot for a date, honoring opts:
// - opts.mergedSnapshot explicitly provided (incl. null) → used as-is (mainly for tests)
// - otherwise → readMergedSnapshot(date), unless opts.localOnly
function resolveMerged(date, opts) {
  if ('mergedSnapshot' in opts) return opts.mergedSnapshot;
  if (opts.localOnly) return null;
  return readMergedSnapshot(date);
}

export function generateReport(date, opts = {}) {
  openDb();
  const lines = [];

  lines.push(`# TraceMe Report — ${date}`);
  lines.push('');

  const merged = resolveMerged(date, opts);
  const projectRows = merged
    ? merged.daily_summary.map(r => normalizeProjectRow(r, true))
    : querySessionStats(date).map(r => normalizeProjectRow(r, false));
  const topPrompts = queryTopPrompts(date, 10);
  const toolUsage = merged ? merged.tool_usage : queryToolUsage(date);
  const skillUsage = merged ? merged.skill_usage : querySkillUsage(date);

  if (projectRows.length === 0) {
    lines.push('_No data for this date._');
    return lines.join('\n');
  }

  if (merged) {
    lines.push(`_Aggregated across ${merged.devices.length} device(s): ${merged.devices.join(', ')} (as of ${merged.aggregated_at})_`);
  } else {
    lines.push('_Local-only (no cross-device aggregate available for this date)_');
  }
  lines.push('');

  // ── Global Totals ──
  const totalSessions = projectRows.reduce((s, r) => s + r.sessions, 0);
  const totalPrompts  = projectRows.reduce((s, r) => s + r.prompts, 0);
  const totalTokens   = projectRows.reduce((s, r) => s + r.tokens, 0);
  const totalCost     = projectRows.reduce((s, r) => s + r.cost, 0);

  lines.push('## Overview');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Sessions | ${totalSessions} |`);
  lines.push(`| Prompts  | ${totalPrompts} |`);
  lines.push(`| Tokens   | ${fmt(totalTokens)} |`);
  lines.push(`| Cost     | **${fmtCost(totalCost)}** |`);
  lines.push(`| Tools    | ${toolUsage.reduce((s, r) => s + r.count, 0)} |`);
  lines.push(`| Skills   | ${skillUsage.reduce((s, r) => s + r.count, 0)} |`);
  lines.push('');

  // ── Per-Project ──
  lines.push('## Projects');
  lines.push('');
  lines.push('| Project | Sessions | Prompts | Tokens | Cost |');
  lines.push('|---------|----------|---------|--------|------|');
  for (const r of projectRows) {
    lines.push(`| ${r.project} | ${r.sessions} | ${r.prompts} | ${fmt(r.tokens)} | ${fmtCost(r.cost)} |`);
  }
  lines.push(`| **Total** | **${totalSessions}** | **${totalPrompts}** | **${fmt(totalTokens)}** | **${fmtCost(totalCost)}** |`);
  lines.push('');

  // ── Top Expensive Prompts (always local — prompt text is never synced) ──
  if (topPrompts.length > 0) {
    lines.push('## Top Expensive Prompts');
    lines.push('');
    lines.push('_Local device only — prompt text not synced_');
    lines.push('');
    lines.push('| # | Project | Prompt | Tokens | Cost |');
    lines.push('|---|---------|--------|--------|------|');
    topPrompts.forEach((p, i) => {
      lines.push(`| ${i + 1} | ${p.project || '-'} | ${truncate(p.text)} | ${fmt(p.input_tokens + p.output_tokens + (p.cache_tokens || 0))} | ${fmtCost(p.cost_usd)} |`);
    });
    lines.push('');
  }

  // ── Tool Usage ──
  if (toolUsage.length > 0) {
    lines.push('## Tool Usage');
    lines.push('');
    lines.push('| Tool | Count |');
    lines.push('|------|-------|');
    for (const t of toolUsage) {
      lines.push(`| ${t.tool_name} | ${t.count} |`);
    }
    lines.push('');
  }

  // ── Skill Usage ──
  if (skillUsage.length > 0) {
    lines.push('## Skills');
    lines.push('');
    lines.push('| Skill | Count |');
    lines.push('|-------|-------|');
    for (const s of skillUsage) {
      lines.push(`| ${s.skill_name} | ${s.count} |`);
    }
    lines.push('');
  }

  // ── Database Stats (local DB, for debugging) ──
  const dbStats = queryDbStats();
  lines.push('---');
  lines.push(`_Local DB: ${dbStats.sessions} sessions, ${dbStats.prompts} prompts, ${dbStats.tool_calls} tool calls, ${dbStats.skill_calls} skill calls_`);
  lines.push('');

  return lines.join('\n');
}

export function generateStats(opts = {}) {
  openDb();
  const dbStats = queryDbStats();
  const today = todayISO();

  const merged = resolveMerged(today, opts);
  const todayRows = merged
    ? merged.daily_summary.map(r => normalizeProjectRow(r, true))
    : querySessionStats(today).map(r => normalizeProjectRow(r, false));
  const totalCost = todayRows.reduce((s, r) => s + r.cost, 0);
  const totalTokens = todayRows.reduce((s, r) => s + r.tokens, 0);
  const totalSessions = todayRows.reduce((s, r) => s + r.sessions, 0);

  const lines = [];
  lines.push(`TraceMe Stats`);
  if (merged) {
    lines.push(`  Today (${merged.devices.length} device(s): ${merged.devices.join(', ')}): ${todayRows.length} projects, ${totalSessions} sessions`);
  } else {
    lines.push(`  Today (local only): ${todayRows.length} projects, ${totalSessions} sessions`);
  }
  lines.push(`  Tokens today: ${fmt(totalTokens)} | Cost today: ${fmtCost(totalCost)}`);
  lines.push(`  All time: ${dbStats.sessions} sessions, ${dbStats.prompts} prompts, ${dbStats.tool_calls} tool calls`);
  return lines.join('\n');
}
