// web/public/main.js — the console's orchestration: polling, the one delegated click
// dispatcher, toasts (never alert()), and the transcript-as-truth chat. Rendering is
// declarative via render.js; all derivation lives in state.js. No state is invented
// here — the DOM is a projection of fabric facts (fleet, catalogue, session views).
//
// Scope, honestly stated: sessions this console spawned or attached are drivable;
// a foreign peer session (owned by another connection, not shared) is read-only —
// node/view is visibility, not acting — so clicking it opens OBSERVE mode with the
// composer disabled and the reason shown, instead of an unexplained disabled button.

import { h, t, patch } from "./render.js";
import { viewMessages, aggregateFleet, sessionsOf, canDrive, sessionKey } from "./state.js";
import { fmtUptime, fmtMem, fmtAgo } from "/lib/format.mjs";

const $ = (s) => document.querySelector(s);
let fleet = [], orphans = [], catalogue = { providers: [], efforts: [], defaults: null };
let selMachine = null, selProject = null;
// selected = { type:'console', id } | { type:'observe', node, remoteId }
let selected = null;
let sending = false, fleetAt = 0;
// Poll guards: skip a tick if the previous refresh is still in flight, so a slow peer
// (or a blocked probe) never stacks overlapping requests that make the UI feel stuck.
let fleetBusy = false, chatBusy = false;
const attached = new Map(); // `${node}:${remoteId}` → console session id

const api = async (method, path, body) => {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' },
                                body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};
const fmtCost = (c) => c == null ? '' : (c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`);
const fmtTokens = (n) => n == null ? '' : (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));
const notLast = (s) => !(s.lastActivity) ? '' : ` · ${fmtAgo(s.lastActivity)}`;

// ── toasts: errors are system facts, shown in a status strip — never a modal ──
const toast = (msg, bad = true) => {
  const strip = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  strip.appendChild(el);
  setTimeout(() => el.remove(), 5000);
};

// ── one delegated click dispatcher (handlers are stable; patch never touches them) ──
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'pick-machine') pickMachine(el.dataset.name);
  else if (a === 'pick-project') pickProject(el.dataset.project);
  else if (a === 'open') openSession(el.dataset.node, el.dataset.id, el.dataset.chattable === '1');
  else if (a === 'close-sess') { e.stopPropagation(); closeSess(el.dataset.id); }
  else if (a === 'orphan-resume') resumeOrphan(el.dataset.id);
  else if (a === 'orphan-kill') killOrphan(el.dataset.id);
  else if (a === 'orphan-clear') clearOrphan(el.dataset.id);
});

// ── header: fleet totals · spend · as-of staleness · catalogue age ──
function renderHeader() {
  const agg = aggregateFleet(fleet);
  patch($('#headerStats'),
    h('span', {}, [t(`${agg.alive}/${agg.total} machines · ${agg.sessions} session(s) · spend ${fmtCost(agg.cost)}`)]));
  patch($('#asOf'), h('span', { class: 'dim' }, [t('as of ' + new Date(fleetAt).toLocaleTimeString())]));
}

// ── catalogue: live-probed identity; the UI never invents a model name ──
function fillModels() {
  const p = catalogue.providers.find((x) => x.name === $('#providerSel').value);
  const opts = (p?.models || []).map((m) => `<option value="${m.alias}">${m.alias} → ${m.actual}</option>`).join('')
    || (p ? `<option value="">${p.name} built-in default</option>` : '');
  $('#modelSel').innerHTML = opts;
  $('#providerIdent').textContent = p
    ? `${p.name}${p.version ? ' ' + p.version : ''} — ${p.identity}${p.available ? '' : ' (UNAVAILABLE)'}` : '';
}
async function loadCatalogue(force) {
  if (force) { const b = $('#reprobe'); b.disabled = true; b.classList.add('spin'); }
  try {
    catalogue = await api('GET', '/api/catalogue' + (force ? '?force=1' : ''));
    $('#catAge').textContent = 'catalogue probed ' + new Date(catalogue.probed_at).toLocaleTimeString();
    $('#providerSel').innerHTML = catalogue.providers.map((p) =>
      `<option value="${p.name}" ${p.available ? '' : 'disabled'}>${p.name}${p.available ? '' : ' (unavailable)'}</option>`).join('');
    const d = catalogue.defaults || {};
    const dp = catalogue.providers.find((p) => p.name === d.provider && p.available);
    if (dp) $('#providerSel').value = d.provider;
    else {
      const firstOk = catalogue.providers.find((p) => p.available && p.name === 'deepseek') || catalogue.providers.find((p) => p.available);
      if (firstOk) $('#providerSel').value = firstOk.name;
    }
    fillModels();
    if (d.model) {
      const dm = catalogue.providers.find((p) => p.name === $('#providerSel').value)?.models.find((mm) => mm.actual === d.model);
      if (dm) $('#modelSel').value = dm.alias;
    }
    const defaultEffort = d.effort || 'medium';
    $('#effortSel').innerHTML = catalogue.efforts
      .map((e) => `<option value="${e.name}" ${e.name === defaultEffort ? 'selected' : ''}>${e.name} (${e.tokens} tk)</option>`).join('');
  } catch (e) { toast('catalogue: ' + e.message); }
  finally {
    const b = $('#reprobe'); b.disabled = false; b.classList.remove('spin');
  }
}

// ── fleet: Machine → Project → Session; selection is a FILTER, never navigation ──
function machineCard(m) {
  if (!m.alive) {
    return h('div.card', { key: m.name }, [
      h('div.row', {}, [h('b', {}, [t(m.name)]), h('span', { class: 'bad' }, [t('●')])]),
      h('span.dim', {}, [t(m.error || 'dead')]),
    ]);
  }
  const sess = sessionsOf(m);
  const details = `v${m.version} · cpu ${m.cpu_busy_pct ?? '?'}% (${m.cpu} cores) · mem ${fmtMem(m.mem_available_mb)} free / ${fmtMem(m.mem_total_mb)} total · up ${fmtUptime(m.uptime_s)} · ${sess.length} sess${m.tags?.length ? ' · ' + m.tags.join(',') : ''}`;
  return h('div.card click' + (selMachine === m.name ? ' sel' : ''), {
    key: m.name, 'data-action': 'pick-machine', 'data-name': m.name,
  }, [
    h('div.row', {}, [
      h('b', {}, [t(m.name)]),
      h('span', {}, [...(m.self ? [h('span.badge self', {}, [t('this machine')])] : []), h('span.ok', {}, [t('●')])]),
    ]),
    h('span.dim', {}, [t(details)]),
  ]);
}

function pickMachine(n) { selMachine = selMachine === n ? null : n; selProject = null; renderFleet(); updateSpawnWhere(); }
function pickProject(p) { selProject = selProject === p ? null : p; renderFleet(); updateSpawnWhere(); }

function sessCard(s, machine) {
  const key = sessionKey(machine.name, s);
  const mine = s.chattable || attached.has(key);
  const drive = canDrive({ ...s, key }, attached);
  const consoleId = s.chattable ? s.id : attached.get(key);
  const sel = selected && (selected.type === 'console' ? selected.id === consoleId : selected.type === 'observe' && selected.remoteId === s.nativeId && selected.node === machine.name);
  const ident = [s.provider, s.model, s.effort].filter(Boolean).join(' · ');
  // Context = cumulative input tokens (input + cache creation + cache read) — the
  // closest honest measure of context pressure fabric records. turns always shown.
  const ctx = s.usage?.total_input_tokens ?? s.usage?.input_tokens ?? null;
  // Honest "why no project": an attached handle records no location at all; a session
  // with a real cwd outside every registered alias shows where it actually runs.
  const loc = !s.project
    ? (s.provider === 'attached' ? ' · attached handle'
      : (s.cwd ? ' · cwd ' + s.cwd.split(/[\\/]/).filter(Boolean).pop() : ''))
    : '';
  const facts = [ident, `turns ${s.turns ?? 0}`, ctx != null ? `ctx ${fmtTokens(ctx)}` : '',
                 s.pid ? `pid ${s.pid}` : '', loc].filter(Boolean).join(' · ');
  const cost = s.usage?.cost_usd ? ' · ' + fmtCost(s.usage.cost_usd) : '';
  return h('div.card click' + (sel ? ' sel' : ''), {
    key: 's:' + key,
    ...(s.cwd ? { title: s.cwd } : {}), // full path on hover; basename in the line above
    'data-action': 'open', 'data-node': machine.name,
    // Mine → the console session id (drives /api/sessions/:id). Foreign → the peer's
    // id, used to attach (shared) or observe (non-shared).
    'data-id': mine ? s.id : (s.nativeId ?? s.id),
    'data-chattable': mine ? '1' : '0',
  }, [
    h('div.row', {}, [
      h('b', {}, [t(s.id)]),
      h('span', {}, [...(s.shared ? [h('span.badge shared', {}, [t('shared')])] : []), h('span', { class: s.alive === false ? 'bad' : 'ok' }, [t('●')])]),
    ]),
    h('span.dim', {}, [t(facts + notLast(s) + cost)]),
    ...(drive ? [] : [h('div.dim', {}, [t('owned by another connection — click to view read-only')])]),
    ...(mine ? [h('div.actions', {}, [h('button', { 'data-action': 'close-sess', 'data-id': consoleId }, [t('close')])])] : []),
  ]);
}

function projectRow(p, machine) {
  const n = sessionsOf(machine).filter((s) => s.project === p).length;
  return h('div.proj' + (selProject === p ? ' sel' : ''), { key: 'p:' + p, 'data-action': 'pick-project', 'data-project': p }, [
    h('span', {}, [t('📁 ' + p)]), h('span.dim', {}, [t(n + ' session(s)')]),
  ]);
}

function orphansSection(machine, orphans) {
  if (!orphans.length) return [];
  return [h('div', { key: 'o:' + machine.name }, [
    h('div.orphanHead', {}, [t(`⚠ ${orphans.length} unaccounted session(s)`)]),
    ...orphans.map((x) => h('div.card', { key: 'oo:' + x.id }, [
      h('div.row', {}, [
        h('b', {}, [t(x.id)]),
        h('span', {}, [
          ...(x.node == null && x.sessionId ? [h('button', { 'data-action': 'orphan-resume', 'data-id': x.id }, [t('continue (resume)')])] : []),
          ...(x.pidAlive !== false ? [h('button', { 'data-action': 'orphan-kill', 'data-id': x.id }, [t('kill')])] : []),
          h('button', { 'data-action': 'orphan-clear', 'data-id': x.id }, [t('clear record')]),
        ]),
      ]),
      h('span.dim', {}, [t(`pid ${x.pid ?? '—'} · alive ${x.pidAlive === null ? 'unknown (remote)' : x.pidAlive}${x.sessionId ? ' · resumable' : ''} · ${new Date(x.ts).toLocaleString()}`)]),
    ])),
  ])];
}

function renderFleet() {
  const machines = fleet.filter((m) => m.alive && (!selMachine || m.name === selMachine));
  if (!machines.length) { patch($('#tree'), h('span.dim', {}, [t('no machine selected/alive')])); return; }
  // Orphans live under the machine they belong to (their node, else this machine).
  const selfName = fleet.find((m) => m.self)?.name;
  const orphansByMachine = new Map();
  for (const x of orphans) {
    const mn = x.node ?? selfName ?? 'this machine';
    if (!orphansByMachine.has(mn)) orphansByMachine.set(mn, []);
    orphansByMachine.get(mn).push(x);
  }
  const body = machines.map((m) => {
    const sess = sessionsOf(m);
    const projects = [...new Set([...(m.projects || []), ...sess.map((s) => s.project).filter(Boolean)])];
    const noProj = sess.filter((s) => !s.project);
    const byProj = (p) => sess.filter((s) => s.project === p);
    const mOrphans = orphansByMachine.get(m.name) || [];
    const projHtml = projects.filter((p) => !selProject || p === selProject)
      .map((p) => h('div', { key: 'proj:' + m.name + ':' + p }, [
        projectRow(p, m),
        ...byProj(p).map((s) => sessCard(s, m)),
      ]));
    if (!selProject && noProj.length) {
      // Name the reason: attached handles have no recorded location; cwd-bearing
      // sessions run outside every registered project alias (their card shows the cwd).
      const allAttached = noProj.every((s) => s.provider === 'attached');
      projHtml.push(h('div', { key: 'proj:' + m.name + ':(none)' }, [
        h('div.proj', {}, [
          h('span', {}, [t(allAttached ? '📁 attached — no project recorded' : '📁 (no project)')]),
          h('span.dim', {}, [t(noProj.length)]),
        ]),
        ...noProj.map((s) => sessCard(s, m)),
      ]));
    }
    return h('div', { key: m.name }, [
      h('h2', {}, [t(m.name)]), ...projHtml, ...orphansSection(m, mOrphans),
    ]);
  });
  patch($('#tree'), h('div', {}, body));
}

async function refreshFleet() {
  if (fleetBusy) return; // a slow peer must not stack overlapping polls
  fleetBusy = true;
  try {
    fleet = await api('GET', '/api/fleet'); fleetAt = Date.now();
    orphans = await api('GET', '/api/reconcile');
    patch($('#machines'), h('div', {}, fleet.map(machineCard)));
    renderFleet();
    renderHeader();
    updateSpawnWhere();
  } catch (e) { $('#machines').textContent = e.message; }
  finally { fleetBusy = false; }
}

// ── spawn: a session always lands in a NAMED machine + project (no "(node default)") ──
function updateSpawnWhere() {
  const m = fleet.find((x) => x.name === selMachine);
  $('#spawnWhere').textContent = '→ ' + (selMachine ?? 'pick a machine') + (selProject ? ' / ' + selProject : '');
  $('#projectSel').innerHTML =
    (m?.projects || []).map((p) => `<option ${p === (selProject ?? m.projects[0]) ? 'selected' : ''}>${p}</option>`).join('')
    || '<option value="" disabled>no projects registered on this node</option>';
}
async function spawn() {
  if (!selMachine) { toast('pick a machine on the left first'); return; }
  const f = new FormData($('#spawnForm'));
  const v = (k) => (f.get(k) || '').toString().trim() || undefined;
  try {
    const desc = await api('POST', '/api/sessions', {
      provider: v('provider'), model: v('model'), effort: v('effort'),
      node: selMachine, project: v('project') ?? selProject,
      profile: v('profile'),
      write: f.get('write') === 'on', visible: f.get('visible') === 'on', interactive: f.get('interactive') === 'on',
    });
    selected = { type: 'console', id: desc.id };
    refreshFleet(); refreshChat(); updateComposer();
  } catch (e) { toast('spawn failed: ' + e.message); }
}

// ── chat: transcript-as-truth; observe mode for foreign sessions ──
function openSession(machine, remoteId, isMine) {
  if (isMine) {
    selected = { type: 'console', id: remoteId };
    renderFleet(); renderChat(); updateComposer(); return;
  }
  const key = machine + ':' + remoteId;
  if (attached.has(key)) {
    selected = { type: 'console', id: attached.get(key) };
    renderFleet(); renderChat(); updateComposer(); return;
  }
  // Try to ATTACH (works for shared sessions → drivable); a foreign non-shared session
  // is owner-restricted, so attach fails and we fall back to read-only observe.
  api('POST', '/api/attach', { node: machine, remoteId }).then((desc) => {
    attached.set(key, desc.id);
    selected = { type: 'console', id: desc.id };
    renderFleet(); renderChat(); updateComposer();
  }).catch(() => {
    selected = { type: 'observe', node: machine, remoteId };
    renderChat(); updateComposer();
  });
}

async function refreshChat() {
  if (!selected || chatBusy) return;
  chatBusy = true;
  try {
    let view, log = { messages: [] };
    if (selected.type === 'observe') {
      view = await api('GET', `/api/nodes/${selected.node}/sessions/${selected.remoteId}/view`);
    } else {
      view = await api('GET', `/api/sessions/${selected.id}/view`);
      try { log = await api('GET', `/api/sessions/${selected.id}/log`); } catch { /* closed */ }
    }
    const { messages, source, reason } = viewMessages(view, log.messages);
    renderChatMessages(messages, source, reason);
  } catch (e) {
    patch($('#msgs'), h('div.msg system', {}, [t('session unreachable: ' + e.message)]));
  }
  finally { chatBusy = false; }
}

function renderChat() {
  if (!selected) {
    patch($('#msgs'), h('div.chatEmpty', {}, [t('Pick a session (any machine) to chat. Shared sessions attach automatically; foreign ones are viewable read-only.')]));
    return;
  }
  const mode = selected.type === 'observe' ? h('div.dim.chatMode', {}, [t(`OBSERVE — ${selected.node}:${selected.remoteId} is owned by another connection. Read-only (node/view); you cannot send.`)]) : null;
  patch($('#chatMode'), mode || h('span', {}));
  refreshChat();
}

function renderChatMessages(messages, source, reason) {
  const msgs = $('#msgs');
  // Auto-scroll only when already near the bottom — never yank the user's place while
  // they read history (a poll fires every 2.5s; forced scrolling made reading impossible).
  const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  const kids = messages.map((m, i) => h('div.msg ' + m.role + (m.human ? ' human' : ''), { key: i }, [
    h('div.who', {}, [t(`${m.role}${m.human ? ' [human]' : ''}${m.turn ? ' · turn ' + m.turn : ''}`)]),
    t(m.text),
  ]));
  if (sending) kids.push(h('div.msg assistant spin', { key: 'pending' }, [t('…working')]));
  const sourceNote = source === 'log' ? h('div.dim.chatMode', { key: 'src' }, [t(reason)]) : null;
  patch($('#msgs'), h('div', {}, [...(sourceNote ? [sourceNote] : []), ...kids]));
  if (nearBottom || sending) msgs.scrollTop = msgs.scrollHeight;
}

function updateComposer() {
  const enabled = selected && selected.type === 'console';
  for (const id of ['prompt', 'sendBtn', 'goal', 'goalBtn', 'compactBtn', 'closeBtn']) {
    const el = $(id === 'prompt' ? '#prompt' : '#' + id);
    el.disabled = !enabled;
  }
}

async function send() {
  const box = $('#prompt');
  const text = box.value.trim();
  if (!text || !selected || selected.type !== 'console' || sending) return;
  box.value = '';
  sending = true; refreshChat();
  try { await api('POST', `/api/sessions/${selected.id}/send`, { prompt: text }); }
  catch (e) { toast('send failed: ' + e.message); }
  sending = false;
  refreshChat(); refreshFleet();
}

async function closeSess(id) {
  if (!id) return;
  try { await api('POST', `/api/sessions/${id}/close`, {}); } catch {}
  if (selected && selected.type === 'console' && selected.id === id) { selected = null; renderChat(); }
  refreshFleet();
}

async function compactSess() {
  if (!selected || selected.type !== 'console') return;
  try {
    const r = await api('POST', `/api/sessions/${selected.id}/compact`, {});
    toast(r.confirmed ? 'Session compacted in place.' : 'Compact requested; completion not confirmed.', false);
  } catch (e) { toast('compact failed: ' + e.message); }
  refreshChat(); refreshFleet();
}

async function setGoal() {
  if (!selected || selected.type !== 'console') { toast('pick a session first'); return; }
  const condition = $('#goal').value.trim();
  if (!condition) { toast('goal condition required'); return; }
  try {
    await api('POST', `/api/sessions/${selected.id}/goal`, { condition });
    $('#goal').value = '';
    refreshChat(); refreshFleet();
  } catch (e) { toast('set goal failed: ' + e.message); }
}

// ── orphans: crash recovery (continue a surviving session / kill / clear record) ──
async function resumeOrphan(id) {
  try {
    const desc = await api('POST', `/api/orphans/${id}/resume`, {});
    selected = { type: 'console', id: desc.id };
    refreshFleet(); refreshChat(); updateComposer();
  } catch (e) { toast('resume failed: ' + e.message); }
}
async function killOrphan(id) {
  try { await api('POST', `/api/orphans/${id}/kill`, {}); refreshFleet(); }
  catch (e) { toast('kill failed: ' + e.message); }
}
async function clearOrphan(id) {
  try { await api('POST', '/api/reconcile/clear', { id }); refreshFleet(); }
  catch (e) { toast('clear failed: ' + e.message); }
}

// ── wiring ──
$('#reprobe').addEventListener('click', () => loadCatalogue(true));
$('#spawnBtn').addEventListener('click', spawn);
$('#sendBtn').addEventListener('click', send);
$('#goalBtn').addEventListener('click', setGoal);
$('#compactBtn').addEventListener('click', compactSess);
$('#closeBtn').addEventListener('click', () => selected && closeSess(selected.id));
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
$('#goal').addEventListener('keydown', (e) => { if (e.key === 'Enter') setGoal(); });
$('#providerSel').addEventListener('change', fillModels);

loadCatalogue(false);
refreshFleet();
setInterval(refreshFleet, 6000);
setInterval(refreshChat, 2500);
renderChat();
