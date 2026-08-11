// web/public/main.js — the console's orchestration: polling, hash-routed views, the one
// delegated click dispatcher, toasts (never alert()), and the transcript-as-truth chat.
// Rendering is declarative via render.js; all derivation lives in state.js. No state is
// invented here — the DOM is a projection of fabric facts (fleet, catalogue, views).
//
// Views follow the operator's funnel: FLEET (is anything wrong?) → SESSIONS (browse by
// machine/project) → CHAT (work with one session, full width). Each stage gets the whole
// screen because attention narrows monotonically; the header health dot keeps ambient
// awareness while chatting. Filters (selMachine/selProject) survive view switches.
//
// Scope, honestly stated: sessions this console spawned or attached are drivable;
// a foreign peer session (owned by another connection, not shared) is read-only —
// node/view is visibility, not acting — so clicking it opens OBSERVE mode with the
// composer disabled and the reason shown, instead of an unexplained disabled button.

import { h, t, patch } from "./render.js";
import { viewMessages, aggregateFleet, sessionsOf, projectsOf, canDrive, sessionKey, contextStatus, machineWarnings, attentionItems, compareMachines, fleetHealth, CTX_WARN_PCT } from "./state.js";
import { fmtUptime, fmtMem, fmtAgo } from "/lib/format.mjs";

const $ = (s) => document.querySelector(s);
let fleet = [], orphans = [], catalogue = { providers: [], efforts: [], defaults: null };
let selMachine = null, selProject = null;
// selected = { type:'console', id } | { type:'observe', node, remoteId }
let selected = null;
let sending = false, fleetAt = 0, attn = [];
let view = 'fleet';
const collapsed = new Set(); // machine groups the operator collapsed in Sessions view
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
const selfName = () => fleet.find((m) => m.self)?.name ?? null;

// ── toasts: errors are system facts, shown in a status strip — never a modal ──
const toast = (msg, bad = true) => {
  const strip = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  strip.appendChild(el);
  setTimeout(() => el.remove(), 5000);
};

// ── one delegated dispatcher for every click, change and Enter — handlers are stable
// across patches (patch never touches listeners; skeletons re-mount per view entry) ──
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action, d = el.dataset;
  if (a === 'goto') {
    if (d.machine != null) { selMachine = d.machine; selProject = null; }
    setView(d.view);
  }
  else if (a === 'pick-machine') {
    if (view === 'fleet') { selMachine = d.name; selProject = null; setView('sessions'); }
    else { selMachine = selMachine === d.name ? null : d.name; selProject = null; renderSessionsView(); }
  }
  else if (a === 'pick-project') { selProject = selProject === d.project ? null : d.project; renderSessionsView(); }
  else if (a === 'clear-filter') {
    if (d.kind === 'machine') { selMachine = null; selProject = null; } else selProject = null;
    renderSessionsView();
  }
  else if (a === 'toggle-collapse') {
    e.stopPropagation();
    if (collapsed.has(d.name)) collapsed.delete(d.name); else collapsed.add(d.name);
    renderSessionsView();
  }
  else if (a === 'open') openSession(d.node, d.id, d.chattable === '1');
  else if (a === 'close-sess') { e.stopPropagation(); closeSess(d.id); }
  else if (a === 'orphan-resume') resumeOrphan(d.id);
  else if (a === 'orphan-kill') killOrphan(d.id);
  else if (a === 'orphan-clear') clearOrphan(d.id);
  else if (a === 'spawn') spawn();
  else if (a === 'send') send();
  else if (a === 'goal') setGoal();
  else if (a === 'compact') compactSess();
  else if (a === 'close-chat') { if (selected) closeSess(selected.id); }
  else if (a === 'reprobe') loadCatalogue(true);
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'providerSel') fillModels();
  else if (e.target.id === 'machineSel') fillSpawnProjects();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'prompt') send();
  else if (e.target.id === 'goal') setGoal();
});

// ── view routing: hash is the place memory, so refresh and the browser Back button
// land where the operator left off ──
const VIEWS = ['fleet', 'sessions', 'chat'];
function setView(v, { pushHash = true } = {}) {
  if (!VIEWS.includes(v)) v = 'fleet';
  view = v;
  if (pushHash && location.hash !== '#/' + v) location.hash = '#/' + v;
  document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('sel', b.dataset.view === v));
  renderView();
}
window.addEventListener('hashchange', () => {
  const v = location.hash.replace(/^#\//, '');
  if (v !== view) setView(v, { pushHash: false });
});

// A view's skeleton mounts ONCE per entry; polls then patch sub-containers by id, so
// an open dropdown, a half-typed prompt and the scroll position all survive.
function mountView(vnode) { const el = $('#view'); el._v = null; patch(el, vnode); }
function renderView() {
  if (view === 'fleet') { mountView(fleetSkeleton()); renderFleetView(); }
  else if (view === 'sessions') {
    mountView(sessionsSkeleton());
    fillCatalogueUI(); fillSpawnMachines(); renderSessionsView();
  } else {
    mountView(chatSkeleton());
    renderChatTop(); renderChat(); updateComposer();
  }
}

// ── header: health dot · fleet totals · tab badges · as-of staleness ──
function renderHeader() {
  const agg = aggregateFleet(fleet);
  const health = fleetHealth(attn);
  patch($('#healthDot'), h('span.dot ' + health, {
    title: health === 'ok' ? 'fleet healthy' : `${attn.length} item(s) need attention — see the Fleet view`,
  }, [t('●')]));
  patch($('#headerStats'),
    h('span', {}, [t(`${agg.alive}/${agg.total} machines · ${agg.sessions} session(s) · spend ${fmtCost(agg.cost)}`)]));
  patch($('#tabAttn'), h('span', {}, [t(attn.length ? String(attn.length) : '')]));
  patch($('#asOf'), h('span', { class: 'dim' }, [t(fleetAt ? 'as of ' + new Date(fleetAt).toLocaleTimeString() : 'probing…')]));
}

// ── catalogue: live-probed identity; the UI never invents a model name ──
function fillModels() {
  const p = catalogue.providers.find((x) => x.name === $('#providerSel')?.value);
  if (!$('#providerSel')) return;
  const opts = (p?.models || []).map((m) => `<option value="${m.alias}">${m.alias} → ${m.actual}</option>`).join('')
    || (p ? `<option value="">${p.name} built-in default</option>` : '');
  $('#modelSel').innerHTML = opts;
  $('#providerIdent').textContent = p
    ? `${p.name}${p.version ? ' ' + p.version : ''} — ${p.identity}${p.available ? '' : ' (UNAVAILABLE)'}`
    : '';
}
// (Re)fill the spawn form's catalogue-driven selects. Safe to call on every view entry:
// it only touches the DOM when the selects exist (Sessions view).
function fillCatalogueUI() {
  if (!$('#providerSel')) return;
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
  renderCatLine();
}
function renderCatLine() {
  if (!$('#catLine')) return;
  patch($('#catLine'), h('span.dim', {}, [
    t(catalogue.probed_at ? 'catalogue probed ' + new Date(catalogue.probed_at).toLocaleTimeString() + ' ' : 'catalogue probing… '),
    h('button', { id: 'reprobe', 'data-action': 'reprobe' }, [t('⟳ re-probe')]),
  ]));
}
async function loadCatalogue(force) {
  const b = $('#reprobe');
  if (force && b) { b.disabled = true; b.classList.add('spin'); }
  try {
    catalogue = await api('GET', '/api/catalogue' + (force ? '?force=1' : ''));
    fillCatalogueUI();
  } catch (e) { toast('catalogue: ' + e.message); }
  finally { if (b) { b.disabled = false; b.classList.remove('spin'); } }
}

// ══ FLEET view: needs-attention first, then every machine as a compact grid card ══
const fleetSkeleton = () => h('section.fleetView', { key: 'fleet' }, [
  h('h2', { key: 'a' }, [t('Needs attention')]),
  h('div', { key: 'b', attrs: { id: 'attention' } }, []),
  h('h2', { key: 'c' }, [t('Machines')]),
  h('div', { key: 'd', attrs: { id: 'machineGrid' } }, []),
]);

function renderFleetView() {
  if (view !== 'fleet' || !$('#attention')) return;
  patch($('#attention'), attnList());
  patch($('#machineGrid'), h('div.grid', {}, [...fleet].sort(compareMachines).map(gridCard)));
}

function attnList() {
  if (!fleetAt) return h('div.attnEmpty', {}, [t('probing the fleet…')]);
  if (!attn.length) return h('div.attnEmpty', {}, [t('All clear — no machine, session, or orphan needs attention.')]);
  return h('div', {}, attn.map((i, ix) => h('div.attnRow ' + i.severity, { key: ix }, [
    h('span.attnIcon', {}, [t(i.severity === 'bad' ? '●' : '⚠')]),
    h('span.attnText', {}, [t(i.text)]),
    h('span.attnAct', {}, attnButtons(i)),
  ])));
}
function attnButtons(i) {
  // ctx → jump straight into the chat; everything else → the Sessions view, filtered.
  // The id/chattable derivation mirrors sessRow exactly (a shared-but-unattached
  // session must go through openSession's attach path, never pose as a console id).
  if (i.kind === 'ctx' && i.session) {
    const s = i.session, key = sessionKey(i.machine, s);
    const mine = s.chattable || attached.has(key);
    const id = s.chattable ? s.id : (mine ? attached.get(key) : (s.nativeId ?? s.id));
    return [h('button', { 'data-action': 'open', 'data-node': i.machine, 'data-id': id, 'data-chattable': mine ? '1' : '0' }, [t('open chat')])];
  }
  return [h('button', { 'data-action': 'goto', 'data-view': 'sessions', 'data-machine': i.machine }, [t('view sessions')])];
}

function gridCard(m) {
  const warns = machineWarnings(m);
  if (!m.alive) {
    return h('div.mcard dead', { key: m.name, 'data-action': 'goto', 'data-view': 'sessions', 'data-machine': m.name }, [
      h('div.row', {}, [h('b', {}, [t(m.name)]), h('span.bad', {}, [t('●')])]),
      h('span.dim', {}, [t(m.error || 'dead')]),
    ]);
  }
  const n = sessionsOf(m).length;
  const stats = [`cpu ${m.cpu_busy_pct ?? '?'}%`, `mem ${fmtMem(m.mem_available_mb)} free`, `up ${fmtUptime(m.uptime_s)}`, `${n} sess`].join(' · ');
  return h('div.mcard click' + (warns.length ? ' warn' : ''), {
    key: m.name, 'data-action': 'pick-machine', 'data-name': m.name,
    title: `v${m.version ?? '?'} · ${m.cpu ?? '?'} cores · ${fmtMem(m.mem_total_mb)} total${m.tags?.length ? ' · ' + m.tags.join(', ') : ''}`,
  }, [
    h('div.row', {}, [
      h('b', {}, [t(m.name)]),
      h('span', {}, [...(m.self ? [h('span.badge self', {}, [t('this machine')])] : []), h('span.ok', {}, [t('●')])]),
    ]),
    h('span.dim', {}, [t(stats)]),
    ...(warns.length ? [h('div.warnBadges', {}, warns.map((w) => h('span.badge warn', { key: w }, [t(w)])))] : []),
  ]);
}

// ══ SESSIONS view: full-width browse — collapsible machine groups, dense session rows ══
const sessionsSkeleton = () => h('section.sessionsView', { key: 'sessions' }, [
  h('div', { key: 'chips', attrs: { id: 'chips' } }, []),
  h('details', { key: 'spawn', attrs: { id: 'spawnDrawer' } }, [
    h('summary', { key: 's' }, [t('+ New session')]),
    h('form.card', { key: 'f', attrs: { id: 'spawnForm', onsubmit: 'return false' } }, [
      h('div.inline', { key: 'r1' }, [
        h('div', {}, [h('label', {}, [t('machine')]), h('select', { id: 'machineSel', name: 'machine' }, [])]),
        h('div', {}, [h('label', {}, [t('project')]), h('select', { id: 'projectSel', name: 'project' }, [])]),
      ]),
      h('div.inline', { key: 'r2' }, [
        h('div', {}, [h('label', {}, [t('provider')]), h('select', { id: 'providerSel', name: 'provider' }, [])]),
        h('div', {}, [h('label', {}, [t('model')]), h('select', { id: 'modelSel', name: 'model' }, [])]),
      ]),
      h('div.inline', { key: 'r3' }, [
        h('div', {}, [h('label', {}, [t('effort')]), h('select', { id: 'effortSel', name: 'effort' }, [])]),
        h('div', {}, []),
      ]),
      h('div.dim', { key: 'pi', attrs: { id: 'providerIdent' } }, []),
      h('details', { key: 'more' }, [
        h('summary', {}, [t('more (profile · flags)')]),
        h('label', {}, [t('profile')]),
        h('input', { name: 'profile', placeholder: 'named profile on the target node' }, []),
        h('div.inline', {}, [
          h('label', {}, [h('input', { type: 'checkbox', name: 'write', style: 'width:auto' }, []), t(' write')]),
          h('label', {}, [h('input', { type: 'checkbox', name: 'visible', style: 'width:auto' }, []), t(' visible')]),
          h('label', {}, [h('input', { type: 'checkbox', name: 'interactive', style: 'width:auto' }, []), t(' interactive')]),
        ]),
      ]),
      h('button.primary', { key: 'sb', attrs: { id: 'spawnBtn', type: 'button', 'data-action': 'spawn' } }, [t('Spawn session')]),
      h('div', { key: 'cl', attrs: { id: 'catLine' } }, []),
    ]),
  ]),
  h('div', { key: 'tree', attrs: { id: 'sessTree' } }, []),
]);

function renderSessionsView() {
  if (view !== 'sessions' || !$('#sessTree')) return;
  patch($('#chips'), chipsVnode());
  renderSessionsTree();
}

function chipsVnode() {
  const parts = [];
  if (selMachine) parts.push(h('span.chip', { key: 'm' }, [
    t('machine: ' + selMachine + ' '), h('button', { 'data-action': 'clear-filter', 'data-kind': 'machine' }, [t('×')])]));
  if (selProject) parts.push(h('span.chip', { key: 'p' }, [
    t('project: ' + selProject + ' '), h('button', { 'data-action': 'clear-filter', 'data-kind': 'project' }, [t('×')])]));
  const shown = fleet.filter((m) => !selMachine || m.name === selMachine);
  const nSess = shown.reduce((n, m) => n + sessionsOf(m).filter((s) => !selProject || s.project === selProject).length, 0);
  parts.push(h('span.dim chipsSummary', { key: 'sum' }, [t(`${shown.length} machine(s) · ${nSess} session(s) shown`)]));
  return h('div.chipsRow', {}, parts);
}

const colHeader = () => h('div.srow shead', { key: 'hdr' }, [
  h('span.c dot', {}, [t('')]),
  h('span.c id', {}, [t('session')]),
  h('span.c ident', {}, [t('provider · model · effort')]),
  h('span.c turns', {}, [t('turns')]),
  h('span.c ctx', {}, [t('context')]),
  h('span.c cost', {}, [t('cost')]),
  h('span.c age', {}, [t('active')]),
  h('span.c act', {}, [t('')]),
]);

function renderSessionsTree() {
  const machines = fleet.filter((m) => !selMachine || m.name === selMachine);
  if (!machines.length) {
    patch($('#sessTree'), h('div.dim padEmpty', {}, [t(fleet.length ? 'no machine matches the filter' : 'no machines configured — is the node server up?')]));
    return;
  }
  // Orphans live under the machine they belong to (their node, else this machine).
  const sn = selfName();
  const orphansByMachine = new Map();
  for (const x of orphans) {
    const mn = x.node ?? sn ?? 'this machine';
    if (!orphansByMachine.has(mn)) orphansByMachine.set(mn, []);
    orphansByMachine.get(mn).push(x);
  }
  const anySessions = machines.some((m) => m.alive && sessionsOf(m).length);
  patch($('#sessTree'), h('div', {}, [
    ...(anySessions ? [colHeader()] : []),
    ...machines.map((m) => machineGroup(m, orphansByMachine.get(m.name) || [])),
  ]));
}

function machineGroup(m, mOrphans) {
  const isDead = !m.alive;
  const sess = isDead ? [] : sessionsOf(m);
  const warns = machineWarnings(m);
  const head = h('div.mhead' + (selMachine === m.name ? ' sel' : ''), { key: 'h', 'data-action': 'pick-machine', 'data-name': m.name }, [
    h('span.tog', { 'data-action': 'toggle-collapse', 'data-name': m.name }, [t(collapsed.has(m.name) ? '▸' : '▾')]),
    h('b', {}, [t(m.name)]),
    ...(m.self ? [h('span.badge self', {}, [t('this machine')])] : []),
    ...(isDead ? [h('span.badge bad', {}, [t('DEAD')])] : warns.map((w) => h('span.badge warn', { key: w }, [t(w)]))),
    h('span.dim mstats', {}, [isDead ? t(m.error || 'dead')
      : t(`${sess.length} sess · cpu ${m.cpu_busy_pct ?? '?'}% · mem ${fmtMem(m.mem_available_mb)} free · up ${fmtUptime(m.uptime_s)}`)]),
  ]);
  if (isDead || collapsed.has(m.name)) return h('div.mgroup', { key: 'g:' + m.name }, [head]);
  const projects = projectsOf(m).filter((p) => !selProject || p === selProject);
  const noProj = sess.filter((s) => !s.project);
  const byProj = (p) => sess.filter((s) => s.project === p);
  const body = [];
  for (const p of projects) {
    body.push(h('div.proj' + (selProject === p ? ' sel' : ''), { key: 'p:' + p, 'data-action': 'pick-project', 'data-project': p }, [
      h('span', {}, [t('📁 ' + p)]), h('span.dim', {}, [t(byProj(p).length + ' session(s)')]),
    ]));
    body.push(...byProj(p).map((s) => sessRow(s, m)));
  }
  if (!selProject && noProj.length) {
    // Name the reason: attached handles have no recorded location; cwd-bearing
    // sessions run outside every registered project alias.
    const allAttached = noProj.every((s) => s.provider === 'attached');
    body.push(h('div.proj', { key: 'p:(none)' }, [
      h('span', {}, [t(allAttached ? '📁 attached — no project recorded' : '📁 (no project)')]),
      h('span.dim', {}, [t(String(noProj.length))]),
    ]));
    body.push(...noProj.map((s) => sessRow(s, m)));
  }
  if (!projects.length && !noProj.length) body.push(h('div.dim emptyGrp', { key: 'empty' }, [t('no sessions')]));
  body.push(...orphansBlock(m, mOrphans));
  return h('div.mgroup', { key: 'g:' + m.name }, [head, ...body]);
}

// A session as ONE dense row — facts sit in columns so a hundred of them stay scannable.
function sessRow(s, machine) {
  const key = sessionKey(machine.name, s);
  const mine = s.chattable || attached.has(key);
  const drive = canDrive({ ...s, key }, attached);
  const consoleId = s.chattable ? s.id : attached.get(key);
  const sel = selected && (selected.type === 'console' ? selected.id === consoleId : selected.type === 'observe' && selected.remoteId === s.nativeId && selected.node === machine.name);
  const ident = [s.provider, s.model, s.effort].filter(Boolean).join(' · ');
  // Context occupancy: a bar + percentage when the model's window is known, else raw
  // tokens. After a native compact the % drops. ↻N marks how many compacts happened.
  const { used, limit, pct, compacted } = contextStatus(s);
  const ctxCell = pct != null
    ? h('span.ctxbar', { title: `context ${fmtTokens(used)} / ${fmtTokens(limit)}${compacted ? ` · compacted ×${compacted}` : ''}` }, [
        h('span.track', {}, [h('span.fill' + (pct >= CTX_WARN_PCT ? ' hot' : ''), { style: `width:${pct}%` }, [])]),
        h('span.ctxpct', {}, [t(pct + '%' + (compacted ? ' ↻' + compacted : ''))]),
      ])
    : h('span.dim', {}, [t(used != null ? fmtTokens(used) : '')]);
  // Honest "why no project": an attached handle on an OLD peer records no location.
  const loc = !s.project
    ? (s.provider === 'attached' && !s.cwd ? 'attached handle' : (s.cwd ? 'cwd ' + s.cwd.split(/[\\/]/).filter(Boolean).pop() : ''))
    : '';
  return h('div.srow' + (sel ? ' sel' : ''), {
    key: 's:' + key,
    'data-action': 'open', 'data-node': machine.name,
    // Mine → the console session id (drives /api/sessions/:id). Foreign → the peer's
    // id, used to attach (shared) or observe (non-shared).
    'data-id': mine ? s.id : (s.nativeId ?? s.id),
    'data-chattable': mine ? '1' : '0',
    title: [s.cwd, drive ? '' : 'owned by another connection — view only'].filter(Boolean).join(' — '),
  }, [
    h('span.c dot', {}, [h('span', { class: s.alive === false ? 'bad' : 'ok' }, [t('●')])]),
    h('span.c id', {}, [t(s.id), ...(s.shared ? [h('span.badge shared', {}, [t('shared')])] : [])]),
    h('span.c ident', {}, [t(ident + (loc ? ' · ' + loc : ''))]),
    h('span.c turns', {}, [t(String(s.turns ?? 0))]),
    h('span.c ctx', {}, [ctxCell]),
    h('span.c cost', {}, [t(s.usage?.cost_usd ? fmtCost(s.usage.cost_usd) : '')]),
    h('span.c age dim', {}, [t(s.lastActivity ? fmtAgo(s.lastActivity) : '')]),
    h('span.c act', {}, [
      ...(drive ? [] : [h('span.badge', { title: 'owned by another connection — view only' }, [t('view-only')])]),
      ...(mine ? [h('button', { 'data-action': 'close-sess', 'data-id': consoleId }, [t('close')])] : []),
    ]),
  ]);
}

function orphansBlock(machine, list) {
  if (!list.length) return [];
  return [h('div', { key: 'o:' + machine.name }, [
    h('div.orphanHead', {}, [t(`⚠ ${list.length} unaccounted session(s)`)]),
    ...list.map((x) => h('div.card', { key: 'oo:' + x.id }, [
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

// ── spawn: the form names its machine + project explicitly (scale: no pre-filter
// needed). Selects refill on poll only when their option set actually changed, so an
// open dropdown is never yanked ──
function fillSpawnMachines() {
  const sel = $('#machineSel');
  if (!sel) return;
  const alive = fleet.filter((m) => m.alive);
  const sig = alive.map((m) => m.name).join(',');
  if (sel.dataset.sig === sig) return;
  const cur = sel.value;
  const want = alive.some((m) => m.name === cur) ? cur
    : (selMachine ?? alive.find((m) => m.self)?.name ?? alive[0]?.name);
  sel.dataset.sig = sig;
  sel.innerHTML = alive.map((m) =>
    `<option value="${m.name}" ${m.name === want ? 'selected' : ''}>${m.name}${m.self ? ' (this machine)' : ''}</option>`).join('');
  fillSpawnProjects();
}
function fillSpawnProjects() {
  const m = fleet.find((x) => x.name === $('#machineSel')?.value);
  const sel = $('#projectSel');
  if (!sel) return;
  const cur = sel.value;
  const projs = m?.projects || [];
  const want = projs.includes(cur) ? cur : (selProject && projs.includes(selProject) ? selProject : projs[0]);
  sel.innerHTML = projs.map((p) => `<option ${p === want ? 'selected' : ''}>${p}</option>`).join('')
    || '<option value="" disabled>no projects registered on this node</option>';
}
async function spawn() {
  const f = new FormData($('#spawnForm'));
  const v = (k) => (f.get(k) || '').toString().trim() || undefined;
  const machine = v('machine');
  if (!machine) { toast('pick a machine first'); return; }
  try {
    const desc = await api('POST', '/api/sessions', {
      provider: v('provider'), model: v('model'), effort: v('effort'),
      node: machine, project: v('project'),
      profile: v('profile'),
      write: f.get('write') === 'on', visible: f.get('visible') === 'on', interactive: f.get('interactive') === 'on',
    });
    selected = { type: 'console', id: desc.id };
    setView('chat');
    refreshFleet();
  } catch (e) { toast('spawn failed: ' + e.message); }
}

// ══ CHAT view: full-width focus. Breadcrumb + facts on top; the fleet health dot in
// the header keeps ambient awareness without panels ══
const chatSkeleton = () => h('section.chatView', { key: 'chat' }, [
  h('div', { key: 'top', attrs: { id: 'chatTop' } }, []),
  h('div', { key: 'mode', attrs: { id: 'chatMode' } }, []),
  h('div', { key: 'msgs', attrs: { id: 'msgs' } }, []),
  h('div', { key: 'gr', attrs: { id: 'goalrow' } }, [
    h('input', { id: 'goal', placeholder: 'goal condition, e.g. done when all tests pass (the session works until met)' }, []),
    h('button', { id: 'goalBtn', 'data-action': 'goal', title: 'Set the goal; the next Send runs the autonomous loop to its final outcome' }, [t('set goal')]),
  ]),
  h('div', { key: 'cp', attrs: { id: 'composer' } }, [
    h('input', { id: 'prompt', placeholder: 'message… (Enter to send)', autocomplete: 'off' }, []),
    h('button.primary', { id: 'sendBtn', 'data-action': 'send' }, [t('Send')]),
    h('button', { id: 'compactBtn', 'data-action': 'compact', title: "Compact this session's context in place (codex native; same id continues)" }, [t('compact')]),
    h('button', { id: 'closeBtn', 'data-action': 'close-chat', title: 'Close this session' }, [t('close')]),
  ]),
]);

// The session the chat is showing, looked up in the current fleet facts (for the top
// bar's live facts). Null when it vanished (closed, or the peer went dark).
function findSelected() {
  if (!selected) return null;
  for (const m of fleet) {
    for (const s of sessionsOf(m)) {
      if (selected.type === 'console') {
        const cid = s.chattable ? s.id : attached.get(sessionKey(m.name, s));
        if (cid && cid === selected.id) return { machine: m, session: s };
      } else if (s.nativeId === selected.remoteId && m.name === selected.node) {
        return { machine: m, session: s };
      }
    }
  }
  return null;
}

function renderChatTop() {
  const el = $('#chatTop');
  if (!el) return;
  const back = h('button', { key: 'back', 'data-action': 'goto', 'data-view': 'sessions', title: 'back to the session list (filters kept)' }, [t('← Sessions')]);
  if (!selected) {
    patch(el, h('div.chatTopRow', {}, [back, h('span.dim', { key: 'x' }, [t('no session selected')])]));
    return;
  }
  const found = findSelected();
  const idStr = selected.type === 'console' ? selected.id : `${selected.node}:${selected.remoteId}`;
  if (!found) {
    patch(el, h('div.chatTopRow', {}, [back, h('b', { key: 'id' }, [t(idStr)]),
      h('span.dim', { key: 'x' }, [t('— not in the current fleet view (closed?)')])]));
    return;
  }
  const { machine: m, session: s } = found;
  const { used, pct, compacted } = contextStatus(s);
  const facts = [
    [s.provider, s.model, s.effort].filter(Boolean).join(' · '),
    pct != null ? `ctx ${pct}%` : (used != null ? `ctx ${fmtTokens(used)}` : ''),
    compacted ? `↻${compacted}` : '',
    `turns ${s.turns ?? 0}`,
    s.usage?.cost_usd ? fmtCost(s.usage.cost_usd) : '',
    s.pid ? `pid ${s.pid}` : '',
  ].filter(Boolean).join(' · ');
  patch(el, h('div.chatTopRow', {}, [
    back,
    h('b', { key: 'id' }, [t([m.name, s.project, s.id].filter(Boolean).join(' / '))]),
    h('span.dim', { key: 'f' }, [t(facts)]),
    h('span', { key: 'd', class: s.alive === false ? 'bad' : 'ok' }, [t('●')]),
  ]));
}

// ── chat: transcript-as-truth; observe mode for foreign sessions ──
function openSession(machine, remoteId, isMine) {
  if (isMine) {
    selected = { type: 'console', id: remoteId };
    setView('chat');
    return;
  }
  const key = machine + ':' + remoteId;
  if (attached.has(key)) {
    selected = { type: 'console', id: attached.get(key) };
    setView('chat');
    return;
  }
  // Try to ATTACH (works for shared sessions → drivable); a foreign non-shared session
  // is owner-restricted, so attach fails and we fall back to read-only observe.
  api('POST', '/api/attach', { node: machine, remoteId }).then((desc) => {
    attached.set(key, desc.id);
    selected = { type: 'console', id: desc.id };
    setView('chat');
  }).catch(() => {
    selected = { type: 'observe', node: machine, remoteId };
    setView('chat');
  });
}

async function refreshChat() {
  if (!selected || chatBusy || view !== 'chat') return;
  chatBusy = true;
  try {
    let viewData, log = { messages: [] };
    if (selected.type === 'observe') {
      viewData = await api('GET', `/api/nodes/${selected.node}/sessions/${selected.remoteId}/view`);
    } else {
      viewData = await api('GET', `/api/sessions/${selected.id}/view`);
      try { log = await api('GET', `/api/sessions/${selected.id}/log`); } catch { /* closed */ }
    }
    const { messages, source, reason } = viewMessages(viewData, log.messages);
    renderChatMessages(messages, source, reason);
  } catch (e) {
    if ($('#msgs')) patch($('#msgs'), h('div.msg system', {}, [t('session unreachable: ' + e.message)]));
  }
  finally { chatBusy = false; }
}

function renderChat() {
  if (!$('#msgs')) return;
  if (!selected) {
    patch($('#msgs'), h('div.chatEmpty', {}, [t('Pick a session (any machine) to chat. Shared sessions attach automatically; foreign ones are viewable read-only.')]));
  }
  const mode = selected?.type === 'observe'
    ? h('div.dim chatMode', {}, [t(`OBSERVE — ${selected.node}:${selected.remoteId} is owned by another connection. Read-only (node/view); you cannot send.`)])
    : h('span', {});
  if ($('#chatMode')) patch($('#chatMode'), mode);
  refreshChat();
}

function renderChatMessages(messages, source, reason) {
  const msgs = $('#msgs');
  if (!msgs) return;
  // Auto-scroll only when already near the bottom — never yank the user's place while
  // they read history (a poll fires every 2.5s; forced scrolling made reading impossible).
  const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  const kids = messages.map((m, i) => h('div.msg ' + m.role + (m.human ? ' human' : ''), { key: i }, [
    h('div.who', {}, [t(`${m.role}${m.human ? ' [human]' : ''}${m.turn ? ' · turn ' + m.turn : ''}`)]),
    t(m.text),
  ]));
  if (sending) kids.push(h('div.msg assistant spin', { key: 'pending' }, [t('…working')]));
  const sourceNote = source === 'log' ? h('div.dim chatMode', { key: 'src' }, [t(reason)]) : null;
  patch(msgs, h('div', {}, [...(sourceNote ? [sourceNote] : []), ...kids]));
  if (nearBottom || sending) msgs.scrollTop = msgs.scrollHeight;
}

function updateComposer() {
  const enabled = !!(selected && selected.type === 'console');
  for (const id of ['prompt', 'sendBtn', 'goal', 'goalBtn', 'compactBtn', 'closeBtn']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

async function send() {
  const box = $('#prompt');
  const text = box?.value.trim();
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
  if (selected && selected.type === 'console' && selected.id === id) {
    selected = null;
    if (view === 'chat') { renderChatTop(); renderChat(); updateComposer(); }
  }
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
    setView('chat');
    refreshFleet();
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

// ── fleet poll: the one clock that drives the header and the active view ──
async function refreshFleet() {
  if (fleetBusy) return; // a slow peer must not stack overlapping polls
  fleetBusy = true;
  try {
    fleet = await api('GET', '/api/fleet'); fleetAt = Date.now();
    orphans = await api('GET', '/api/reconcile');
    attn = attentionItems(fleet, orphans, selfName());
    renderHeader();
    if (view === 'fleet') renderFleetView();
    else if (view === 'sessions') { fillSpawnMachines(); renderSessionsView(); }
    else if (view === 'chat') renderChatTop();
  } catch (e) { toast('fleet: ' + e.message); }
  finally { fleetBusy = false; }
}

// ── wiring: boot on the hash's view, then poll ──
const initial = location.hash.replace(/^#\//, '');
setView(VIEWS.includes(initial) ? initial : 'fleet', { pushHash: false });
loadCatalogue(false);
refreshFleet();
setInterval(refreshFleet, 6000);
setInterval(refreshChat, 2500);
