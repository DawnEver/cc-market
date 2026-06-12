import { openDb, queryModelBreakdown, querySkillUsage } from '../db.mjs';
import { readMergedSnapshot } from '../sync.mjs';
import { todayISO, fmt, fmtCost, fmtDuration, daysArray } from '../lib.mjs';

export function cmdInsights(args, VERSION) {
  // ── flags ──
  const getFlag = (a, f) => { const i = a.indexOf(f); return (i >= 0 && a[i + 1] && !a[i + 1].startsWith('--')) ? a[i + 1] : null; };

  const dayFlag = args.includes('--day');
  const monthFlag = args.includes('--month');
  const daysVal = getFlag(args, '--days');
  const local = args.includes('--local');
  const project = getFlag(args, '--project');

  let numDays = 7;
  if (dayFlag) numDays = 1;
  else if (monthFlag) numDays = 30;
  else if (daysVal) numDays = parseInt(daysVal) || 7;

  const to = todayISO();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - numDays + 1);
  const from = fromDate.toISOString().slice(0, 10);
  const days = daysArray(from, to);

  const db = openDb();
  const lines = [];

  lines.push(`# TraceMe Insights — Last ${numDays} Day${numDays !== 1 ? 's' : ''}`);
  lines.push('');
  lines.push(`_${from} to ${to}_`);
  if (project) lines.push(`_Filtered by project: "${project}"_`);
  lines.push('');

  const projectSearch = project ? project.toLowerCase() : null;
  const projectLike = projectSearch ? `%${projectSearch}%` : null;

  // ═══════════════════════════════════════════════
  // TOKEN CONSUMPTION (merged data per day)
  // ═══════════════════════════════════════════════
  const tokenByDay = {};       // date → { project → { tokens, cost, sessions, prompts } }
  const projectTokenTotals = {};
  const allProjects = new Set();
  let grandTokens = 0, grandCost = 0, grandSessions = 0, grandPrompts = 0, daysWithData = 0;

  for (const day of days) {
    const merged = local ? null : readMergedSnapshot(day);
    let rows;
    if (merged) {
      rows = merged.daily_summary.map(r => ({
        project: r.project, sessions: r.session_count, prompts: r.prompt_count,
        tokens: r.billable_tokens ?? r.total_tokens, cost: r.total_cost,
      }));
    } else {
      rows = db.prepare(`
        SELECT project, COUNT(*) as sessions, COALESCE(SUM(prompt_count),0) as prompts,
               COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens),0) as tokens,
               COALESCE(SUM(total_cost),0) as cost
        FROM sessions
        WHERE date = ?
        GROUP BY repo_origin
      `).all(day);
    }

    if (projectSearch) rows = rows.filter(r => r.project.toLowerCase().includes(projectSearch));
    if (rows.length === 0) continue;

    daysWithData++;
    tokenByDay[day] = {};
    for (const r of rows) {
      tokenByDay[day][r.project] = r;
      allProjects.add(r.project);
      if (!projectTokenTotals[r.project]) projectTokenTotals[r.project] = { sessions: 0, prompts: 0, tokens: 0, cost: 0 };
      projectTokenTotals[r.project].sessions += r.sessions;
      projectTokenTotals[r.project].prompts += r.prompts;
      projectTokenTotals[r.project].tokens += r.tokens;
      projectTokenTotals[r.project].cost += r.cost;
      grandTokens += r.tokens; grandCost += r.cost; grandSessions += r.sessions; grandPrompts += r.prompts;
    }
  }

  const projList = [...allProjects].sort((a, b) => (projectTokenTotals[b]?.tokens || 0) - (projectTokenTotals[a]?.tokens || 0));

  // ═══════════════════════════════════════════════
  // TIME CONSUMPTION (local sessions table)
  // ═══════════════════════════════════════════════
  const timeQuery = projectLike
    ? `SELECT s.project, s.started_at, s.ended_at, s.active_min, s.prompt_count
       FROM sessions s
       WHERE s.date >= ? AND s.date <= ?
         AND s.project LIKE ?`
    : `SELECT s.project, s.started_at, s.ended_at, s.active_min, s.prompt_count
       FROM sessions s
       WHERE s.date >= ? AND s.date <= ?`;

  const sessRows = projectLike
    ? db.prepare(timeQuery).all(from, to, projectLike)
    : db.prepare(timeQuery).all(from, to);

  const now = new Date();
  const timeByProject = {};
  let grandDuration = 0, grandActive = 0;
  let zombieCount = 0;

  for (const s of sessRows) {
    const start = new Date(s.started_at);
    const end = s.ended_at ? new Date(s.ended_at) : now;
    let durMin = Math.round((end - start) / 60000);

    // zombie filter
    if (s.prompt_count === 0 && !s.ended_at && durMin > 240) { zombieCount++; continue; }
    if (!s.ended_at && durMin > 240) durMin = 240;

    if (!timeByProject[s.project]) timeByProject[s.project] = { sessions: 0, totalMin: 0, activeMin: 0, countWithEnd: 0, sumWithEnd: 0 };
    timeByProject[s.project].sessions++;
    timeByProject[s.project].totalMin += durMin;
    timeByProject[s.project].activeMin += s.active_min || 0;
    if (s.ended_at) { timeByProject[s.project].countWithEnd++; timeByProject[s.project].sumWithEnd += durMin; }
    grandDuration += durMin;
    grandActive += s.active_min || 0;
  }

  // ═══════════════════════════════════════════════
  // SKILL USAGE (local session_skills table)
  // ═══════════════════════════════════════════════
  const skillRows = querySkillUsage(from, to, projectLike);

  const skillAgg = {};
  let totalSkillCalls = 0;
  for (const r of skillRows) {
    const name = r.skill_name;
    if (!name) continue;
    totalSkillCalls += r.count;
    if (!skillAgg[name]) skillAgg[name] = { total: 0, projects: {} };
    skillAgg[name].total += r.count;
    skillAgg[name].projects[r.project] = (skillAgg[name].projects[r.project] || 0) + r.count;
  }

  // ═══════════════════════════════════════════════
  // MODEL USAGE (local)
  // ═══════════════════════════════════════════════
  const modelAgg = {};
  for (const day of days) {
    for (const m of queryModelBreakdown(day)) {
      if (!modelAgg[m.model]) modelAgg[m.model] = { calls: 0, tokens: 0, cost: 0 };
      modelAgg[m.model].calls += m.calls;
      modelAgg[m.model].tokens += m.tokens;
      modelAgg[m.model].cost += m.cost;
    }
  }

  // ═══════════════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════════════

  // Quick Stats
  lines.push('## Quick Stats');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Days with data | ${daysWithData}/${days.length} |`);
  lines.push(`| Projects | ${projList.length} |`);
  lines.push(`| Total sessions | ${grandSessions} |`);
  lines.push(`| Total prompts | ${grandPrompts} |`);
  lines.push(`| Total tokens | ${fmt(grandTokens)} |`);
  lines.push(`| Total cost | **${fmtCost(grandCost)}** |`);
  lines.push(`| Active time (gaps <10min) | ${fmtDuration(grandActive)} |`);
  lines.push(`| Elapsed session time | ${fmtDuration(grandDuration)} |`);
  lines.push(`| Skills used | ${Object.keys(skillAgg).length} |`);
  lines.push(`| Total skill calls | ${totalSkillCalls} |`);
  lines.push('');

  if (projList.length === 0) {
    lines.push('_No token data for this period._');
    lines.push('');
  } else {

  // Token Consumption by Project (per day)
  lines.push('## Token Consumption by Project');
  lines.push('');
  const header = '| Date | ' + projList.map(p => p.length > 14 ? p.slice(0, 12) + '..' : p).join(' | ') + ' | Daily Total |';
  const sep = '|------|' + projList.map(() => '------|').join('') + '------|';
  lines.push(header);
  lines.push(sep);

  for (const day of days) {
    if (!tokenByDay[day]) continue;
    const cells = projList.map(p => tokenByDay[day][p] ? fmt(tokenByDay[day][p].tokens) : '-');
    const dayTotal = projList.reduce((s, p) => s + (tokenByDay[day][p]?.tokens || 0), 0);
    lines.push(`| ${day} | ${cells.join(' | ')} | ${fmt(dayTotal)} |`);
  }

  // total row
  const totalCells = projList.map(p => fmt(projectTokenTotals[p]?.tokens || 0));
  lines.push(`| **Total** | ${totalCells.join(' | ')} | **${fmt(grandTokens)}** |`);
  lines.push('');

  // Time Consumption
  lines.push('## Time Consumption by Project');
  if (zombieCount > 0) lines.push(`_${zombieCount} zombie session(s) filtered (>4h, no prompts, no end)_`);
  lines.push('');
  lines.push('| Project | Sessions | Active | Elapsed | Avg Elapsed |');
  lines.push('|---------|----------|--------|---------|-------------|');
  for (const proj of [...projList].sort((a, b) => (timeByProject[b]?.activeMin || 0) - (timeByProject[a]?.activeMin || 0))) {
    const t = timeByProject[proj];
    if (!t) continue;
    const avg = t.countWithEnd > 0 ? fmtDuration(Math.round(t.sumWithEnd / t.countWithEnd)) : 'N/A';
    lines.push(`| ${proj} | ${t.sessions} | ${fmtDuration(t.activeMin)} | ${fmtDuration(t.totalMin)} | ${avg} |`);
  }
  lines.push('');

  // Skill Rankings
  if (Object.keys(skillAgg).length > 0) {
    lines.push('## Skill Usage Rankings');
    lines.push('');
    const skillSorted = Object.entries(skillAgg).sort((a, b) => b[1].total - a[1].total);
    const maxCount = skillSorted[0][1].total;
    for (const [name, agg] of skillSorted) {
      const pct = (agg.total / totalSkillCalls * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(agg.total / maxCount * 15));
      lines.push(`| ${name} | ${agg.total} | ${pct}% | ${bar} |`);
    }
    lines.push('');

    // per-project breakdown (only if >1 project)
    const skillProjects = new Set();
    for (const [, agg] of skillSorted) for (const p of Object.keys(agg.projects)) skillProjects.add(p);
    if (skillProjects.size > 1) {
      lines.push('### Skill Usage by Project');
      lines.push('');
      const spList = [...skillProjects];
      const skillHeader = '| Skill | ' + spList.map(p => p.length > 14 ? p.slice(0, 12) + '..' : p).join(' | ') + ' |';
      const skillSep = '|-------|' + spList.map(() => '------|').join('') + '';
      lines.push(skillHeader);
      lines.push(skillSep);
      for (const [name, agg] of skillSorted) {
        const cells = spList.map(p => agg.projects[p] ? String(agg.projects[p]) : '-');
        lines.push(`| ${name} | ${cells.join(' | ')} |`);
      }
      lines.push('');
    }
  }

  // Model Usage
  if (Object.keys(modelAgg).length > 0) {
    lines.push('## Model Usage');
    lines.push('');
    lines.push('_Local device only — model data not synced_');
    lines.push('');
    lines.push('| Model | Calls | Tokens | Cost |');
    lines.push('|-------|-------|--------|------|');
    for (const [model, m] of Object.entries(modelAgg).sort((a, b) => b[1].cost - a[1].cost)) {
      lines.push(`| ${model} | ${m.calls} | ${fmt(m.tokens)} | ${fmtCost(m.cost)} |`);
    }
    lines.push('');
  }

  } // end else (projList.length > 0)

  lines.push('---');
  lines.push(`TraceMe ${VERSION}`);
  console.log(lines.join('\n'));
}
