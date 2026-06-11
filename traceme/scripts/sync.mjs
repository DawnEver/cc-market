import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { openDb, queryDailySummary, queryToolUsage, getMeta, setMeta } from './db.mjs';
import { encrypt, decrypt, hasKey, generateKey, setKey } from './crypto.mjs';
import { createInterface } from 'node:readline';
import { todayISO, TRACEME_DIR } from './lib.mjs';

const SYNC_DIR = join(TRACEME_DIR, 'sync-repo');
let _deviceId = null;
function getDeviceId() {
  if (_deviceId) return _deviceId;
  openDb();
  _deviceId = getMeta('device_id');
  if (!_deviceId) {
    _deviceId = `${userInfo().username}@${hostname().split('.')[0]}_${Date.now().toString(36)}`;
    setMeta('device_id', _deviceId);
  }
  return _deviceId;
}
let _syncRepoReady = false;

function getRemote() {
  if (process.env.TRACEME_SYNC_REMOTE) return process.env.TRACEME_SYNC_REMOTE;
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: SYNC_DIR, encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  return null;
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd || SYNC_DIR,
    timeout: opts.timeout || 30000,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'traceme', GIT_AUTHOR_EMAIL: 'traceme@local', GIT_COMMITTER_NAME: 'traceme', GIT_COMMITTER_EMAIL: 'traceme@local' }
  });
  if (r.status !== 0 && !opts.ignoreError) {
    throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  return r;
}

// Convert "YYYY-MM-DD" to the repo-relative snapshot path "YYYY/MM/DD/<device>.enc" â€”
// each device writes its own file directly to the main branch.
function datePath(date) {
  const [y, m, d] = date.split('-');
  return `${y}/${m}/${d}/${getDeviceId()}.enc`;
}


// Pure merge of daily_summary and tool_usage across multiple device snapshots.
// keyFn(row) returns the grouping key (repo_origin or project).
function mergeSnapshots(snapshots, keyFn) {
  const daily = {}, tools = {};
  for (const snap of snapshots) {
    for (const row of (snap.daily_summary || [])) {
      const key = keyFn(row);
      if (!daily[key]) { daily[key] = { ...row }; } else {
        const m = daily[key];
        m.session_count += row.session_count;
        m.prompt_count += row.prompt_count;
        m.total_tokens += row.total_tokens;
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
// â”€â”€ Shared remote helpers â”€â”€

// List all .enc snapshot files from the cached origin/main ref.
// Pass an optional `dir` (e.g. "2026/06/11") to filter to a date directory.
function listRemoteSnapshots(dir) {
  const args = ['ls-tree', '-r', '--name-only', 'origin/main'];
  if (dir) args.push(dir);
  const fileList = git(args, { ignoreError: true }).stdout;
  return fileList.split('\n').map(f => f.trim()).filter(f => f.endsWith('.enc'));
}

// Fetch and decrypt a single snapshot file from origin/main.
// Returns the parsed JSON object, or null if the file could not be read/decrypted.
function readRemoteSnapshot(file) {
  const r = git(['show', `origin/main:${file}`], { ignoreError: true });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(decrypt(r.stdout));
  } catch (e) {
    console.warn(`Failed to decrypt ${file}: ${e.message}`);
    return null;
  }
}

// â”€â”€ Repo management â”€â”€

export function ensureSyncRepo() {
  if (_syncRepoReady) return SYNC_DIR;
  if (!existsSync(SYNC_DIR)) {
    mkdirSync(SYNC_DIR, { recursive: true });
    git(['init'], { cwd: SYNC_DIR });
  }
  const remote = getRemote();
  if (remote) {
    const existing = git(['remote', 'get-url', 'origin'], { cwd: SYNC_DIR, ignoreError: true });
    if (existing.status !== 0) git(['remote', 'add', 'origin', remote]);
    else if (existing.stdout.trim() !== remote) git(['remote', 'set-url', 'origin', remote]);
  }
  _syncRepoReady = true;
  return SYNC_DIR;
}

export function isSyncSetup() {
  return existsSync(SYNC_DIR) && existsSync(join(SYNC_DIR, '.git')) && hasKey() && getRemote();
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

export async function setupSync(opts = {}) {
  if (hasKey()) {
    console.log('Encryption key already exists.');
    if (opts.key) console.warn('--key ignored: key already exists, remove ~/.claude/traceme/key.txt first to replace it');
  } else if (opts.key) {
    setKey(opts.key);
    console.log(`Encryption key set (${opts.key.slice(0, 8)}...)`);
  } else if (process.stdin.isTTY) {
    console.log('No encryption key found. You can:\n  1. Generate a new key (if this is your first device)\n  2. Paste an existing key from another device');
    const answer = await prompt('Do you have a key from another device? [y/N] ');
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      const hexKey = await prompt('Paste the 64-character hex key: ');
      setKey(hexKey);
      console.log(`Key imported (${hexKey.slice(0, 8)}...)`);
    } else {
      const key = generateKey();
      console.log('Key generated â€” copy this to your other device(s):');
      console.log(key);
      console.log('Store this key securely â€” it encrypts all your traceme sync data.');
    }
  } else {
    const key = generateKey();
    console.log(`Key generated (non-TTY): ${key}`);
  }

  ensureSyncRepo();
  if (!getRemote()) {
    console.warn('TRACEME_SYNC_REMOTE not set â€” local-only mode (no push/pull)');
  } else {
    console.log('Pulling data from other devices...');
    try { pullAllSnapshots(); } catch (e) { console.warn(`Pull failed: ${e.message}`); }
  }
  console.log(`Sync repo: ${SYNC_DIR}`);
  console.log(`Device: ${getDeviceId()}`);
}

// â”€â”€ Data dump / import â”€â”€

export function dumpDailyData(date) {
  const db = openDb();
  return {
    version: 1,
    date,
    device: getDeviceId(),
    generated_at: new Date().toISOString(),
    daily_summary: queryDailySummary(date).map(r => ({
      project: r.project,
      repo_origin: r.repo_origin,
      session_count: r.session_count,
      prompt_count: r.prompt_count,
      total_tokens: r.total_tokens,
      total_cost: Math.round(r.total_cost * 100000) / 100000,
      top_model: r.top_model
    })),
    tool_usage: queryToolUsage(date),
    sessions: db.prepare(`
      SELECT id, project, repo_origin, branch, started_at, ended_at, prompt_count, total_tokens, total_cost
      FROM sessions WHERE date(started_at) = ?
    `).all(date).map(r => ({
      ...r,
      total_cost: Math.round(r.total_cost * 100000) / 100000
    })),
  };
}

export function importDailyData(data) {
  const db = openDb();

  // Merge daily_summary â€” SUM across devices (matches aggregate logic on main)
  for (const row of (data.daily_summary || [])) {
    const repoOrigin = row.repo_origin || row.project || '';
    const existing = db.prepare(
      'SELECT * FROM daily_summary WHERE date=? AND repo_origin=?'
    ).get(data.date, repoOrigin);
    if (existing) {
      db.prepare(`
        UPDATE daily_summary SET
          session_count = session_count + ?,
          prompt_count  = prompt_count + ?,
          total_tokens  = total_tokens + ?,
          total_cost    = total_cost + ?,
          top_model     = COALESCE(?, top_model),
          project       = ?
        WHERE date=? AND repo_origin=?
      `).run(row.session_count, row.prompt_count, row.total_tokens, row.total_cost, row.top_model, row.project, data.date, repoOrigin);
    } else {
      db.prepare(`
        INSERT INTO daily_summary (date, project, repo_origin, session_count, prompt_count, total_tokens, total_cost, top_model)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(data.date, row.project, repoOrigin, row.session_count, row.prompt_count, row.total_tokens, row.total_cost, row.top_model);
    }
  }

  // Merge sessions (skip duplicates by id)
  for (const s of (data.sessions || [])) {
    const exists = db.prepare('SELECT 1 FROM sessions WHERE id=?').get(s.id);
    if (!exists) {
      db.prepare(`
        INSERT OR IGNORE INTO sessions (id, project, project_path, repo_origin, branch, started_at, ended_at, prompt_count, total_tokens, total_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(s.id, s.project, s.project || 'unknown', s.repo_origin || '', s.branch, s.started_at, s.ended_at, s.prompt_count, s.total_tokens, s.total_cost);
    }
  }

  // tool_usage (and skill_usage) are intentionally NOT imported into the local
  // tool_calls table. Cross-device tool usage is aggregated by readMergedSnapshot
  // (which merges tool_usage from all device snapshots in memory). The local DB's
  // tool_calls table is meant for this device only â€” privacy boundary.

  console.log(`Imported: ${(data.daily_summary || []).length} project summaries, ${(data.sessions || []).length} sessions from ${data.device}`);
}

// â”€â”€ Push â”€â”€

export async function pushSnapshot(date) {
  date = date || todayISO();
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set â€” cannot push');

  ensureSyncRepo();

  // Ensure on main branch
  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (currentBranch !== 'main') {
    const mainExists = git(['branch', '--list', 'main']).stdout.includes('main');
    const mainRemote = git(['ls-remote', '--heads', 'origin', 'main'], { ignoreError: true }).stdout.trim();
    if (!mainExists && !mainRemote) {
      git(['checkout', '--orphan', 'main']);
      git(['rm', '-rf', '.'], { ignoreError: true });
    } else if (!mainExists) {
      git(['checkout', '-b', 'main', 'origin/main']);
    } else {
      git(['checkout', 'main']);
    }
  }

  // Dump, encrypt, write
  const data = dumpDailyData(date);
  if (data.daily_summary.length === 0) {
    console.log(`No data for ${date} â€” skipping push.`);
    return null;
  }

  const file = datePath(date);
  const filePath = join(SYNC_DIR, ...file.split('/'));
  const json = JSON.stringify(data);
  const armored = encrypt(json);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, armored, 'utf8');

  git(['add', file]);
  git(['commit', '-m', `traceme: daily snapshot ${date} [${getDeviceId()}]`], { ignoreError: true });

  // Push with retry: if another device pushed since we last fetched, rebase and retry
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = git(['push', 'origin', 'main'], { ignoreError: true });
    if (r.status === 0) {
      console.log(`Pushed ${file} to origin/main (${data.daily_summary.length} projects, ${data.sessions.length} sessions)`);
      setMeta(`last_push_${date}`, new Date().toISOString());
      return { file, branch: 'main', projects: data.daily_summary.length, sessions: data.sessions.length };
    }
    if (attempt < 2) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`Push attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      git(['pull', '--rebase', 'origin', 'main'], { ignoreError: true });
    }
  }
  throw new Error('Failed to push after 3 attempts');
}

export async function pushAllSnapshots() {
  const db = openDb();
  const dates = db.prepare("SELECT DISTINCT date(started_at) as d FROM sessions UNION SELECT DISTINCT date FROM daily_summary ORDER BY d").all().map(r => r.d);
  if (dates.length === 0) {
    console.log('No historical data to backfill.');
    return [];
  }
  const results = [];
  for (const [i, date] of dates.entries()) {
    process.stdout.write(`[${i + 1}/${dates.length}] ${date}... `);
    const r = await pushSnapshot(date);
    if (r) results.push(r);
  }
  const skipped = dates.length - results.length;
  const parts = [`${results.length}/${dates.length} dates pushed`];
  if (skipped > 0) parts.push(`${skipped} skipped (no data)`);
  console.log(`\nBackfill complete: ${parts.join(', ')}`);
  return results;
}

// â”€â”€ Pull â”€â”€

export function pullSnapshots(date) {
  date = date || todayISO();
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set â€” cannot pull');

  ensureSyncRepo();
  git(['fetch', 'origin', 'main']);

  const [y, m, d] = date.split('-');
  const dir = `${y}/${m}/${d}`;
  const encFiles = listRemoteSnapshots(dir);

  const results = [];
  for (const file of encFiles) {
    const deviceName = file.split('/').pop().replace('.enc', '');
    if (deviceName === getDeviceId()) continue;

    const data = readRemoteSnapshot(file);
    if (!data) continue;
    importDailyData(data);
    results.push({ device: deviceName, projects: data.daily_summary.length, sessions: data.sessions.length });
  }

  if (results.length > 0) {
    setMeta(`last_pull_${date}`, new Date().toISOString());
    console.log(`Pulled ${results.length} snapshots for ${date}: ${results.map(r => `${r.device} (${r.projects} projects, ${r.sessions} sessions)`).join(', ')}`);
  } else {
    console.log(`No new snapshots to pull for ${date}`);
  }

  return results;
}

export function pullAllSnapshots() {
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set â€” cannot pull');

  ensureSyncRepo();
  git(['fetch', 'origin', 'main']);

  const encFiles = listRemoteSnapshots();

  const allResults = [];
  let progress = 0;
  for (const file of encFiles) {
    const deviceName = file.split('/').pop().replace('.enc', '');
    if (deviceName === getDeviceId()) continue;

    const data = readRemoteSnapshot(file);
    if (!data) continue;
    importDailyData(data);
    allResults.push({ device: deviceName, date: data.date, projects: data.daily_summary.length });
    progress++;
    if (progress % 10 === 0) process.stdout.write('.');
  }
  if (progress > 10) process.stdout.write('\n');

  if (allResults.length > 0) console.log(`Pulled ${allResults.length} snapshots from ${new Set(allResults.map(r => r.device)).size} devices`);
  return allResults;
}

// â”€â”€ Merged read â”€â”€

// Read and merge all device snapshots for `date` from the cached `origin/main` ref â€”
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

// â”€â”€ Verify â”€â”€

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

// --- Forget device ---

export async function forgetDevice(deviceId) {
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set');

  ensureSyncRepo();
  git(['fetch', 'origin', 'main']);

  const encFiles = listRemoteSnapshots();
  const deviceFiles = encFiles.filter(f => {
    const name = f.split('/').pop().replace('.enc', '');
    return name === deviceId;
  });

  if (deviceFiles.length === 0) {
    console.log(`No snapshots found for device "${deviceId}".`);
    return [];
  }

  // Remove each file via git rm + commit + push
  for (const file of deviceFiles) {
    try { git(['rm', '-f', file], { ignoreError: true }); } catch {}
  }

  git(['commit', '-m', `traceme: forget device ${deviceId} [${getDeviceId()}]`], { ignoreError: true });

  // Push with retry
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = git(['push', 'origin', 'main'], { ignoreError: true });
    if (r.status === 0) {
      console.log(`Removed ${deviceFiles.length} snapshot(s) for device "${deviceId}".`);
      console.warn(`Note: This only removes encrypted snapshots from the remote sync repo.
Data already imported into the local SQLite database from this device is not removed.
To start fresh with only local data, run \`traceme sync rebuild\`.`);
      return deviceFiles;
    }
    if (attempt < 2) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`Push attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      git(['pull', '--rebase', 'origin', 'main'], { ignoreError: true });
    }
  }
  throw new Error('Failed to push after 3 attempts');
}

// --- Rebuild sync ---

export async function rebuildSync() {
  if (!hasKey()) throw new Error('No encryption key — run `traceme sync setup` first');
  if (!getRemote()) throw new Error('TRACEME_SYNC_REMOTE not set');

  ensureSyncRepo();

  // Reset local sync repo — fetch latest, then force-checkout to match origin/main
  git(['fetch', 'origin', 'main'], { ignoreError: true });
  const ref = git(['rev-parse', '--verify', '--quiet', 'origin/main'], { ignoreError: true });
  if (ref.status === 0) {
    git(['checkout', '-B', 'main', 'origin/main'], { ignoreError: true });
  } else {
    // No remote main yet — start fresh orphan
    git(['checkout', '--orphan', 'main'], { ignoreError: true });
    try { git(['rm', '-rf', '.'], { ignoreError: true }); } catch {}
  }

  // Repush all local data
  await pushAllSnapshots();
  console.log('Sync rebuilt from local data.');
}

// --- Helpers for verifyConsistency ---

function groupKey(row) {
  return row.repo_origin || row.project;
}