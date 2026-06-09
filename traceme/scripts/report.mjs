import { openDb, queryDailySummary, queryTopPrompts, queryToolUsage, querySkillUsage, querySessionStats, queryDbStats } from './db.mjs';

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

export function generateReport(date) {
  const db = openDb();
  const lines = [];

  lines.push(`# TraceMe Report — ${date}`);
  lines.push('');

  const summary = queryDailySummary(date);
  const stats = querySessionStats(date);
  const topPrompts = queryTopPrompts(date, 10);
  const toolUsage = queryToolUsage(date);
  const skillUsage = querySkillUsage(date);

  if (stats.length === 0) {
    lines.push('_No data for this date._');
    return lines.join('\n');
  }

  // ── Global Totals ──
  const totalSessions = stats.reduce((s, r) => s + r.sessions, 0);
  const totalPrompts  = stats.reduce((s, r) => s + r.prompts, 0);
  const totalTokens   = stats.reduce((s, r) => s + r.tokens, 0);
  const totalCost     = stats.reduce((s, r) => s + r.cost, 0);

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
  for (const r of stats) {
    lines.push(`| ${r.project} | ${r.sessions} | ${r.prompts} | ${fmt(r.tokens)} | ${fmtCost(r.cost)} |`);
  }
  lines.push(`| **Total** | **${totalSessions}** | **${totalPrompts}** | **${fmt(totalTokens)}** | **${fmtCost(totalCost)}** |`);
  lines.push('');

  // ── Top Expensive Prompts ──
  if (topPrompts.length > 0) {
    lines.push('## Top Expensive Prompts');
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

  // ── Database Stats (for debugging) ──
  const dbStats = queryDbStats();
  lines.push('---');
  lines.push(`_DB: ${dbStats.sessions} sessions, ${dbStats.prompts} prompts, ${dbStats.tool_calls} tool calls, ${dbStats.skill_calls} skill calls_`);
  lines.push('');

  return lines.join('\n');
}

export function generateStats() {
  const db = openDb();
  const dbStats = queryDbStats();
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = querySessionStats(today);
  const totalCost = todayStats.reduce((s, r) => s + r.cost, 0);
  const totalTokens = todayStats.reduce((s, r) => s + r.tokens, 0);

  const lines = [];
  lines.push(`TraceMe Stats`);
  lines.push(`  Today: ${todayStats.length} projects, ${todayStats.reduce((s, r) => s + r.sessions, 0)} sessions`);
  lines.push(`  Tokens today: ${fmt(totalTokens)} | Cost today: ${fmtCost(totalCost)}`);
  lines.push(`  All time: ${dbStats.sessions} sessions, ${dbStats.prompts} prompts, ${dbStats.tool_calls} tool calls`);
  return lines.join('\n');
}
