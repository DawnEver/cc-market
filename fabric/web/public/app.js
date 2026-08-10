const $ = (s) => document.querySelector(s);
let fleet = [], catalogue = { providers: [], nodes: [], efforts: [] };
let selMachine = null, selProject = null, selected = null, sending = false;
const attached = new Map(); // remote `${node}:${id}` → console session id

const api = async (method, path, body) => {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' },
                                body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ── catalogue: live-probed identity; the UI never invents a model name ──
function fillModels() {
  const p = catalogue.providers.find((x) => x.name === $('#providerSel').value);
  // Every axis is EXPLICIT: no "default" escapes. codex has no alias table, so its one
  // honest option is its own named default.
  $('#modelSel').innerHTML =
    (p?.models || []).map((m) => `<option value="${m.alias}">${m.alias} → ${esc(m.actual)}</option>`).join('') ||
    (p ? `<option value="">${p.name} built-in default</option>` : '');
  $('#providerIdent').textContent = p ? `${p.name}${p.version ? ' ' + p.version : ''} — ${p.identity}${p.available ? '' : ' (UNAVAILABLE)'}` : '';
}
async function loadCatalogue(force) {
  try {
    catalogue = await api('GET', '/api/catalogue' + (force ? '?force=1' : ''));
    $('#catAge').textContent = 'catalogue probed ' + new Date(catalogue.probed_at).toLocaleTimeString();
    $('#providerSel').innerHTML = catalogue.providers.map((p) =>
      `<option value="${p.name}" ${p.available ? '' : 'disabled'}>${p.name}${p.available ? '' : ' (unavailable)'}</option>`).join('');
    const firstOk = catalogue.providers.find((p) => p.available && p.name === 'deepseek') || catalogue.providers.find((p) => p.available);
    if (firstOk) $('#providerSel').value = firstOk.name;
    fillModels();
    const withHaiku = catalogue.providers.find((p) => p.name === $('#providerSel').value)?.models.some((m) => m.alias === 'haiku');
    if (withHaiku) $('#modelSel').value = 'haiku';
    $('#effortSel').innerHTML =
      catalogue.efforts.map((e) => `<option value="${e.name}" ${e.name === 'medium' ? 'selected' : ''}>${e.name} (${e.tokens} tk)</option>`).join('');
  } catch (e) { console.error('catalogue', e); }
}

// ── fleet: Machine → Project → Session; selection is a FILTER, never navigation ──
async function refreshFleet() {
  try { fleet = await api('GET', '/api/fleet'); } catch (e) { $('#machines').textContent = e.message; return; }
  const alive = fleet.filter((m) => m.alive);
  const nSess = alive.reduce((a, m) => a + (m.sessions?.length ?? 0) + (m.console_sessions?.length ?? 0), 0);
  $('#fleetSummary').textContent = `${alive.length}/${fleet.length} machines · ${nSess} session(s)`;
  $('#machines').innerHTML = fleet.map((m) => m.alive ? `
    <div class="card click ${selMachine === m.name ? 'sel' : ''}" onclick="pickMachine('${m.name}')">
      <div class="row"><b>${m.name}</b>
        <span>${m.self ? '<span class="badge self">this machine</span>' : ''} <span class="ok">●</span></span></div>
      <span class="dim">v${esc(m.version)} · cpu ${m.cpu} · free ${m.mem_available_mb} MB · up ${m.uptime_s}s
      · ${(m.sessions?.length ?? 0) + (m.console_sessions?.length ?? 0)} sess${m.tags?.length ? ' · ' + m.tags.join(',') : ''}</span>
    </div>` : `
    <div class="card"><div class="row"><b>${m.name}</b><span class="bad">●</span></div>
      <span class="dim">${esc(m.error || 'dead')}</span></div>`).join('');
  renderTree();
  refreshOrphans();
}

function pickMachine(n) { selMachine = selMachine === n ? null : n; selProject = null; refreshFleet(); updateSpawnWhere(); }
function pickProject(p) { selProject = selProject === p ? null : p; renderTree(); updateSpawnWhere(); }
function updateSpawnWhere() {
  $('#spawnWhere').textContent = '→ ' + (selMachine ?? 'pick a machine') + (selProject ? ' / ' + selProject : '');
  const mch = fleet.find((m) => m.name === selMachine);
  // No "(node default)" escape: a session always lands in a NAMED project. First
  // alias is the default; the current filter wins when one is selected.
  $('#projectSel').innerHTML =
    (mch?.projects || []).map((p, i) => `<option ${p === (selProject ?? mch.projects[0]) ? 'selected' : ''}>${p}</option>`).join('') ||
    '<option value="" disabled>no projects registered on this node</option>';
}

function sessCard(s, machine) {
  const key = machine + ':' + (s.nativeId ?? s.id);
  const mine = s.chattable || attached.has(key);
  const consoleId = s.chattable ? s.id : attached.get(key);
  const isSel = selected && consoleId === selected;
  const canChat = mine || s.shared;
  return `<div class="card ${canChat ? 'click' : ''} ${isSel ? 'sel' : ''}"
      ${canChat ? `onclick="openChat('${machine}','${s.id}','${consoleId ?? ''}',${!!s.chattable})"` : ''}>
    <div class="row"><b>${s.id}</b><span>
      ${s.shared ? '<span class="badge shared">shared</span>' : ''}
      <span class="${s.alive === false ? 'bad' : 'ok'}">●</span></span></div>
    <span class="dim">${s.provider}${s.pid ? ' · pid ' + s.pid : ''} · turns ${s.turns}
      ${s.usage?.cost_usd ? ' · $' + s.usage.cost_usd.toFixed(3) : ''}</span>
    ${canChat ? '' : '<div class="dim">owned by another connection — spawn shared to allow cross-console driving</div>'}
    ${mine ? `<div class="row" style="margin-top:4px"><button onclick="event.stopPropagation();closeSess('${consoleId}')">close</button></div>` : ''}
  </div>`;
}

function renderTree() {
  const machines = fleet.filter((m) => m.alive && (!selMachine || m.name === selMachine));
  if (!machines.length) { $('#tree').innerHTML = '<span class="dim">no machine selected/alive</span>'; return; }
  $('#tree').innerHTML = machines.map((m) => {
    const remote = (m.sessions || []).filter((s) => !(m.console_sessions || []).some((c) => c.nativeId === s.id));
    const all = [...(m.console_sessions || []).map((s) => ({ ...s, _m: m.name })),
                 ...remote.map((s) => ({ ...s, _m: m.name }))];
    const projects = [...new Set([...(m.projects || []), ...all.map((s) => s.project).filter(Boolean)])];
    const noProj = all.filter((s) => !s.project);
    const byProj = (p) => all.filter((s) => s.project === p);
    const projHtml = projects.filter((p) => !selProject || p === selProject).map((p) => `
      <div class="proj ${selProject === p ? 'sel' : ''}" onclick="pickProject('${p}')">
        <span>&#128193; ${p}</span><span class="dim">${byProj(p).length} session(s)</span></div>
      ${byProj(p).map((s) => sessCard(s, m.name)).join('') || ''}`).join('');
    return `<div><h2>${m.name}</h2>${projHtml}
      ${(!selProject && noProj.length) ? `<div class="proj"><span>&#128193; (no project)</span><span class="dim">${noProj.length}</span></div>` + noProj.map((s) => sessCard(s, m.name)).join('') : ''}</div>`;
  }).join('');
}

async function refreshOrphans() {
  try {
    const o = await api('GET', '/api/reconcile');
    $('#orphanWrap').style.display = o.length ? '' : 'none';
    $('#orphanCount').textContent = o.length;
    $('#orphans').innerHTML = o.map((x) => `<div class="card">
      <div class="row"><b>${x.id}</b>
        ${!x.node && x.sessionId ? `<button onclick="resumeOrphan('${x.id}')">continue (resume)</button>` : ''}
        ${x.pidAlive !== false ? `<button onclick="killOrphan('${x.id}')">kill</button>` : ''}
        <button onclick="clearOrphan('${x.id}')">clear record</button></div>
      <span class="dim">pid ${x.pid ?? '—'} · alive ${x.pidAlive === null ? 'unknown (remote)' : x.pidAlive}${x.node ? ' · ' + x.node : ''}${x.sessionId ? ' · resumable' : ''} · ${new Date(x.ts).toLocaleString()}</span></div>`).join('');
  } catch { /* empty journal */ }
}
async function clearOrphan(id) {
  try { await api('POST', '/api/reconcile/clear', { id }); refreshOrphans(); } catch (e) { alert(e.message); }
}
// Crash recovery: CONTINUE a surviving session (new child, --resume restores the CLI
// conversation) or KILL it. The operator decides; the journal keeps the lineage either way.
async function resumeOrphan(id) {
  try {
    const desc = await api('POST', `/api/orphans/${id}/resume`, {});
    selected = desc.id;
    refreshFleet(); refreshChat(); refreshOrphans();
  } catch (e) { alert('resume failed: ' + e.message); }
}
async function killOrphan(id) {
  try { await api('POST', `/api/orphans/${id}/kill`, {}); refreshOrphans(); refreshFleet(); }
  catch (e) { alert('kill failed: ' + e.message); }
}

// ── chat: console-owned directly; shared foreign sessions attach on first click ──
async function openChat(machine, remoteId, consoleId, isMine) {
  try {
    if (isMine) { selected = consoleId || remoteId; }
    else {
      const key = machine + ':' + remoteId;
      if (!attached.has(key)) {
        const desc = await api('POST', '/api/attach', { node: machine, remoteId });
        attached.set(key, desc.id);
      }
      selected = attached.get(key);
    }
    renderTree(); refreshChat();
  } catch (e) { alert('attach failed: ' + e.message); }
}

async function refreshChat() {
  if (!selected) return;
  try {
    const { messages } = await api('GET', `/api/sessions/${selected}/log`);
    $('#msgs').innerHTML = messages.map((m) =>
      `<div class="msg ${m.role}"><div class="who">${m.role} · ${new Date(m.ts).toLocaleTimeString()}</div>${esc(m.text)}</div>`
    ).join('') + (sending ? '<div class="msg assistant spin">…thinking</div>' : '');
    $('#msgs').scrollTop = $('#msgs').scrollHeight;
  } catch { /* closed */ }
}

async function spawn() {
  if (!selMachine) { alert('pick a machine on the left first'); return; }
  const f = new FormData($('#spawnForm'));
  const v = (k) => (f.get(k) || '').toString().trim() || undefined;
  try {
    const desc = await api('POST', '/api/sessions', {
      provider: v('provider'), model: v('model'), effort: v('effort'),
      node: selMachine, project: v('project') ?? selProject,
      profile: v('profile'),
      write: f.get('write') === 'on', visible: f.get('visible') === 'on', interactive: f.get('interactive') === 'on',
    });
    selected = desc.id;
    refreshFleet(); refreshChat();
  } catch (e) { alert('spawn failed: ' + e.message); }
}

async function send() {
  const box = $('#prompt');
  const text = box.value.trim();
  if (!text || !selected || sending) return;
  box.value = '';
  sending = true; refreshChat();
  try { await api('POST', `/api/sessions/${selected}/send`, { prompt: text }); }
  catch (e) { alert('send failed: ' + e.message); }
  sending = false;
  refreshChat(); refreshFleet();
}

async function closeSess(id) {
  if (!id) return;
  try { await api('POST', `/api/sessions/${id}/close`, {}); } catch {}
  if (selected === id) { selected = null; $('#msgs').innerHTML = '<div id="chatEmpty">Session closed.</div>'; }
  refreshFleet();
}

// Native goal: set the /goal condition; the next Send then runs the autonomous loop
// (the CLI keeps working until the condition is met) and returns the final outcome.
async function setGoal() {
  const id = selected;
  if (!id) { alert('pick a session first'); return; }
  const condition = $('#goal').value.trim();
  if (!condition) { alert('goal condition required'); return; }
  try {
    await api('POST', `/api/sessions/${id}/goal`, { condition });
    $('#goal').value = '';
    refreshChat(); refreshFleet();
  } catch (e) { alert('set goal failed: ' + e.message); }
}

// In-place native compaction (codex thread/compact/start) — the same session keeps
// chatting. The console shows the result; an unsupported backend errors honestly.
async function compactSess(id) {
  if (!id) return;
  try {
    const r = await api('POST', `/api/sessions/${id}/compact`, {});
    alert(r.confirmed ? 'Session compacted in place.' : 'Compact requested; completion not confirmed.');
  } catch (e) { alert('compact failed: ' + e.message); }
  refreshChat(); refreshFleet();
}

loadCatalogue(false);
refreshFleet();
setInterval(refreshFleet, 6000);
setInterval(refreshChat, 2500);
