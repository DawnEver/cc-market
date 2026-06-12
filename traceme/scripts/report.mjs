import { openDb, queryToolUsage, queryModelBreakdown, querySessionStats, queryDbStats } from './db.mjs';
import { readMergedSnapshot, isSyncSetup } from './sync.mjs';
import { todayISO } from './lib.mjs';

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n) {
  return '$' + n.toFixed(4);
}

function summarizeProjectRows(rows) {
  let sessions = 0, prompts = 0, tokens = 0, cost = 0;
  for (const r of rows) {
    sessions += r.sessions;
    prompts += r.prompts;
    tokens += r.tokens;
    cost += r.cost;
  }
  return { sessions, prompts, tokens, cost };
}

function normalizeProjectRow(row, isMerged) {
  // `tokens` is the billable basis; merged snapshots fall back to total_tokens when an older
  // device hasn't re-pushed the billable field yet.
  return isMerged
    ? { project: row.project, repo_origin: row.repo_origin, sessions: row.session_count, prompts: row.prompt_count, tokens: row.billable_tokens ?? row.total_tokens, cost: row.total_cost }
    : { project: row.project, repo_origin: row.repo_origin, sessions: row.sessions, prompts: row.prompts, tokens: row.tokens, cost: row.cost };
}

function resolveMerged(date, opts) {
  if ('mergedSnapshot' in opts) return opts.mergedSnapshot;
  if (opts.local) return null;
  return readMergedSnapshot(date);
}

function filterByProject(rows, project) {
  if (!project) return rows;
  const lower = project.toLowerCase();
  return rows.filter(r => r.project.toLowerCase().includes(lower));
}

export function generateReport(date, opts = {}) {
  openDb();
  const lines = [];

  const merged = resolveMerged(date, opts);
  let projectRows = merged
    ? merged.daily_summary.map(r => normalizeProjectRow(r, true))
    : querySessionStats(date).map(r => normalizeProjectRow(r, false));

  projectRows = filterByProject(projectRows, opts.project);

  const toolUsage = merged ? merged.tool_usage : queryToolUsage(date);

  // --- JSON output ---
  if (opts.json) {
    const modelBreakdown = queryModelBreakdown(date);
    const dbStats = queryDbStats();
    const { sessions: totalSessions, prompts: totalPrompts, tokens: totalTokens, cost: totalCost } = summarizeProjectRows(projectRows);
    return JSON.stringify({
      date,
      source: merged ? 'merged' : 'local',
      devices: merged ? merged.devices : null,
      aggregated_at: merged ? merged.aggregated_at : null,
      overview: { sessions: totalSessions, prompts: totalPrompts, tokens: totalTokens, cost: totalCost, tools: toolUsage.reduce((s, r) => s + r.count, 0) },
      projects: projectRows,
      model_breakdown: modelBreakdown,
      tool_usage: toolUsage,
      db_stats: dbStats,
    }, null, 2);
  }

  lines.push(`# TraceMe Report — ${date}`);
  lines.push('');

  // --- Brief mode: compact summary (always renders, even with no data) ---
  if (opts.brief) {
    const { sessions: totalSessions, tokens: totalTokens, cost: totalCost } = summarizeProjectRows(projectRows);
    const sourceLabel = merged ? `cross-device (${merged.devices.length} device(s): ${merged.devices.join(', ')})` : 'local only';
    lines.length = 0; // reset
    lines.push(`TraceMe Stats`);
    lines.push(`  Today (${sourceLabel}): ${projectRows.length} projects, ${totalSessions} sessions`);
    lines.push(`  Tokens today: ${fmt(totalTokens)} | Cost today: ${fmtCost(totalCost)}`);
    const dbStats = queryDbStats();
    lines.push(`  All time: ${dbStats.sessions} sessions, ${dbStats.prompts} prompts, ${dbStats.tool_calls} tool calls`);
    if (isSyncSetup() && !merged && !opts.local) {
      lines.push('  Sync: configured but no cross-device data for today — run `traceme sync pull` to fetch');
    }
    return lines.join('\n');
  }

  if (projectRows.length === 0) {
    lines.push('_No data for this date._');
    return lines.join('\n');
  }

  if (merged) {
    lines.push(`_Aggregated across ${merged.devices.length} device(s): ${merged.devices.join(', ')} (as of ${merged.aggregated_at})_`);
    if (merged.fetched_at) {
      const ageMs = Date.now() - new Date(merged.fetched_at).getTime();
      if (ageMs > 86400000) {
        const days = Math.floor(ageMs / 86400000);
        lines.push(`> **Warning:** Merged data is ${days} day(s) old (last fetched ${merged.fetched_at}). Run \`traceme sync pull\` to refresh.`);
      }
    }
  } else {
    lines.push('_Local-only (no cross-device aggregate available for this date)_');
  }
  if (opts.project) lines.push(`_Filtered by project: "${opts.project}"_`);
  lines.push('');

  // --- Full report ---
  const { sessions: totalSessions, prompts: totalPrompts, tokens: totalTokens, cost: totalCost } = summarizeProjectRows(projectRows);

  lines.push('## Overview');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Sessions | ${totalSessions} |`);
  lines.push(`| Prompts  | ${totalPrompts} |`);
  lines.push(`| Tokens   | ${fmt(totalTokens)} |`);
  lines.push(`| Cost     | **${fmtCost(totalCost)}** |`);
  lines.push(`| Tools    | ${toolUsage.reduce((s, r) => s + r.count, 0)} |`);
  lines.push('');

  lines.push('## Projects');
  lines.push('');
  lines.push('| Project | Sessions | Prompts | Tokens | Cost |');
  lines.push('|---------|----------|---------|--------|------|');
  for (const r of projectRows) {
    lines.push(`| ${r.project} | ${r.sessions} | ${r.prompts} | ${fmt(r.tokens)} | ${fmtCost(r.cost)} |`);
  }
  lines.push(`| **Total** | **${totalSessions}** | **${totalPrompts}** | **${fmt(totalTokens)}** | **${fmtCost(totalCost)}** |`);
  lines.push('');

  const modelBreakdown = queryModelBreakdown(date);
  if (modelBreakdown.length > 0) {
    lines.push('## Cost by Model');
    if (merged) {
      lines.push('');
      lines.push('_Local device only — model data not synced_');
    }
    lines.push('');
    lines.push('| Model | Calls | Tokens | Cost |');
    lines.push('|-------|-------|--------|------|');
    for (const m of modelBreakdown) {
      lines.push(`| ${m.model} | ${m.calls} | ${fmt(m.tokens)} | ${fmtCost(m.cost)} |`);
    }
    lines.push('');
  }

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

  const dbStats = queryDbStats();
  lines.push('---');
  lines.push(`_Local DB: ${dbStats.sessions} sessions, ${dbStats.prompts} prompts, ${dbStats.tool_calls} tool calls_`);
  lines.push('');

  return lines.join('\n');
}

// Multi-day report: iterate over each day in range, produce a merged summary
export function generateRangeReport(opts = {}) {
  openDb();
  const lines = [];
  const from = opts.from || todayISO();
  const to = opts.to || todayISO();

  lines.push(`# TraceMe Report — ${from} to ${to}`);
  if (opts.project) lines.push(`_Filtered by project: "${opts.project}"_`);
  lines.push('');

  // Collect all days in range
  const days = [];
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }

  // Aggregate daily_summary and tool_usage across the range
  const aggregated = {}; // key → { project, sessions, prompts, tokens, cost }
  const toolAgg = {};
  const modelAgg = {};    // model → { calls, tokens, cost }
  const dailyTrend = [];  // { date, sessions, tokens, cost }
  let totalSessions = 0, totalPrompts = 0, totalTokens = 0, totalCost = 0;
  let daysWithData = 0;

  for (const day of days) {
    const merged = resolveMerged(day, opts);
    const rows = merged
      ? merged.daily_summary.map(r => normalizeProjectRow(r, true))
      : querySessionStats(day).map(r => normalizeProjectRow(r, false));

    const filtered = filterByProject(rows, opts.project);
    if (filtered.length === 0) continue;
    daysWithData++;

    const daySummary = summarizeProjectRows(filtered);
    dailyTrend.push({ date: day, ...daySummary });

    for (const r of filtered) {
      const key = r.project || r.repo_origin;
      if (!aggregated[key]) {
        aggregated[key] = { project: r.project, sessions: 0, prompts: 0, tokens: 0, cost: 0 };
      }
      aggregated[key].sessions += r.sessions;
      aggregated[key].prompts += r.prompts;
      aggregated[key].tokens += r.tokens;
      aggregated[key].cost += r.cost;
    }

    const tools = merged ? merged.tool_usage : queryToolUsage(day);
    for (const t of tools) {
      toolAgg[t.tool_name] = (toolAgg[t.tool_name] || 0) + t.count;
    }

    for (const m of queryModelBreakdown(day)) {
      if (!modelAgg[m.model]) modelAgg[m.model] = { calls: 0, tokens: 0, cost: 0 };
      modelAgg[m.model].calls += m.calls;
      modelAgg[m.model].tokens += m.tokens;
      modelAgg[m.model].cost += m.cost;
    }
  }

  const projectList = Object.values(aggregated);
  for (const r of projectList) {
    totalSessions += r.sessions;
    totalPrompts += r.prompts;
    totalTokens += r.tokens;
    totalCost += r.cost;
  }

  if (opts.json) {
    return JSON.stringify({
      date_range: { from, to },
      source: 'local',
      overview: { sessions: totalSessions, prompts: totalPrompts, tokens: totalTokens, cost: totalCost },
      projects: projectList,
      daily_trend: dailyTrend,
      model_breakdown: Object.entries(modelAgg).map(([model, m]) => ({ model, ...m })),
      tool_usage: Object.entries(toolAgg).map(([tool_name, count]) => ({ tool_name, count })),
      db_stats: queryDbStats(),
    }, null, 2);
  }

  if (opts.brief) {
    lines.push(`  Days with data: ${daysWithData}/${days.length}`);
    lines.push(`  Projects: ${projectList.length} | Sessions: ${totalSessions} | Prompts: ${totalPrompts}`);
    lines.push(`  Tokens: ${fmt(totalTokens)} | Cost: ${fmtCost(totalCost)}`);
    return lines.join('\n');
  }

  if (projectList.length === 0) {
    lines.push('_No data for this date range._');
    return lines.join('\n');
  }

  lines.push(`## Overview`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Days with data | ${daysWithData}/${days.length} |`);
  lines.push(`| Sessions | ${totalSessions} |`);
  lines.push(`| Prompts  | ${totalPrompts} |`);
  lines.push(`| Tokens   | ${fmt(totalTokens)} |`);
  lines.push(`| Cost     | **${fmtCost(totalCost)}** |`);
  lines.push('');

  if (dailyTrend.length > 1) {
    lines.push('## Daily Trend');
    lines.push('');
    lines.push('| Date | Sessions | Tokens | Cost |');
    lines.push('|------|----------|--------|------|');
    for (const dt of dailyTrend) {
      lines.push(`| ${dt.date} | ${dt.sessions} | ${fmt(dt.tokens)} | ${fmtCost(dt.cost)} |`);
    }
    lines.push('');
  }

  lines.push('## Projects');
  lines.push('');
  lines.push('| Project | Sessions | Prompts | Tokens | Cost |');
  lines.push('|---------|----------|---------|--------|------|');
  projectList.sort((a, b) => b.cost - a.cost);
  for (const r of projectList) {
    lines.push(`| ${r.project} | ${r.sessions} | ${r.prompts} | ${fmt(r.tokens)} | ${fmtCost(r.cost)} |`);
  }
  lines.push(`| **Total** | **${totalSessions}** | **${totalPrompts}** | **${fmt(totalTokens)}** | **${fmtCost(totalCost)}** |`);
  lines.push('');

  if (Object.keys(modelAgg).length > 0) {
    lines.push('## Cost by Model');
    lines.push('');
    lines.push('_Local device only — model data not synced_');
    lines.push('');
    lines.push('| Model | Calls | Tokens | Cost |');
    lines.push('|-------|-------|--------|------|');
    const sortedModels = Object.entries(modelAgg).sort((a, b) => b[1].cost - a[1].cost);
    for (const [model, m] of sortedModels) {
      lines.push(`| ${model} | ${m.calls} | ${fmt(m.tokens)} | ${fmtCost(m.cost)} |`);
    }
    lines.push('');
  }

  if (Object.keys(toolAgg).length > 0) {
    lines.push('## Tool Usage');
    lines.push('');
    lines.push('| Tool | Count |');
    lines.push('|------|-------|');
    const sortedTools = Object.entries(toolAgg).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sortedTools) {
      lines.push(`| ${name} | ${count} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function generateStats(opts = {}) {
  return generateReport(todayISO(), { ...opts, brief: true });
}
