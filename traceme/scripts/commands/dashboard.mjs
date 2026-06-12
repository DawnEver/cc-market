import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  openDb, queryModelBreakdown, querySkillUsage,
  queryCategoryBreakdown, queryModelByDay, queryDailyTokens,
} from '../db.mjs';
import { scanAll } from '../scan.mjs';
import { todayISO, getDbPath, fmt, fmtCost, fmtDuration, daysArray } from '../lib.mjs';

const CAT_LABELS = { subagent: 'Subagents', mcp: 'MCPs', plugin: 'Plugins', builtin: 'Built-in tools' };
const CAT_COLORS = { subagent: '#7c5cff', mcp: '#1f9d6b', plugin: '#e0883a', builtin: '#5a8dd6' };
// Deterministic palette for model bands (no Math.random in this runtime).
const MODEL_PALETTE = ['#7c5cff', '#1f9d6b', '#e0883a', '#d6505a', '#5a8dd6', '#c45ec4', '#3ab0c0', '#9aa05a'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── SVG charts (hand-rolled, zero-dep, offline) ──

function calendarHeatmapSVG(dailyTokens, days) {
  const byDate = {};
  for (const r of dailyTokens) byDate[r.date] = r;
  const max = dailyTokens.reduce((m, r) => Math.max(m, r.tokens), 0) || 1;
  const cell = 14, gap = 3, pad = 24;
  // Align the grid so each column is a Sun→Sat week.
  const first = new Date(days[0] + 'T00:00:00');
  const startOffset = first.getDay(); // 0=Sun
  const total = startOffset + days.length;
  const weeks = Math.ceil(total / 7);
  const w = pad + weeks * (cell + gap) + pad;
  const h = pad + 7 * (cell + gap) + pad;
  const rects = [];
  days.forEach((date, i) => {
    const idx = startOffset + i;
    const col = Math.floor(idx / 7), row = idx % 7;
    const r = byDate[date];
    const t = r ? r.tokens : 0;
    const intensity = t > 0 ? 0.15 + 0.85 * (t / max) : 0;
    const fill = t > 0 ? `rgba(124,92,255,${intensity.toFixed(3)})` : '#23262e';
    const x = pad + col * (cell + gap), y = pad + row * (cell + gap);
    const tip = `${date}: ${fmt(t)} tokens${r ? ' · ' + fmtCost(r.cost) : ''}`;
    rects.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${fill}"><title>${esc(tip)}</title></rect>`);
  });
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const labels = dow.map((d, row) =>
    row % 2 === 1 ? `<text x="2" y="${pad + row * (cell + gap) + cell - 2}" class="cal-lbl">${d}</text>` : '').join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">${labels}${rects.join('')}</svg>`;
}

function stackedLineSVG(modelByDay, days) {
  const models = [...new Set(modelByDay.map(r => r.model))];
  const colorOf = m => MODEL_PALETTE[models.indexOf(m) % MODEL_PALETTE.length];
  const byDate = {};
  for (const d of days) byDate[d] = {};
  for (const r of modelByDay) { (byDate[r.date] ||= {})[r.model] = r.tokens; }
  const totals = days.map(d => models.reduce((s, m) => s + (byDate[d]?.[m] || 0), 0));
  const max = Math.max(1, ...totals);
  const W = 720, H = 240, padL = 48, padB = 28, padT = 12, padR = 12;
  const plotW = W - padL - padR, plotH = H - padB - padT;
  const x = i => padL + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = v => padT + plotH - (v / max) * plotH;
  // Stacked areas, model by model.
  const cum = days.map(() => 0);
  const areas = models.map(m => {
    const lower = cum.slice();
    const upper = days.map((d, i) => cum[i] + (byDate[d]?.[m] || 0));
    days.forEach((d, i) => { cum[i] = upper[i]; });
    const top = upper.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const bot = lower.map((v, i) => `${x(i)},${y(v)}`).reverse().join(' ');
    return `<polygon points="${top} ${bot}" fill="${colorOf(m)}" fill-opacity="0.75"><title>${esc(m)}</title></polygon>`;
  }).join('');
  // Axes + gridlines.
  const ticks = [0, 0.5, 1].map(f => {
    const v = max * f, yy = y(v);
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="grid"/><text x="${padL - 6}" y="${yy + 4}" class="axis" text-anchor="end">${fmt(Math.round(v))}</text>`;
  }).join('');
  const xlabels = days.map((d, i) =>
    (i === 0 || i === days.length - 1 || (days.length > 6 && i === Math.floor(days.length / 2)))
      ? `<text x="${x(i)}" y="${H - 8}" class="axis" text-anchor="middle">${d.slice(5)}</text>` : '').join('');
  const legend = models.map(m =>
    `<span class="lg"><i style="background:${colorOf(m)}"></i>${esc(m)}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${ticks}${areas}${xlabels}</svg><div class="legend">${legend}</div>`;
}

function categoryBarSVG(rows) {
  if (!rows.length) return '<p class="muted">No categorized tool usage in this range.</p>';
  const totalTok = rows.reduce((s, r) => s + r.tokens, 0) || 1;
  const max = Math.max(...rows.map(r => r.tokens), 1);
  const bars = rows.map(r => {
    const label = CAT_LABELS[r.category] || r.category;
    const color = CAT_COLORS[r.category] || '#888';
    const pct = (r.tokens / totalTok * 100).toFixed(1);
    const w = Math.max(2, Math.round(r.tokens / max * 100));
    return `<div class="catrow">
      <div class="catname">${esc(label)}</div>
      <div class="catbar"><div class="catfill" style="width:${w}%;background:${color}"></div></div>
      <div class="catval">${fmt(r.tokens)} <span class="muted">· ${r.calls} calls · ${pct}%</span></div>
    </div>`;
  }).join('');
  return `<div class="cats">${bars}</div>`;
}

// ── HTML builder (exported for tests) ──

export function buildDashboardHtml(data) {
  const { from, to, numDays, project, generatedAt, version, days,
    quick, dailyTokens, modelByDay, categories, models, skills, projects } = data;

  const projectRows = projects.map(p =>
    `<tr><td>${esc(p.project)}</td><td>${p.sessions}</td><td>${fmt(p.tokens)}</td><td>${fmtCost(p.cost)}</td><td>${fmtDuration(p.totalMin)}</td></tr>`).join('');
  const modelRows = models.map(m =>
    `<tr><td>${esc(m.model)}</td><td>${m.calls}</td><td>${fmt(m.tokens)}</td><td>${fmtCost(m.cost)}</td></tr>`).join('');
  const skillMax = skills[0]?.total || 1;
  const skillRows = skills.map(s => {
    const w = Math.round(s.total / skillMax * 100);
    return `<div class="catrow"><div class="catname">${esc(s.name)}</div><div class="catbar"><div class="catfill" style="width:${w}%;background:#5a8dd6"></div></div><div class="catval">${s.total}</div></div>`;
  }).join('') || '<p class="muted">No skill usage in this range.</p>';

  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TraceMe Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; background: #15171c; color: #e6e8ec; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px; }
  header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 28px 0 10px; color: #c8ccd4; border-bottom: 1px solid #2a2e37; padding-bottom: 6px; }
  .sub { color: #8b909a; font-size: 12px; }
  button { background: #7c5cff; color: #fff; border: 0; border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
  button:hover { background: #6a4cf0; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .card { background: #1c1f26; border: 1px solid #262a33; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .card .k { font-size: 11px; color: #8b909a; text-transform: uppercase; letter-spacing: .04em; }
  .card .v { font-size: 18px; font-weight: 600; margin-top: 2px; }
  .chart { width: 100%; height: auto; display: block; background: #1c1f26; border: 1px solid #262a33; border-radius: 8px; padding: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #23262e; }
  th { color: #8b909a; font-weight: 500; }
  td:nth-child(n+2), th:nth-child(n+2) { text-align: right; }
  .muted { color: #8b909a; }
  .cats { display: flex; flex-direction: column; gap: 8px; }
  .catrow { display: grid; grid-template-columns: 130px 1fr 200px; align-items: center; gap: 10px; }
  .catname { font-size: 13px; }
  .catbar { background: #23262e; border-radius: 4px; height: 14px; overflow: hidden; }
  .catfill { height: 100%; }
  .catval { font-size: 12px; text-align: right; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; font-size: 12px; color: #b6bac2; }
  .lg i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  .cal-lbl, .axis { fill: #8b909a; font-size: 9px; }
  .grid { stroke: #2a2e37; stroke-width: 1; }
  footer { margin-top: 32px; color: #6b707a; font-size: 12px; }
</style></head>
<body><div class="wrap">
<header>
  <div>
    <h1>TraceMe Dashboard</h1>
    <div class="sub">${from} → ${to} · ${numDays} day${numDays !== 1 ? 's' : ''}${project ? ` · project "${esc(project)}"` : ''} · generated ${esc(generatedAt)}</div>
  </div>
  <button onclick="location.reload()">↻ Refresh</button>
</header>

<div class="cards">
  <div class="card"><div class="k">Tokens</div><div class="v">${fmt(quick.tokens)}</div></div>
  <div class="card"><div class="k">Cost</div><div class="v">${fmtCost(quick.cost)}</div></div>
  <div class="card"><div class="k">Sessions</div><div class="v">${quick.sessions}</div></div>
  <div class="card"><div class="k">Prompts</div><div class="v">${quick.prompts}</div></div>
  <div class="card"><div class="k">Session time</div><div class="v">${fmtDuration(quick.totalMin)}</div></div>
  <div class="card"><div class="k">Projects</div><div class="v">${projects.length}</div></div>
</div>

<h2>Model Usage Calendar</h2>
${calendarHeatmapSVG(dailyTokens, days)}

<h2>Tokens per Day by Model</h2>
${stackedLineSVG(modelByDay, days)}

<h2>Token Usage by Category <span class="sub">(Plugins · Subagents · MCPs — local device)</span></h2>
${categoryBarSVG(categories)}

<h2>Model Usage</h2>
<table><thead><tr><th>Model</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${modelRows || '<tr><td colspan="4" class="muted">No data.</td></tr>'}</tbody></table>

<h2>Token Consumption by Project</h2>
<table><thead><tr><th>Project</th><th>Sessions</th><th>Tokens</th><th>Cost</th><th>Time</th></tr></thead><tbody>${projectRows || '<tr><td colspan="5" class="muted">No data.</td></tr>'}</tbody></table>

<h2>Skill Usage</h2>
${skillRows}

<footer>TraceMe ${esc(version)} · re-run <code>traceme dashboard${numDays !== 7 ? ` --days ${numDays}` : ''}</code> then Refresh for fresh data.</footer>
</div>
<script>window.__TRACEME__ = ${json};</script>
</body></html>`;
}

// ── Command ──

export function cmdDashboard(args, VERSION) {
  const getFlag = (a, f) => { const i = a.indexOf(f); return (i >= 0 && a[i + 1] && !a[i + 1].startsWith('--')) ? a[i + 1] : null; };
  const dayFlag = args.includes('--day');
  const monthFlag = args.includes('--month');
  const daysVal = getFlag(args, '--days');
  const project = getFlag(args, '--project');
  const noOpen = args.includes('--no-open');

  let numDays = 7;
  if (dayFlag) numDays = 1;
  else if (monthFlag) numDays = 30;
  else if (daysVal) numDays = parseInt(daysVal) || 7;

  const to = todayISO();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - numDays + 1);
  const from = fromDate.toISOString().slice(0, 10);
  const days = daysArray(from, to);
  const projectLike = project ? `%${project.toLowerCase()}%` : null;

  // Keep the local DB current before reporting.
  try { scanAll(); } catch {}

  const db = openDb();

  const dailyTokens = queryDailyTokens(from, to, projectLike);
  const modelByDay = queryModelByDay(from, to, projectLike);
  const categories = queryCategoryBreakdown(from, to, projectLike);

  // Model usage over range.
  const modelAgg = {};
  for (const day of days) {
    for (const m of queryModelBreakdown(day)) {
      const a = modelAgg[m.model] || (modelAgg[m.model] = { model: m.model, calls: 0, tokens: 0, cost: 0 });
      a.calls += m.calls; a.tokens += m.tokens; a.cost += m.cost;
    }
  }
  const models = Object.values(modelAgg).sort((a, b) => b.cost - a.cost);

  // Skills over range.
  const skillAgg = {};
  for (const r of querySkillUsage(from, to, projectLike)) {
    if (!r.skill_name) continue;
    skillAgg[r.skill_name] = (skillAgg[r.skill_name] || 0) + r.count;
  }
  const skills = Object.entries(skillAgg).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);

  // Per-project sessions, tokens, cost, time.
  const sql = `SELECT project, started_at, ended_at, total_tokens, total_cost
               FROM sessions WHERE date >= ? AND date <= ?` + (projectLike ? ' AND project LIKE ?' : '');
  const sessRows = projectLike ? db.prepare(sql).all(from, to, projectLike) : db.prepare(sql).all(from, to);
  const now = new Date();
  const projMap = {};
  const quick = { tokens: 0, cost: 0, sessions: 0, prompts: 0, totalMin: 0 };
  for (const s of sessRows) {
    const start = new Date(s.started_at);
    const end = s.ended_at ? new Date(s.ended_at) : now;
    let durMin = Math.round((end - start) / 60000);
    if (!s.ended_at && durMin > 240) durMin = 240;
    const p = projMap[s.project] || (projMap[s.project] = { project: s.project, sessions: 0, tokens: 0, cost: 0, totalMin: 0 });
    p.sessions++; p.tokens += s.total_tokens; p.cost += s.total_cost; p.totalMin += durMin;
    quick.sessions++; quick.tokens += s.total_tokens; quick.cost += s.total_cost; quick.totalMin += durMin;
  }
  const projects = Object.values(projMap).sort((a, b) => b.tokens - a.tokens);

  const data = {
    from, to, numDays, project: project || null, generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
    version: VERSION, days, quick, dailyTokens, modelByDay, categories, models, skills, projects,
  };

  const html = buildDashboardHtml(data);
  const htmlPath = join(dirname(getDbPath()), 'dashboard.html');
  writeFileSync(htmlPath, html);
  console.log(`Dashboard written to ${htmlPath}`);

  if (!noOpen) {
    try {
      const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', htmlPath]]
        : process.platform === 'darwin' ? ['open', [htmlPath]] : ['xdg-open', [htmlPath]];
      spawn(cmd, a, { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }
}
