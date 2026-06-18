import { openDb, queryDailySummary } from '../db.mjs';
import { todayISO } from '../lib.mjs';
import { getDeviceId, git, ensureSyncRepo, isSyncSetup } from './repo.mjs';
import { listRemoteSnapshots, readRemoteSnapshot } from './transfer.mjs';

// Pure merge of daily_summary and tool_usage across multiple device snapshots.
// keyFn(row) returns the grouping key (project or repo_origin).
export function mergeSnapshots(snapshots, keyFn) {
  const daily = {}, tools = {};
  for (const snap of snapshots) {
    for (const row of (snap.daily_summary || [])) {
      const key = keyFn(row);
      if (!daily[key]) { daily[key] = { ...row }; } else {
        const m = daily[key];
        m.session_count += row.session_count;
        m.prompt_count += row.prompt_count;
        m.total_tokens += row.total_tokens;
        if (row.billable_tokens != null) m.billable_tokens = (m.billable_tokens || 0) + row.billable_tokens;
        if (row.cache_read_tokens != null) m.cache_read_tokens = (m.cache_read_tokens || 0) + row.cache_read_tokens;
        m.total_cost += row.total_cost;
        m.total_cost = Math.round(m.total_cost * 100000) / 100000;
        m.top_model = m.top_model || row.top_model;
      }
    }
    for (const t of (snap.tool_usage || [])) {
      tools[t.tool_name] = (tools[t.tool_name] || 0) + t.count;
    }
  }
  return { daily_summary: daily, tool_usage: tools };
}

export function groupKey(row) {
  return row.project || row.repo_origin;
}

// ── Single low-level reader for both the merged (per-date) and per-device (range) views ──
// Reads each device's `.enc` for the date(s) from the cached `origin/main` ref (no network).
// Returns null when sync isn't set up or origin/main was never fetched; otherwise
// { fetched_at, snapshots: [{ device, date, data }] } (snapshots may be empty).
//   from/to: inclusive date range (pass the same date for a single day — uses the date dir).
//   skipSelf: drop the current device (it is represented by the live local DB elsewhere).
function loadDeviceSnapshots({ from, to, skipSelf }) {
  if (!isSyncSetup()) return null;
  ensureSyncRepo();
  if (git(['rev-parse', '--verify', '--quiet', 'origin/main'], { ignoreError: true }).status !== 0) return null;

  const lastCommit = git(['log', '-1', '--format=%cI', 'origin/main'], { ignoreError: true });
  const fetched_at = lastCommit.status === 0 ? lastCommit.stdout.trim() : null;

  // Single-day hot path (report/insights call per day) scopes the listing to the date dir.
  const single = from === to;
  const files = single ? listRemoteSnapshots(from.split('-').join('/')) : listRemoteSnapshots();

  const self = getDeviceId();
  const snapshots = [];
  for (const file of files) {
    const parts = file.split('/');
    if (parts.length < 4) continue;
    const date = `${parts[0]}-${parts[1]}-${parts[2]}`;
    if (!single && (date < from || date > to)) continue;
    const deviceName = parts[3].replace('.enc', '');
    if (skipSelf && deviceName === self) continue;
    const data = readRemoteSnapshot(file);
    if (!data) continue;
    snapshots.push({ device: data.device || deviceName, date, data });
  }
  return { fetched_at, snapshots };
}

// Read and merge all device snapshots for `date`. Returns null if sync isn't set up,
// origin/main was never fetched, or no snapshots exist for the date.
//   skipSelf: exclude the current device (used by verifyConsistency to compare local vs foreign).
export function readMergedSnapshot(date, opts = {}) {
  date = date || todayISO();
  const loaded = loadDeviceSnapshots({ from: date, to: date, skipSelf: opts.skipSelf });
  if (!loaded || loaded.snapshots.length === 0) return null;

  const snapshots = loaded.snapshots.map(s => s.data);
  const merged = mergeSnapshots(snapshots, groupKey);
  merged.version = 1;
  merged.date = date;
  merged.aggregated_at = new Date().toISOString();
  merged.devices = loaded.snapshots.map(s => s.device);
  merged.sessions = snapshots.flatMap(d => d.sessions || []);

  return {
    ...merged,
    fetched_at: loaded.fetched_at,
    daily_summary: Object.values(merged.daily_summary),
    tool_usage: Object.entries(merged.tool_usage).map(([k, v]) => ({ tool_name: k, count: v })),
    model_facts: mergeModelFacts(loaded.snapshots),
    skill_usage: mergeSkillFacts(loaded.snapshots),
  };
}

// Aggregate per-device skill_usage into cross-device per (skill, repo_origin, project) call
// counts — keyed on repo_origin (the grouping identity) so same-basename repos stay distinct,
// consistent with the Token/Time sections. Empty for older snapshots predating skill_usage.
export function mergeSkillFacts(snapshots) {
  const agg = {};
  for (const { data } of snapshots) {
    for (const r of (data.skill_usage || [])) {
      if (!r.skill_name) continue;
      const key = JSON.stringify([r.skill_name, r.repo_origin || '', r.project || '']);
      const a = agg[key] || (agg[key] = { skill_name: r.skill_name, repo_origin: r.repo_origin || '', project: r.project || '', count: 0 });
      a.count += r.count || 0;
    }
  }
  return Object.values(agg);
}

// Aggregate per-device model_facts into cross-device per-model totals (cost recomputed by the
// caller is not possible across devices — uses each device's pushed cost). Empty for older
// snapshots that predate model_facts.
export function mergeModelFacts(snapshots) {
  const agg = {};
  for (const { data } of snapshots) {
    for (const r of (data.model_facts || [])) {
      const a = agg[r.model] || (agg[r.model] = { model: r.model, calls: 0, tokens: 0, cost: 0 });
      a.calls += r.requests || 0;
      a.tokens += (r.input || 0) + (r.output || 0) + (r.cache_creation || 0); // billable basis
      a.cost += r.cost || 0;
    }
  }
  return Object.values(agg).sort((a, b) => b.cost - a.cost);
}

// Per-device daily facts across a date range — for the dashboard's multi-device view.
// Keeps each device's rows separate (vs. readMergedSnapshot which sums devices per day) so the
// UI can show "all devices" vs. a single device. The LOCAL device is deliberately excluded — it
// is represented by the always-current live local DB facts, so including its (throttle-lagged)
// pushed snapshot would double-count and stale it. `modelFacts` carries per-device per-model
// rows (empty for snapshots predating the model_facts field).
// Returns { facts, modelFacts, devices }; empty when sync isn't set up.
export function readDeviceFacts(from, to) {
  const empty = { facts: [], modelFacts: [], devices: [] };
  const loaded = loadDeviceSnapshots({ from, to, skipSelf: true });
  if (!loaded) return empty;

  const facts = [], modelFacts = [], devices = new Set();
  for (const { device, date, data } of loaded.snapshots) {
    devices.add(device);
    for (const r of (data.daily_summary || [])) {
      facts.push({
        date, device, project: r.project, repo_origin: r.repo_origin || '',
        sessions: r.session_count || 0, prompts: r.prompt_count || 0,
        tokens: (r.billable_tokens != null ? r.billable_tokens : r.total_tokens) || 0,
        cost: r.total_cost || 0, top_model: r.top_model || null,
      });
    }
    for (const r of (data.model_facts || [])) {
      modelFacts.push({
        date, device, project: r.project, repo_origin: r.repo_origin || '', model: r.model,
        requests: r.requests || 0,
        tokens: (r.input || 0) + (r.output || 0) + (r.cache_creation || 0), // billable
        all_tokens: (r.input || 0) + (r.output || 0) + (r.cache_read || 0) + (r.cache_creation || 0),
        cost: r.cost || 0,
      });
    }
  }
  return { facts, modelFacts, devices: [...devices] };
}

export function verifyConsistency(date) {
  date = date || todayISO();

  openDb();
  const localSummary = queryDailySummary(date);
  const localTokens = localSummary.reduce((s, r) => s + r.total_tokens, 0);
  const localCost = localSummary.reduce((s, r) => s + r.total_cost, 0);

  // Skip own device: verify local vs. foreign-only, not local vs. local+foreign
  const merged = readMergedSnapshot(date, { skipSelf: true });
  let mergedTokens = null, mergedCost = null;
  const details = [];
  if (merged) {
    mergedTokens = (merged.daily_summary || []).reduce((s, r) => s + (r.total_tokens || 0), 0);
    mergedCost = (merged.daily_summary || []).reduce((s, r) => s + (r.total_cost || 0), 0);
    // Per-project breakdown — uses groupKey() for consistency with mergeSnapshots
    const mergedByKey = {};
    for (const r of (merged.daily_summary || [])) {
      const key = groupKey(r);
      mergedByKey[key] = (mergedByKey[key] || 0) + (r.total_tokens || 0);
    }
    for (const r of localSummary) {
      const localTok = r.total_tokens || 0;
      const key = groupKey(r);
      const mergedTok = mergedByKey[key] || 0;
      const diff = Math.abs(localTok - mergedTok);
      details.push({
        project: key,
        local: localTok,
        merged: mergedTok,
        consistent: localTok === 0 || diff <= localTok * 0.01,
      });
    }
  }

  const ok = mergedTokens === null ? null : Math.abs(localTokens - mergedTokens) <= localTokens * 0.01;

  return {
    date,
    local: { tokens: localTokens, cost: localCost, projects: localSummary.length },
    merged: mergedTokens !== null ? { tokens: mergedTokens, cost: mergedCost } : null,
    consistent: ok,
    details,
  };
}
