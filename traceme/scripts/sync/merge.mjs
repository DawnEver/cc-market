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

// Read and merge all device snapshots for `date` from the cached `origin/main` ref —
// no network call (relies on a prior `git fetch` from pushSnapshot/pullSnapshots).
// Returns null if sync isn't set up, origin/main was never fetched, or no snapshots exist for the date.
//
// Options:
//   skipSelf: if true, exclude the current device from the merge (used by verifyConsistency
//             to avoid comparing local vs. local+foreign).
export function readMergedSnapshot(date, opts = {}) {
  date = date || todayISO();
  if (!isSyncSetup()) return null;

  ensureSyncRepo();

  const ref = git(['rev-parse', '--verify', '--quiet', 'origin/main'], { ignoreError: true });
  if (ref.status !== 0) return null;

  const lastCommit = git(['log', '-1', '--format=%cI', 'origin/main'], { ignoreError: true });
  const fetched_at = lastCommit.status === 0 ? lastCommit.stdout.trim() : null;

  const [y, m, d] = date.split('-');
  const dir = `${y}/${m}/${d}`;
  const encFiles = listRemoteSnapshots(dir);

  if (encFiles.length === 0) return null;

  const devices = [];
  const snapshots = [];
  const allSessions = [];

  for (const file of encFiles) {
    const deviceName = file.split('/').pop().replace('.enc', '');
    if (opts.skipSelf && deviceName === getDeviceId()) continue;

    const data = readRemoteSnapshot(file);
    if (!data) continue;

    devices.push(data.device || deviceName);
    snapshots.push(data);
    allSessions.push(...(data.sessions || []));
  }

  if (devices.length === 0) return null;

  const merged = mergeSnapshots(snapshots, groupKey);
  merged.version = 1;
  merged.date = date;
  merged.aggregated_at = new Date().toISOString();
  merged.devices = devices;
  merged.sessions = allSessions;

  // Convert maps to arrays for JSON
  return {
    ...merged,
    fetched_at,
    daily_summary: Object.values(merged.daily_summary),
    tool_usage: Object.entries(merged.tool_usage).map(([k, v]) => ({ tool_name: k, count: v })),
  };
}

// Per-device daily facts across a date range — for the dashboard's multi-device view.
// Unlike readMergedSnapshot (which sums devices together per day), this keeps each device's
// rows separate so the UI can show "all devices" vs. a single device. The LOCAL device is
// deliberately excluded — it is represented by the always-current live local DB facts, so
// including its (throttle-lagged) pushed snapshot here would double-count and stale it.
// Returns { facts, devices }; empty when sync isn't set up. Relies on the cached origin/main
// ref (no network) — same freshness contract as report/readMergedSnapshot.
export function readDeviceFacts(from, to) {
  const empty = { facts: [], devices: [] };
  if (!isSyncSetup()) return empty;
  ensureSyncRepo();
  if (git(['rev-parse', '--verify', '--quiet', 'origin/main'], { ignoreError: true }).status !== 0) return empty;

  const self = getDeviceId();
  const facts = [];
  const devices = new Set();
  for (const file of listRemoteSnapshots()) {
    const parts = file.split('/');
    if (parts.length < 4) continue;
    const date = `${parts[0]}-${parts[1]}-${parts[2]}`;
    if (date < from || date > to) continue;
    const deviceName = parts[3].replace('.enc', '');
    if (deviceName === self) continue;

    const data = readRemoteSnapshot(file);
    if (!data) continue;
    const device = data.device || deviceName;
    devices.add(device);
    for (const r of (data.daily_summary || [])) {
      facts.push({
        date, device, project: r.project,
        sessions: r.session_count || 0, prompts: r.prompt_count || 0,
        tokens: (r.billable_tokens != null ? r.billable_tokens : r.total_tokens) || 0,
        cost: r.total_cost || 0, top_model: r.top_model || null,
      });
    }
  }
  return { facts, devices: [...devices] };
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
