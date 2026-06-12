import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  queryModelFacts, queryCategoryFacts, querySkillFacts, querySessionFacts, openDb,
} from '../db.mjs';
import { scanAll } from '../scan.mjs';
import { todayISO, getDbPath } from '../lib.mjs';

const ECHARTS_CDN = 'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── HTML builder (exported for tests) ──
// The server ships a flat 90-day fact table; ALL filtering/aggregation/rendering happens
// client-side so the user can pick any date sub-range, project subset, and grouping without
// re-running the CLI.

export function buildDashboardHtml(data) {
  const { meta } = data;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TraceMe Dashboard</title>
<script src="${ECHARTS_CDN}"></script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; background: #15171c; color: #e6e8ec; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px; }
  header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 28px 0 10px; color: #c8ccd4; border-bottom: 1px solid #2a2e37; padding-bottom: 6px; }
  .sub { color: #8b909a; font-size: 12px; }
  .controls { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; margin-top: 16px;
              background: #1c1f26; border: 1px solid #262a33; border-radius: 8px; padding: 12px 14px; }
  .ctl { display: flex; flex-direction: column; gap: 4px; }
  .ctl > label { font-size: 11px; color: #8b909a; text-transform: uppercase; letter-spacing: .04em; }
  input[type=date], select { background: #23262e; color: #e6e8ec; border: 1px solid #2a2e37; border-radius: 6px; padding: 6px 8px; font-size: 13px; }
  .seg { display: inline-flex; border: 1px solid #2a2e37; border-radius: 6px; overflow: hidden; }
  .seg button { background: #23262e; color: #b6bac2; border: 0; padding: 6px 12px; font-size: 13px; cursor: pointer; }
  .seg button.on { background: #7c5cff; color: #fff; }
  .projbox { position: relative; }
  .projbox > .menu { display: none; position: absolute; z-index: 10; top: 100%; left: 0; margin-top: 4px;
                     background: #1c1f26; border: 1px solid #2a2e37; border-radius: 6px; padding: 8px; max-height: 240px; overflow: auto; min-width: 200px; }
  .projbox.open > .menu { display: block; }
  .projbox .menu label { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 3px 4px; cursor: pointer; }
  .projbox > button { background: #23262e; color: #e6e8ec; border: 1px solid #2a2e37; border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .card { background: #1c1f26; border: 1px solid #262a33; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .card .k { font-size: 11px; color: #8b909a; text-transform: uppercase; letter-spacing: .04em; }
  .card .v { font-size: 18px; font-weight: 600; margin-top: 2px; }
  .chart { width: 100%; height: 260px; background: #1c1f26; border: 1px solid #262a33; border-radius: 8px; }
  .chart.cal { height: 200px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #23262e; }
  th { color: #8b909a; font-weight: 500; cursor: pointer; user-select: none; }
  td:nth-child(n+2), th:nth-child(n+2) { text-align: right; }
  .muted { color: #8b909a; }
  .note { color: #8b909a; font-size: 12px; margin: 4px 0 0; }
  footer { margin-top: 32px; color: #6b707a; font-size: 12px; }
</style></head>
<body><div class="wrap">
<header>
  <div>
    <h1>TraceMe Dashboard</h1>
    <div class="sub">data ${meta.from} → ${meta.to} · 90-day window · local device · generated ${esc(meta.generatedAt)}</div>
  </div>
</header>

<div class="controls">
  <div class="ctl"><label>From</label><input type="date" id="from" min="${meta.from}" max="${meta.to}"></div>
  <div class="ctl"><label>To</label><input type="date" id="to" min="${meta.from}" max="${meta.to}"></div>
  <div class="ctl"><label>Projects</label>
    <div class="projbox" id="projbox"><button id="projbtn" type="button">All projects ▾</button><div class="menu" id="projmenu"></div></div>
  </div>
  <div class="ctl"><label>Group by</label>
    <div class="seg" id="groupby">
      <button data-v="model" class="on">Model</button><button data-v="project">Project</button><button data-v="category">Category</button>
    </div>
  </div>
  <div class="ctl"><label>Trend basis</label>
    <div class="seg" id="basis">
      <button data-v="billable" class="on">Billable</button><button data-v="cost">Cost</button>
    </div>
  </div>
  <div class="ctl"><label>Cache read</label>
    <div class="seg" id="cacheread"><button data-v="off" class="on">Hide</button><button data-v="on">Show</button></div>
  </div>
</div>

<div class="cards" id="cards"></div>

<h2>Activity Calendar <span class="sub">(intensity = <span id="calbasis">billable tokens</span>; billable = input+output+cache_creation, excludes re-read cache)</span></h2>
<div class="chart cal" id="calendar"></div>

<h2>Tokens per Day <span class="sub">(stacked by <span id="trendgroup">model</span>; cache_read excluded unless toggled)</span></h2>
<div class="chart" id="trend"></div>

<h2>Breakdown <span class="sub">(selected range)</span></h2>
<div class="chart" id="breakdown"></div>

<h2>Tool-Category Tokens <span class="sub">(subagent = actual tokens · MCP/plugin/builtin ≈ result bytes, coarse estimate — not comparable, no shared %)</span></h2>
<div class="chart" id="catchart"></div>

<h2>Model Usage</h2>
<table id="modeltbl"><thead><tr><th data-k="model">Model</th><th data-k="requests">Calls</th><th data-k="tokens">Tokens</th><th data-k="cost">Cost</th></tr></thead><tbody></tbody></table>

<h2>Project Usage <span class="sub">(Elapsed = gross wall-clock incl. idle; sessions bucketed by start day)</span></h2>
<table id="projtbl"><thead><tr><th data-k="project">Project</th><th data-k="sessions">Sessions</th><th data-k="tokens">Tokens</th><th data-k="cost">Cost</th><th data-k="elapsedMin">Elapsed</th></tr></thead><tbody></tbody></table>

<h2>Skill Usage</h2>
<table id="skilltbl"><thead><tr><th data-k="name">Skill</th><th data-k="total">Uses</th></tr></thead><tbody></tbody></table>

<footer>TraceMe ${esc(meta.version)} · local-device data, 90-day window · run <code>traceme rescan --all</code> to backfill older sessions, then re-run <code>traceme dashboard</code>.</footer>
</div>
<script>window.__TRACEME__ = ${json};</script>
<script>${CLIENT_JS}</script>
</body></html>`;
}

// ── Client-side app (runs in the browser; embedded verbatim) ──
const CLIENT_JS = String.raw`
(function () {
  var D = window.__TRACEME__;
  if (!window.echarts) { document.body.insertAdjacentHTML('beforeend', '<p style="color:#d6505a;padding:24px">ECharts failed to load (offline?). Reconnect and reload.</p>'); return; }
  var fmt = function (n) {
    n = Math.round(n);
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  };
  var fmtCost = function (n) { return '$' + n.toFixed(4); };
  var fmtDur = function (min) {
    min = Math.round(min);
    if (min < 1) return '<1m';
    var h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  };
  var PALETTE = ['#7c5cff', '#1f9d6b', '#e0883a', '#d6505a', '#5a8dd6', '#c45ec4', '#3ab0c0', '#9aa05a', '#b06fd6', '#6fb0a0'];
  var CAT_LABELS = { subagent: 'Subagents', mcp: 'MCPs', plugin: 'Plugins', builtin: 'Built-in' };

  // ── controls state ──
  var state = {
    from: D.meta.from, to: D.meta.to,
    projects: new Set(D.meta.projects),
    groupBy: 'model', basis: 'billable', cacheRead: false,
    sort: { model: 'tokens', project: 'tokens', skill: 'total' },
  };
  // default the visible window to the last 30 days inside the 90-day data
  (function () {
    var to = new Date(D.meta.to + 'T00:00:00'); var from = new Date(to); from.setDate(from.getDate() - 29);
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    if (iso(from) >= D.meta.from) state.from = iso(from);
  })();

  var billable = function (r) { return r.input + r.output + r.cache_creation; };
  var inRange = function (r) { return r.date >= state.from && r.date <= state.to && state.projects.has(r.project); };

  var charts = {};
  function chart(id) { if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), 'dark'); return charts[id]; }

  // ── aggregation ──
  function days() {
    var out = [], d = new Date(state.from + 'T00:00:00'), end = new Date(state.to + 'T00:00:00');
    while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
    return out;
  }

  function render() {
    var mf = D.modelFacts.filter(inRange);
    var sf = D.sessionFacts.filter(inRange);
    var cf = D.categoryFacts.filter(inRange);
    var kf = D.skillFacts.filter(inRange);
    renderCards(mf, sf);
    renderCalendar(mf);
    renderTrend(mf);
    renderBreakdown(mf, cf);
    renderCatChart(cf);
    renderModelTable(mf);
    renderProjectTable(mf, sf);
    renderSkillTable(kf);
  }

  function renderCards(mf, sf) {
    var tokens = 0, billableTok = 0, cost = 0;
    mf.forEach(function (r) { tokens += r.tokens; billableTok += billable(r); cost += r.cost; });
    var now = Date.now(), elapsedMin = 0, prompts = 0;
    var sessions = sf.length, projects = {};
    sf.forEach(function (s) {
      projects[s.project] = 1; prompts += s.prompt_count;
      var start = new Date(s.started_at).getTime();
      var end = s.ended_at ? new Date(s.ended_at).getTime() : now;
      var m = Math.round((end - start) / 60000);
      if (!s.ended_at && m > 240) m = 240;
      elapsedMin += Math.max(0, m);
    });
    var cards = [
      ['Tokens', fmt(tokens)], ['Billable', fmt(billableTok)], ['Cost', fmtCost(cost)],
      ['Sessions', sessions], ['Prompts', prompts], ['Elapsed', fmtDur(elapsedMin)],
      ['Projects', Object.keys(projects).length],
    ];
    document.getElementById('cards').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>';
    }).join('');
  }

  function renderCalendar(mf) {
    var byDate = {};
    mf.forEach(function (r) {
      byDate[r.date] = byDate[r.date] || 0;
      byDate[r.date] += state.basis === 'cost' ? r.cost : billable(r);
    });
    var dd = days(), data = dd.map(function (d) { return [d, byDate[d] || 0]; });
    var max = data.reduce(function (m, x) { return Math.max(m, x[1]); }, 0) || 1;
    var costMode = state.basis === 'cost';
    chart('calendar').setOption({
      tooltip: { formatter: function (p) { return p.value[0] + '<br/>' + (costMode ? fmtCost(p.value[1]) : fmt(p.value[1]) + ' tokens'); } },
      visualMap: { min: 0, max: max, show: false, inRange: { color: ['#23262e', '#7c5cff'] } },
      calendar: { top: 30, left: 40, right: 16, cellSize: ['auto', 14], range: [state.from, state.to],
        itemStyle: { color: '#1c1f26', borderColor: '#15171c', borderWidth: 2 },
        dayLabel: { color: '#8b909a' }, monthLabel: { color: '#8b909a' }, yearLabel: { show: false }, splitLine: { show: false } },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: data }],
    }, true);
  }

  function groupKey(r) { return state.groupBy === 'project' ? r.project : state.groupBy === 'category' ? (r.model || 'model') : r.model; }

  function renderTrend(mf) {
    var dd = days();
    var keys = {};
    // group dimension: model or project (category uses tool categories — fall back to model here)
    var dim = state.groupBy === 'project' ? 'project' : 'model';
    mf.forEach(function (r) { keys[r[dim]] = 1; });
    var keyList = Object.keys(keys);
    var idx = {}; dd.forEach(function (d, i) { idx[d] = i; });
    var series = keyList.map(function (k, i) {
      var arr = dd.map(function () { return 0; });
      mf.forEach(function (r) { if (r[dim] === k) arr[idx[r.date]] += billable(r); });
      return { name: k, type: 'line', stack: 'tok', areaStyle: { opacity: 0.65 }, showSymbol: false,
        lineStyle: { width: 1 }, itemStyle: { color: PALETTE[i % PALETTE.length] }, data: arr };
    });
    if (state.cacheRead) {
      var carr = dd.map(function () { return 0; });
      mf.forEach(function (r) { carr[idx[r.date]] += r.cache_read; });
      series.push({ name: 'cache_read (re-read)', type: 'line', stack: 'tok', areaStyle: { opacity: 0.25 },
        showSymbol: false, lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: '#4a4e57' }, data: carr });
    }
    chart('trend').setOption({
      tooltip: { trigger: 'axis', valueFormatter: fmt },
      legend: { type: 'scroll', textStyle: { color: '#b6bac2' }, top: 0 },
      grid: { top: 36, left: 56, right: 16, bottom: 30 },
      xAxis: { type: 'category', data: dd, axisLabel: { color: '#8b909a', formatter: function (v) { return v.slice(5); } } },
      yAxis: { type: 'value', axisLabel: { color: '#8b909a', formatter: fmt }, splitLine: { lineStyle: { color: '#2a2e37' } } },
      series: series,
    }, true);
  }

  function renderBreakdown(mf, cf) {
    var dim = state.groupBy === 'project' ? 'project' : state.groupBy === 'category' ? 'category' : 'model';
    var agg = {};
    if (dim === 'category') {
      // tokens by tool category — but keep subagent (actual) apart from byte-proxy categories
      cf.forEach(function (r) { agg[CAT_LABELS[r.category] || r.category] = (agg[CAT_LABELS[r.category] || r.category] || 0) + r.tokens; });
    } else {
      mf.forEach(function (r) { agg[r[dim]] = (agg[r[dim]] || 0) + billable(r); });
    }
    var data = Object.keys(agg).map(function (k, i) { return { name: k, value: agg[k], itemStyle: { color: PALETTE[i % PALETTE.length] } }; })
      .sort(function (a, b) { return b.value - a.value; });
    chart('breakdown').setOption({
      tooltip: { trigger: 'item', formatter: function (p) { return p.name + ': ' + fmt(p.value) + (dim === 'category' ? '' : ' (' + p.percent + '%)'); } },
      legend: { type: 'scroll', textStyle: { color: '#b6bac2' }, top: 0 },
      series: [{ type: 'pie', radius: ['40%', '70%'], center: ['50%', '56%'], data: data,
        label: { color: '#b6bac2' }, labelLine: { lineStyle: { color: '#3a3e47' } } }],
    }, true);
  }

  function renderCatChart(cf) {
    var subagent = 0, proxy = {};
    cf.forEach(function (r) {
      if (r.category === 'subagent') subagent += r.tokens;
      else proxy[r.category] = (proxy[r.category] || 0) + r.tokens;
    });
    var pk = Object.keys(proxy);
    var cats = ['Subagents (actual tokens)'].concat(pk.map(function (k) { return (CAT_LABELS[k] || k) + ' (≈ bytes)'; }));
    var vals = [subagent].concat(pk.map(function (k) { return proxy[k]; }));
    var colors = ['#7c5cff'].concat(pk.map(function (_, i) { return PALETTE[(i + 2) % PALETTE.length]; }));
    chart('catchart').setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: function (p) { var b = p[0]; return b.name + '<br/>' + fmt(b.value) + (b.dataIndex === 0 ? ' tokens' : ' (byte estimate ÷4)'); } },
      grid: { top: 16, left: 160, right: 24, bottom: 24 },
      xAxis: { type: 'value', axisLabel: { color: '#8b909a', formatter: fmt }, splitLine: { lineStyle: { color: '#2a2e37' } } },
      yAxis: { type: 'category', data: cats, axisLabel: { color: '#b6bac2' }, inverse: true },
      series: [{ type: 'bar', data: vals.map(function (v, i) { return { value: v, itemStyle: { color: colors[i] } }; }) }],
    }, true);
  }

  function sortRows(rows, key) { return rows.sort(function (a, b) { var x = a[key], y = b[key]; return typeof x === 'string' ? String(x).localeCompare(y) : y - x; }); }

  function renderModelTable(mf) {
    var agg = {};
    mf.forEach(function (r) {
      var a = agg[r.model] || (agg[r.model] = { model: r.model, requests: 0, tokens: 0, cost: 0 });
      a.requests += r.requests; a.tokens += r.tokens; a.cost += r.cost;
    });
    var rows = sortRows(Object.values(agg), state.sort.model);
    fillTable('modeltbl', rows, function (r) {
      return '<td>' + esc(r.model) + '</td><td>' + r.requests + '</td><td>' + fmt(r.tokens) + '</td><td>' + fmtCost(r.cost) + '</td>';
    });
  }

  function renderProjectTable(mf, sf) {
    var agg = {};
    mf.forEach(function (r) {
      var a = agg[r.project] || (agg[r.project] = { project: r.project, sessions: 0, tokens: 0, cost: 0, elapsedMin: 0 });
      a.tokens += r.tokens; a.cost += r.cost;
    });
    var now = Date.now();
    sf.forEach(function (s) {
      var a = agg[s.project] || (agg[s.project] = { project: s.project, sessions: 0, tokens: 0, cost: 0, elapsedMin: 0 });
      a.sessions++;
      var start = new Date(s.started_at).getTime(), end = s.ended_at ? new Date(s.ended_at).getTime() : now;
      var m = Math.round((end - start) / 60000); if (!s.ended_at && m > 240) m = 240;
      a.elapsedMin += Math.max(0, m);
    });
    var rows = sortRows(Object.values(agg), state.sort.project);
    fillTable('projtbl', rows, function (r) {
      return '<td>' + esc(r.project) + '</td><td>' + r.sessions + '</td><td>' + fmt(r.tokens) + '</td><td>' + fmtCost(r.cost) + '</td><td>' + fmtDur(r.elapsedMin) + '</td>';
    });
  }

  function renderSkillTable(kf) {
    var agg = {};
    kf.forEach(function (r) { if (r.skill_name) agg[r.skill_name] = (agg[r.skill_name] || 0) + r.count; });
    var rows = sortRows(Object.keys(agg).map(function (k) { return { name: k, total: agg[k] }; }), state.sort.skill);
    fillTable('skilltbl', rows, function (r) { return '<td>' + esc(r.name) + '</td><td>' + r.total + '</td>'; });
  }

  function fillTable(id, rows, rowHtml) {
    var tb = document.querySelector('#' + id + ' tbody');
    tb.innerHTML = rows.length ? rows.map(function (r) { return '<tr>' + rowHtml(r) + '</tr>'; }).join('')
      : '<tr><td class="muted" colspan="9">No data in range.</td></tr>';
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ── wire controls ──
  var fromEl = document.getElementById('from'), toEl = document.getElementById('to');
  fromEl.value = state.from; toEl.value = state.to;
  fromEl.addEventListener('change', function () { state.from = fromEl.value; render(); });
  toEl.addEventListener('change', function () { state.to = toEl.value; render(); });

  // project menu
  var menu = document.getElementById('projmenu');
  menu.innerHTML = '<label><input type="checkbox" id="proj_all" checked> <b>All</b></label>' +
    D.meta.projects.map(function (p) { return '<label><input type="checkbox" class="projck" value="' + esc(p) + '" checked> ' + esc(p) + '</label>'; }).join('');
  var box = document.getElementById('projbox');
  document.getElementById('projbtn').addEventListener('click', function (e) { e.stopPropagation(); box.classList.toggle('open'); });
  document.addEventListener('click', function () { box.classList.remove('open'); });
  menu.addEventListener('click', function (e) { e.stopPropagation(); });
  function syncProjBtn() {
    var n = state.projects.size, total = D.meta.projects.length;
    document.getElementById('projbtn').textContent = (n === total ? 'All projects' : n + ' of ' + total) + ' ▾';
  }
  menu.addEventListener('change', function (e) {
    if (e.target.id === 'proj_all') {
      var on = e.target.checked;
      document.querySelectorAll('.projck').forEach(function (c) { c.checked = on; });
      state.projects = new Set(on ? D.meta.projects : []);
    } else {
      var sel = [];
      document.querySelectorAll('.projck').forEach(function (c) { if (c.checked) sel.push(c.value); });
      state.projects = new Set(sel);
      document.getElementById('proj_all').checked = sel.length === D.meta.projects.length;
    }
    syncProjBtn(); render();
  });

  function seg(id, apply) {
    var el = document.getElementById(id);
    el.addEventListener('click', function (e) {
      if (e.target.tagName !== 'BUTTON') return;
      el.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
      e.target.classList.add('on'); apply(e.target.getAttribute('data-v')); render();
    });
  }
  seg('groupby', function (v) { state.groupBy = v; document.getElementById('trendgroup').textContent = v === 'project' ? 'project' : 'model'; });
  seg('basis', function (v) { state.basis = v; document.getElementById('calbasis').textContent = v === 'cost' ? 'cost' : 'billable tokens'; });
  seg('cacheread', function (v) { state.cacheRead = v === 'on'; });

  // sortable table headers
  ['modeltbl', 'projtbl', 'skilltbl'].forEach(function (id) {
    var key = id === 'skilltbl' ? 'skill' : id === 'projtbl' ? 'project' : 'model';
    document.querySelectorAll('#' + id + ' th').forEach(function (th) {
      th.addEventListener('click', function () { state.sort[key] = th.getAttribute('data-k'); render(); });
    });
  });

  window.addEventListener('resize', function () { Object.keys(charts).forEach(function (k) { charts[k].resize(); }); });
  syncProjBtn(); render();
})();
`;

// ── Command ──

export function cmdDashboard(args, VERSION) {
  const noOpen = args.includes('--no-open');

  // Keep the local DB current before reporting.
  try { scanAll(); } catch {}
  openDb();

  const to = todayISO();
  const fromDate = new Date(to + 'T00:00:00');
  fromDate.setDate(fromDate.getDate() - 89);
  const from = fromDate.toISOString().slice(0, 10);

  const modelFacts = queryModelFacts(from, to);
  const categoryFacts = queryCategoryFacts(from, to);
  const skillFacts = querySkillFacts(from, to);
  const sessionFacts = querySessionFacts(from, to);

  const projects = [...new Set(modelFacts.map(r => r.project).concat(sessionFacts.map(r => r.project)))].sort();
  const models = [...new Set(modelFacts.map(r => r.model))].sort();

  const data = {
    meta: {
      from, to, version: VERSION,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
      projects, models,
    },
    modelFacts, categoryFacts, skillFacts, sessionFacts,
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
