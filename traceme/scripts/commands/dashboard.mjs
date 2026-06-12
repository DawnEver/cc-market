import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  queryModelFacts, queryCategoryFacts, querySkillFacts, querySessionFacts, openDb,
} from '../db.mjs';
import { scanAll } from '../scan.mjs';
import { readDeviceFacts, getDeviceId } from '../sync.mjs';
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
    <div class="sub">data ${meta.from} → ${meta.to} · 90-day window · ${meta.devices.length} device${meta.devices.length !== 1 ? 's' : ''} · generated ${esc(meta.generatedAt)}</div>
  </div>
</header>

<div class="controls">
  <div class="ctl"><label>From</label><input type="date" id="from" min="${meta.from}" max="${meta.to}"></div>
  <div class="ctl"><label>To</label><input type="date" id="to" min="${meta.from}" max="${meta.to}"></div>
  <div class="ctl"><label>Projects</label>
    <div class="projbox" id="projbox"><button id="projbtn" type="button">All projects ▾</button><div class="menu" id="projmenu"></div></div>
  </div>
  <div class="ctl" id="devicectl"><label>Devices</label>
    <div class="projbox" id="devbox"><button id="devbtn" type="button">All devices ▾</button><div class="menu" id="devmenu"></div></div>
  </div>
  <div class="ctl"><label>Group by</label>
    <div class="seg" id="groupby">
      <button data-v="model" class="on">Model</button><button data-v="project">Project</button><button data-v="device">Device</button><button data-v="category">Category</button>
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

<h2>Tool-Category Tokens <span class="sub" id="local-note-cat">(local device only · subagent = actual tokens · MCP/plugin/builtin ≈ result bytes, coarse estimate — not comparable, no shared %)</span></h2>
<div class="chart" id="catchart"></div>

<h2>Model Usage <span class="sub" id="local-note-model">(local device only — per-model data isn't synced)</span></h2>
<table id="modeltbl"><thead><tr><th data-k="model">Model</th><th data-k="requests">Calls</th><th data-k="tokens">Tokens</th><th data-k="cost">Cost</th></tr></thead><tbody></tbody></table>

<h2>Project Usage <span class="sub">(Active = hands-on time, gaps &lt;10min, local only; Elapsed = gross wall-clock incl. idle; sessions bucketed by start day)</span></h2>
<table id="projtbl"><thead><tr><th data-k="project">Project</th><th data-k="sessions">Sessions</th><th data-k="tokens">Tokens</th><th data-k="cost">Cost</th><th data-k="activeMin">Active</th><th data-k="elapsedMin">Elapsed</th></tr></thead><tbody></tbody></table>

<h2>Skill Usage <span class="sub" id="local-note-skill">(local device only — skill data isn't synced)</span></h2>
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
  var LOCAL = D.meta.localDevice;
  var state = {
    from: D.meta.from, to: D.meta.to,
    projects: new Set(D.meta.projects),
    devices: new Set(D.meta.devices),
    groupBy: 'model', basis: 'billable', cacheRead: false,
    sort: { model: 'tokens', project: 'tokens', skill: 'total' },
  };
  // default the visible window to the last 30 days inside the 90-day data
  (function () {
    var to = new Date(D.meta.to + 'T00:00:00'); var from = new Date(to); from.setDate(from.getDate() - 29);
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    if (iso(from) >= D.meta.from) state.from = iso(from);
  })();

  function localOnly() { return state.devices.size === 1 && state.devices.has(LOCAL); }
  function localOn() { return state.devices.has(LOCAL); }
  var billable = function (r) { return r.input + r.output + r.cache_creation; };
  var inRange = function (r) { return r.date >= state.from && r.date <= state.to && state.projects.has(r.project); };

  // Unified per-(date,project,device) token rows: local from live modelFacts (with components),
  // foreign from synced deviceFacts (totals only). billable === tokens for foreign (no split).
  function tokenRows() {
    var rows = [];
    if (localOn()) D.modelFacts.forEach(function (r) {
      if (!inRange(r)) return;
      rows.push({ date: r.date, project: r.project, device: LOCAL, model: r.model,
        tokens: r.tokens, billable: billable(r), cache_read: r.cache_read, cost: r.cost, requests: r.requests, local: true });
    });
    D.deviceFacts.forEach(function (r) {
      if (!state.devices.has(r.device) || !inRange(r)) return;
      rows.push({ date: r.date, project: r.project, device: r.device, model: r.top_model || '(unknown)',
        tokens: r.tokens, billable: r.tokens, cache_read: 0, cost: r.cost, requests: 0, local: false });
    });
    return rows;
  }
  // Unified session rows: local sessions carry timestamps (→ elapsed); foreign carry counts only.
  function sessionRows() {
    var rows = [];
    if (localOn()) D.sessionFacts.forEach(function (s) {
      if (!inRange(s)) return;
      rows.push({ project: s.project, device: LOCAL, sessions: 1, prompts: s.prompt_count,
        started_at: s.started_at, ended_at: s.ended_at, active_min: s.active_min || 0, local: true });
    });
    D.deviceFacts.forEach(function (r) {
      if (!state.devices.has(r.device) || !inRange(r)) return;
      rows.push({ project: r.project, device: r.device, sessions: r.sessions, prompts: r.prompts, local: false });
    });
    return rows;
  }
  // Trend uses billable basis only when every row has it (local-only); else total tokens.
  function tokTrend(r) { return localOnly() ? r.billable : r.tokens; }
  function dimOf(r) { return state.groupBy === 'project' ? r.project : state.groupBy === 'device' ? r.device : r.model; }

  var charts = {};
  function chart(id) { if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), 'dark'); return charts[id]; }

  function days() {
    var out = [], d = new Date(state.from + 'T00:00:00'), end = new Date(state.to + 'T00:00:00');
    while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
    return out;
  }

  function render() {
    var tr = tokenRows(), sr = sessionRows();
    var cf = D.categoryFacts.filter(inRange);
    var kf = D.skillFacts.filter(inRange);
    // toggles that only make sense for a single (local) device
    document.getElementById('basis').parentNode.style.display = localOnly() ? '' : 'none';
    document.getElementById('cacheread').parentNode.style.display = localOnly() ? '' : 'none';
    renderCards(tr, sr);
    renderCalendar(tr);
    renderTrend(tr);
    renderBreakdown(tr, cf);
    renderCatChart(cf);
    renderModelTable();
    renderProjectTable(tr, sr);
    renderSkillTable(kf);
  }

  function renderCards(tr, sr) {
    var tokens = 0, billableTok = 0, cost = 0;
    tr.forEach(function (r) { tokens += r.tokens; billableTok += r.billable; cost += r.cost; });
    var now = Date.now(), elapsedMin = 0, activeMin = 0, prompts = 0, sessions = 0, projects = {}, devices = {};
    sr.forEach(function (s) {
      projects[s.project] = 1; devices[s.device] = 1; prompts += s.prompts; sessions += s.sessions;
      if (s.local && s.started_at) {
        activeMin += s.active_min || 0;
        var start = new Date(s.started_at).getTime();
        var end = s.ended_at ? new Date(s.ended_at).getTime() : now;
        var m = Math.round((end - start) / 60000);
        if (!s.ended_at && m > 240) m = 240;
        elapsedMin += Math.max(0, m);
      }
    });
    var cards = [['Tokens', fmt(tokens)]];
    if (localOnly()) cards.push(['Billable', fmt(billableTok)]);
    cards.push(['Cost', fmtCost(cost)], ['Sessions', sessions], ['Prompts', prompts],
      ['Active' + (localOn() ? '' : ' (n/a)'), localOn() ? fmtDur(activeMin) : '—'],
      ['Elapsed' + (localOn() ? '' : ' (n/a)'), localOn() ? fmtDur(elapsedMin) : '—'],
      ['Projects', Object.keys(projects).length], ['Devices', Object.keys(devices).length]);
    document.getElementById('cards').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>';
    }).join('');
  }

  function renderCalendar(tr) {
    var costMode = localOnly() && state.basis === 'cost';
    var byDate = {};
    tr.forEach(function (r) {
      byDate[r.date] = (byDate[r.date] || 0) + (costMode ? r.cost : tokTrend(r));
    });
    var dd = days(), data = dd.map(function (d) { return [d, byDate[d] || 0]; });
    var max = data.reduce(function (m, x) { return Math.max(m, x[1]); }, 0) || 1;
    chart('calendar').setOption({
      tooltip: { formatter: function (p) { return p.value[0] + '<br/>' + (costMode ? fmtCost(p.value[1]) : fmt(p.value[1]) + ' tokens'); } },
      visualMap: { min: 0, max: max, show: false, inRange: { color: ['#23262e', '#7c5cff'] } },
      calendar: { top: 30, left: 40, right: 16, cellSize: ['auto', 14], range: [state.from, state.to],
        itemStyle: { color: '#1c1f26', borderColor: '#15171c', borderWidth: 2 },
        dayLabel: { color: '#8b909a' }, monthLabel: { color: '#8b909a' }, yearLabel: { show: false }, splitLine: { show: false } },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: data }],
    }, true);
  }

  function renderTrend(tr) {
    var dd = days();
    var keys = {}; tr.forEach(function (r) { keys[dimOf(r)] = 1; });
    var keyList = Object.keys(keys);
    var idx = {}; dd.forEach(function (d, i) { idx[d] = i; });
    var series = keyList.map(function (k, i) {
      var arr = dd.map(function () { return 0; });
      tr.forEach(function (r) { if (dimOf(r) === k) arr[idx[r.date]] += tokTrend(r); });
      return { name: k, type: 'line', stack: 'tok', areaStyle: { opacity: 0.65 }, showSymbol: false,
        lineStyle: { width: 1 }, itemStyle: { color: PALETTE[i % PALETTE.length] }, data: arr };
    });
    if (localOnly() && state.cacheRead) {
      var carr = dd.map(function () { return 0; });
      tr.forEach(function (r) { carr[idx[r.date]] += r.cache_read; });
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

  function renderBreakdown(tr, cf) {
    var agg = {};
    var isCat = state.groupBy === 'category';
    if (isCat) {
      // subagent is real tokens; others are the byte-estimate — labelled so they aren't read as tokens
      cf.forEach(function (r) {
        var l = r.category === 'subagent' ? 'Subagents (tokens)' : (CAT_LABELS[r.category] || r.category) + ' (≈ bytes)';
        agg[l] = (agg[l] || 0) + (r.category === 'subagent' ? r.tokens : (r.bytes_est || 0));
      });
    } else {
      tr.forEach(function (r) { var k = dimOf(r); agg[k] = (agg[k] || 0) + tokTrend(r); });
    }
    var data = Object.keys(agg).map(function (k, i) { return { name: k, value: agg[k], itemStyle: { color: PALETTE[i % PALETTE.length] } }; })
      .sort(function (a, b) { return b.value - a.value; });
    chart('breakdown').setOption({
      tooltip: { trigger: 'item', formatter: function (p) { return p.name + ': ' + fmt(p.value) + (isCat ? '' : ' (' + p.percent + '%)'); } },
      legend: { type: 'scroll', textStyle: { color: '#b6bac2' }, top: 0 },
      series: [{ type: 'pie', radius: ['40%', '70%'], center: ['50%', '56%'], data: data,
        label: { color: '#b6bac2' }, labelLine: { lineStyle: { color: '#3a3e47' } } }],
    }, true);
  }

  function renderCatChart(cf) {
    // local-only panel: blank with a note when the local device is filtered out
    var note = document.getElementById('local-note-cat');
    if (!localOn()) { chart('catchart').clear(); note.textContent = '(local device not selected)'; return; }
    note.textContent = '(local device only · subagent = actual tokens · MCP/plugin/builtin ≈ result bytes, coarse estimate — not comparable, no shared %)';
    var subagent = 0, proxy = {};
    cf.forEach(function (r) {
      if (r.category === 'subagent') subagent += r.tokens;
      else proxy[r.category] = (proxy[r.category] || 0) + (r.bytes_est || 0);
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

  // Cross-device per-model rows: local from live modelFacts (billable), foreign from synced
  // deviceModelFacts. Foreign cost is the pushing device's price at push time.
  function modelRows() {
    var rows = [];
    if (localOn()) D.modelFacts.forEach(function (r) {
      if (!inRange(r)) return;
      rows.push({ model: r.model, requests: r.requests, tokens: billable(r), cost: r.cost });
    });
    (D.deviceModelFacts || []).forEach(function (r) {
      if (!state.devices.has(r.device) || !inRange(r)) return;
      rows.push({ model: r.model, requests: r.requests, tokens: r.tokens, cost: r.cost });
    });
    return rows;
  }

  function renderModelTable() {
    var note = document.getElementById('local-note-model');
    var foreign = (D.deviceModelFacts || []).length > 0 && !localOnly();
    note.textContent = foreign ? '(cross-device; foreign cost priced at push time)' : '(local device only — per-model data syncs once other devices re-push)';
    var agg = {};
    modelRows().forEach(function (r) {
      var a = agg[r.model] || (agg[r.model] = { model: r.model, requests: 0, tokens: 0, cost: 0 });
      a.requests += r.requests; a.tokens += r.tokens; a.cost += r.cost;
    });
    var rows = sortRows(Object.values(agg), state.sort.model);
    fillTable('modeltbl', rows, function (r) {
      return '<td>' + esc(r.model) + '</td><td>' + r.requests + '</td><td>' + fmt(r.tokens) + '</td><td>' + fmtCost(r.cost) + '</td>';
    });
  }

  function renderProjectTable(tr, sr) {
    var agg = {};
    function row(p) { return agg[p] || (agg[p] = { project: p, sessions: 0, tokens: 0, cost: 0, activeMin: 0, elapsedMin: 0 }); }
    tr.forEach(function (r) { var a = row(r.project); a.tokens += r.tokens; a.cost += r.cost; });
    var now = Date.now();
    sr.forEach(function (s) {
      var a = row(s.project); a.sessions += s.sessions;
      if (s.local && s.started_at) {
        a.activeMin += s.active_min || 0;
        var start = new Date(s.started_at).getTime(), end = s.ended_at ? new Date(s.ended_at).getTime() : now;
        var m = Math.round((end - start) / 60000); if (!s.ended_at && m > 240) m = 240;
        a.elapsedMin += Math.max(0, m);
      }
    });
    var rows = sortRows(Object.values(agg), state.sort.project);
    var dash = '<span class="muted">—</span>';
    fillTable('projtbl', rows, function (r) {
      return '<td>' + esc(r.project) + '</td><td>' + r.sessions + '</td><td>' + fmt(r.tokens) + '</td><td>' + fmtCost(r.cost) + '</td><td>' + (r.activeMin ? fmtDur(r.activeMin) : dash) + '</td><td>' + (r.elapsedMin ? fmtDur(r.elapsedMin) : dash) + '</td>';
    });
  }

  function renderSkillTable(kf) {
    var note = document.getElementById('local-note-skill');
    if (!localOn()) { fillTable('skilltbl', [], null); note.textContent = '(local device not selected)'; return; }
    note.textContent = '(local device only — skill data isn’t synced)';
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

  // generic checkbox multi-select (projects, devices)
  function multiselect(opts) {
    var items = opts.items, getSet = opts.getSet, setSet = opts.setSet, label = opts.label;
    var menu = document.getElementById(opts.menu), box = document.getElementById(opts.box), btn = document.getElementById(opts.btn);
    var allId = opts.box + '_all';
    menu.innerHTML = '<label><input type="checkbox" id="' + allId + '" checked> <b>All</b></label>' +
      items.map(function (p) { return '<label><input type="checkbox" class="' + opts.box + '_ck" value="' + esc(p) + '" checked> ' + esc(p) + '</label>'; }).join('');
    btn.addEventListener('click', function (e) { e.stopPropagation(); box.classList.toggle('open'); });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    function sync() {
      var n = getSet().size;
      btn.textContent = (n === items.length ? 'All ' + label : n + ' of ' + items.length) + ' ▾';
    }
    menu.addEventListener('change', function (e) {
      var cks = menu.querySelectorAll('.' + opts.box + '_ck');
      if (e.target.id === allId) {
        cks.forEach(function (c) { c.checked = e.target.checked; });
        setSet(new Set(e.target.checked ? items : []));
      } else {
        var sel = []; cks.forEach(function (c) { if (c.checked) sel.push(c.value); });
        setSet(new Set(sel));
        document.getElementById(allId).checked = sel.length === items.length;
      }
      sync(); render();
    });
    return sync;
  }
  document.addEventListener('click', function () {
    document.getElementById('projbox').classList.remove('open');
    document.getElementById('devbox').classList.remove('open');
  });
  var syncProjBtn = multiselect({ items: D.meta.projects, label: 'projects', box: 'projbox', btn: 'projbtn', menu: 'projmenu',
    getSet: function () { return state.projects; }, setSet: function (s) { state.projects = s; } });
  var syncDevBtn = multiselect({ items: D.meta.devices, label: 'devices', box: 'devbox', btn: 'devbtn', menu: 'devmenu',
    getSet: function () { return state.devices; }, setSet: function (s) { state.devices = s; } });
  // hide the device control entirely when there's only the local device
  if (D.meta.devices.length < 2) document.getElementById('devicectl').style.display = 'none';

  function seg(id, apply) {
    var el = document.getElementById(id);
    el.addEventListener('click', function (e) {
      if (e.target.tagName !== 'BUTTON') return;
      el.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
      e.target.classList.add('on'); apply(e.target.getAttribute('data-v')); render();
    });
  }
  seg('groupby', function (v) { state.groupBy = v; document.getElementById('trendgroup').textContent = v === 'project' ? 'project' : v === 'device' ? 'device' : 'model'; });
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
  syncProjBtn(); syncDevBtn(); render();
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

  // Cross-device: foreign devices' synced per-project daily + per-model facts (local device is the live DB above).
  let deviceFacts = [], deviceModelFacts = [], foreignDevices = [];
  try { ({ facts: deviceFacts, modelFacts: deviceModelFacts, devices: foreignDevices } = readDeviceFacts(from, to)); } catch {}
  let localDevice = 'local';
  try { localDevice = getDeviceId(); } catch {}
  const devices = [localDevice, ...foreignDevices.filter(d => d !== localDevice)];

  // Disambiguate same-basename repos: identity is repo_origin, display is project; when one
  // basename maps to >1 remote, suffix the remote's tail so distinct repos don't merge. (Remote-
  // less repos share '' and still merge — no identity exists without a remote.)
  const allFactSets = [modelFacts, sessionFacts, categoryFacts, skillFacts, deviceFacts, deviceModelFacts];
  const reposByProject = {};
  for (const set of allFactSets) for (const r of set) {
    (reposByProject[r.project] ||= new Set()).add(r.repo_origin || '');
  }
  const repoTail = repo => (repo.split('/').pop() || repo).slice(0, 18);
  const displayName = r => {
    const repos = reposByProject[r.project];
    return (repos && repos.size > 1 && r.repo_origin) ? `${r.project} (${repoTail(r.repo_origin)})` : r.project;
  };
  for (const set of allFactSets) for (const r of set) r.project = displayName(r);

  const projects = [...new Set(
    modelFacts.map(r => r.project)
      .concat(sessionFacts.map(r => r.project))
      .concat(deviceFacts.map(r => r.project))
  )].sort();
  const models = [...new Set(modelFacts.map(r => r.model))].sort();

  const data = {
    meta: {
      from, to, version: VERSION,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
      projects, models, devices, localDevice,
    },
    modelFacts, categoryFacts, skillFacts, sessionFacts, deviceFacts, deviceModelFacts,
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
