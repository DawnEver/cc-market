import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { openDb, queryDailySummary, queryToolUsage, querySkillUsage } from './db.mjs';
import { encrypt, decrypt, hasKey, generateKey } from './crypto.mjs';
import { todayISO, TRACEME_DIR } from './lib.mjs';

const SYNC_DIR = join(TRACEME_DIR, 'sync-repo');
const DEVICE = process.env.TRACEME_DEVICE_NAME || `${userInfo().username}@${hostname().split('.')[0]}`;

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

// Convert "YYYY-MM-DD" to the repo-relative snapshot path "YYYY/MM/DD/cc.enc" —
// the per-day directory leaves room for future sibling files (other tools' snapshots).
function datePath(date) {
  const [y, m, d] = date.split('-');
  return `${y}/${m}/${d}/cc.enc`;
}

// ── Repo management ──

export function ensureSyncRepo() {
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
  return SYNC_DIR;
}

export function isSyncSetup() {
  return existsSync(SYNC_DIR) && existsSync(join(SYNC_DIR, '.git')) && hasKey() && getRemote();
}

export function setupSync() {
  const existingKey = hasKey();
  if (!existingKey) {
    const key = generateKey();
    console.log(`Encryption key generated: ${key.slice(0, 8)}... (keep this secret, copy to other devices)`);
  } else {
    console.log('Encryption key already exists.');
  }
  ensureSyncRepo();
  if (!getRemote()) {
    console.warn('TRACEME_SYNC_REMOTE not set — local-only mode (no push/pull)');
  } else {
    // New device joining: pull all historical data from other devices
    if (existingKey) {
      console.log('Pulling data from other devices...');
      try { pullAllSnapshots(); } catch (e) { console.warn(`Pull failed: ${e.message}`); }
    }
  }
  console.log(`Sync repo: ${SYNC_DIR}`);
  console.log(`Device: ${DEVICE}`);
}

// ── Data dump / import ──

export function dumpDailyData(date) {
  const db = openDb();
  return {
    version: 1,
    date,
    device: DEVICE,
    generated_at: new Date().toISOString(),
    daily_summary: queryDailySummary(date).map(r => ({
      project: r.project,
      session_count: r.session_count,
      prompt_count: r.prompt_count,
      total_tokens: r.total_tokens,
      total_cost: Math.round(r.total_cost * 100000) / 100000,
      top_model: r.top_model
    })),
    tool_usage: queryToolUsage(date),
    skill_usage: querySkillUsage(date),
    sessions: db.prepare(`
      SELECT id, project, branch, started_at, ended_at, prompt_count, total_tokens, total_cost
      FROM sessions WHERE date(started_at) = ?
    `).all(date).map(r => ({
      ...r,
      total_cost: Math.round(r.total_cost * 100000) / 100000
    })),
  };
}

export function importDailyData(data) {
  const db = openDb();

  // Merge daily_summary
  for (const row of (data.daily_summary || [])) {
    const existing = db.prepare(
      'SELECT * FROM daily_summary WHERE date=? AND project=?'
    ).get(data.date, row.project);
    if (existing) {
      // Take max values — merged should reflect all devices
      db.prepare(`
        UPDATE daily_summary SET
          session_count = MAX(session_count, ?),
          prompt_count  = MAX(prompt_count, ?),
          total_tokens  = MAX(total_tokens, ?),
          total_cost    = MAX(total_cost, ?),
          top_model     = COALESCE(?, top_model)
        WHERE date=? AND project=?
      `).run(row.session_count, row.prompt_count, row.total_tokens, row.total_cost, row.top_model, data.date, row.project);
    } else {
      db.prepare(`
        INSERT INTO daily_summary (date, project, session_count, prompt_count, total_tokens, total_cost, top_model)
        VALUES (?,?,?,?,?,?,?)
      `).run(data.date, row.project, row.session_count, row.prompt_count, row.total_tokens, row.total_cost, row.top_model);
    }
  }

  // Merge sessions (skip duplicates by id)
  for (const s of (data.sessions || [])) {
    const exists = db.prepare('SELECT 1 FROM sessions WHERE id=?').get(s.id);
    if (!exists) {
      db.prepare(`
        INSERT OR IGNORE INTO sessions (id, project, project_path, branch, started_at, ended_at, prompt_count, total_tokens, total_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(s.id, s.project, s.project || 'unknown', s.branch, s.started_at, s.ended_at, s.prompt_count, s.total_tokens, s.total_cost);
    }
  }

  console.log(`Imported: ${(data.daily_summary || []).length} project summaries, ${(data.sessions || []).length} sessions from ${data.device}`);
}

// ── Push ──

export function pushSnapshot(date) {
  date = date || todayISO();
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set — cannot push');

  ensureSyncRepo();
  const branch = `device/${DEVICE}`;
  const file = datePath(date);
  const filePath = join(SYNC_DIR, ...file.split('/'));

  // Fetch remote to see current state
  try { git(['fetch', 'origin', branch], { ignoreError: true }); } catch {}

  // Checkout or create device branch
  const branches = git(['branch', '--list', branch]);
  const remoteExists = git(['ls-remote', '--heads', 'origin', branch], { ignoreError: true }).stdout.trim();
  if (!branches.stdout.includes(branch) && !remoteExists) {
    // New branch from scratch (orphan for clean history)
    git(['checkout', '--orphan', branch]);
  } else if (!branches.stdout.includes(branch)) {
    git(['checkout', '-b', branch, `origin/${branch}`]);
  } else {
    git(['checkout', branch]);
  }

  // Dump, encrypt, write
  const data = dumpDailyData(date);
  if (data.daily_summary.length === 0) {
    console.log(`No data for ${date} — skipping push.`);
    return null;
  }

  const json = JSON.stringify(data);
  const armored = encrypt(json);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, armored, 'utf8');

  // Commit and push
  git(['add', file]);
  git(['commit', '-m', `traceme: daily snapshot ${date} [${DEVICE}]`], { ignoreError: true }); // ok if no changes
  git(['push', '-u', 'origin', branch]);

  console.log(`Pushed ${file} to origin/${branch} (${data.daily_summary.length} projects, ${data.sessions.length} sessions)`);
  return { file, branch, projects: data.daily_summary.length, sessions: data.sessions.length };
}

export function pushAllSnapshots() {
  const db = openDb();
  const dates = db.prepare("SELECT DISTINCT date(started_at) as d FROM sessions UNION SELECT DISTINCT date FROM daily_summary ORDER BY d").all().map(r => r.d);
  if (dates.length === 0) {
    console.log('No historical data to backfill.');
    return [];
  }
  const results = [];
  for (const date of dates) {
    const r = pushSnapshot(date);
    if (r) results.push(r);
  }
  console.log(`Backfill complete: ${results.length}/${dates.length} dates pushed`);
  return results;
}

// ── Pull ──

export function pullSnapshots(date) {
  date = date || todayISO();
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set — cannot pull');

  ensureSyncRepo();
  git(['fetch', '--all']);

  // Discover device branches
  const refs = git(['ls-remote', '--heads', 'origin']).stdout;
  const deviceBranches = refs.split('\n').filter(l => l.includes('refs/heads/device/')).map(l => l.split('refs/heads/')[1].trim());

  const results = [];
  for (const branch of deviceBranches) {
    const deviceName = branch.replace('device/', '');
    if (deviceName === DEVICE) continue; // skip self

    // Check if this branch has a file for the requested date
    git(['fetch', 'origin', branch]);
    const file = datePath(date);
    // Try to show the file from the remote branch
    const r = git(['show', `origin/${branch}:${file}`], { ignoreError: true });
    if (r.status !== 0) {
      console.log(`No ${date} data from ${deviceName}`);
      continue;
    }

    try {
      const json = decrypt(r.stdout);
      const data = JSON.parse(json);
      importDailyData(data);
      results.push({ device: deviceName, projects: data.daily_summary.length, sessions: data.sessions.length });
    } catch (e) {
      console.warn(`Failed to decrypt/import from ${deviceName}: ${e.message}`);
    }
  }

  return results;
}

export function pullAllSnapshots() {
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set — cannot pull');

  ensureSyncRepo();
  git(['fetch', '--all']);

  const refs = git(['ls-remote', '--heads', 'origin']).stdout;
  const deviceBranches = refs.split('\n').filter(l => l.includes('refs/heads/device/')).map(l => l.split('refs/heads/')[1].trim());

  const allResults = [];
  for (const branch of deviceBranches) {
    const deviceName = branch.replace('device/', '');
    if (deviceName === DEVICE) continue;

    git(['fetch', 'origin', branch]);

    // List all snapshot files on this branch (recursively, under YYYY/MM/DD/cc.enc)
    const fileList = git(['ls-tree', '-r', '--name-only', `origin/${branch}`], { ignoreError: true }).stdout;
    const encFiles = fileList.split('\n').map(f => f.trim()).filter(f => /^\d{4}\/\d{2}\/\d{2}\/cc\.enc$/.test(f));

    for (const file of encFiles) {
      const r = git(['show', `origin/${branch}:${file}`], { ignoreError: true });
      if (r.status !== 0) continue;
      try {
        const json = decrypt(r.stdout);
        const data = JSON.parse(json);
        importDailyData(data);
        allResults.push({ device: deviceName, date: data.date, projects: data.daily_summary.length });
      } catch (e) {
        console.warn(`Failed to decrypt ${file} from ${deviceName}: ${e.message}`);
      }
    }
  }

  if (allResults.length > 0) console.log(`Pulled ${allResults.length} snapshots from ${new Set(allResults.map(r => r.device)).size} devices`);
  return allResults;
}

// ── Aggregate ──

export function aggregateAndPush(date) {
  date = date || todayISO();
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set — cannot aggregate');

  ensureSyncRepo();
  git(['fetch', '--all']);

  // Pull + merge data from ALL device branches (including self)
  const refs = git(['ls-remote', '--heads', 'origin']).stdout;
  const deviceBranches = refs.split('\n').filter(l => l.includes('refs/heads/device/')).map(l => l.split('refs/heads/')[1].trim());

  const merged = {
    version: 1,
    date,
    aggregated_at: new Date().toISOString(),
    devices: [],
    daily_summary: {},   // keyed by project
    sessions: [],
    tool_usage: {},      // keyed by tool_name
    skill_usage: {},     // keyed by skill_name
  };

  for (const branch of deviceBranches) {
    const deviceName = branch.replace('device/', '');
    git(['fetch', 'origin', branch]);
    const file = datePath(date);
    const r = git(['show', `origin/${branch}:${file}`], { ignoreError: true });
    if (r.status !== 0) continue;

    try {
      const json = decrypt(r.stdout);
      const data = JSON.parse(json);
      merged.devices.push(deviceName);

      // Merge daily_summary
      for (const row of (data.daily_summary || [])) {
        const key = row.project;
        if (!merged.daily_summary[key]) {
          merged.daily_summary[key] = { ...row };
        } else {
          const m = merged.daily_summary[key];
          m.session_count += row.session_count;
          m.prompt_count += row.prompt_count;
          m.total_tokens += row.total_tokens;
          m.total_cost += row.total_cost;
          m.total_cost = Math.round(m.total_cost * 100000) / 100000;
          m.top_model = m.top_model || row.top_model;
        }
      }

      // Collect sessions
      merged.sessions.push(...(data.sessions || []));

      // Merge tool usage
      for (const t of (data.tool_usage || [])) {
        merged.tool_usage[t.tool_name] = (merged.tool_usage[t.tool_name] || 0) + t.count;
      }

      // Merge skill usage
      for (const s of (data.skill_usage || [])) {
        merged.skill_usage[s.skill_name] = (merged.skill_usage[s.skill_name] || 0) + s.count;
      }
    } catch (e) {
      console.warn(`Failed to decrypt from ${deviceName}: ${e.message}`);
    }
  }

  if (merged.devices.length === 0) {
    console.log('No device data to aggregate.');
    return null;
  }

  // Convert maps to arrays for JSON
  const output = {
    ...merged,
    daily_summary: Object.values(merged.daily_summary),
    tool_usage: Object.entries(merged.tool_usage).map(([k, v]) => ({ tool_name: k, count: v })),
    skill_usage: Object.entries(merged.skill_usage).map(([k, v]) => ({ skill_name: k, count: v })),
  };

  // Encrypt and commit to main (create if new repo)
  const mainLocal = git(['branch', '--list', 'main']).stdout;
  const mainRemote = git(['ls-remote', '--heads', 'origin', 'main'], { ignoreError: true }).stdout.trim();
  if (!mainLocal.includes('main') && !mainRemote) {
    git(['checkout', '--orphan', 'main']);
    // Clear any staged files from previous branch
    git(['rm', '-rf', '.'], { ignoreError: true });
  } else if (!mainLocal.includes('main')) {
    git(['checkout', '-b', 'main', 'origin/main']);
  } else {
    git(['checkout', 'main']);
    git(['pull', 'origin', 'main'], { ignoreError: true });
  }

  const file = datePath(date);
  const filePath = join(SYNC_DIR, ...file.split('/'));
  mkdirSync(join(filePath, '..'), { recursive: true });

  const json = JSON.stringify(output);
  const armored = encrypt(json);
  writeFileSync(filePath, armored, 'utf8');

  git(['add', file]);
  git(['commit', '-m', `traceme: merged daily ${date} [${merged.devices.join(', ')}]`], { ignoreError: true });
  git(['push', 'origin', 'main']);

  console.log(`Aggregated ${merged.devices.length} devices → ${file} on main`);
  return output;
}

// ── Merged aggregate ──

// Read the cross-device aggregate for `date` from the cached `origin/main` ref —
// no network call (relies on a prior `git fetch` from aggregateAndPush/pullSnapshots).
// Returns null if sync isn't set up, origin/main was never fetched, or no snapshot exists for the date.
export function readMergedSnapshot(date) {
  date = date || todayISO();
  if (!isSyncSetup()) return null;

  ensureSyncRepo();

  const ref = git(['rev-parse', '--verify', '--quiet', 'origin/main'], { ignoreError: true });
  if (ref.status !== 0) return null;

  const file = datePath(date);
  const r = git(['show', `origin/main:${file}`], { ignoreError: true });
  if (r.status !== 0) return null;

  try {
    return JSON.parse(decrypt(r.stdout));
  } catch (e) {
    console.warn(`Failed to decrypt ${file}: ${e.message}`);
    return null;
  }
}

// ── Verify ──

export function verifyConsistency(date) {
  date = date || todayISO();

  openDb();
  const localSummary = queryDailySummary(date);
  const localTokens = localSummary.reduce((s, r) => s + r.total_tokens, 0);
  const localCost = localSummary.reduce((s, r) => s + r.total_cost, 0);

  const merged = readMergedSnapshot(date);
  let mergedTokens = null, mergedCost = null;
  if (merged) {
    mergedTokens = (merged.daily_summary || []).reduce((s, r) => s + (r.total_tokens || 0), 0);
    mergedCost = (merged.daily_summary || []).reduce((s, r) => s + (r.total_cost || 0), 0);
  }

  const ok = mergedTokens === null ? null : Math.abs(localTokens - mergedTokens) <= localTokens * 0.01;

  return {
    date,
    local: { tokens: localTokens, cost: localCost, projects: localSummary.length },
    merged: mergedTokens !== null ? { tokens: mergedTokens, cost: mergedCost } : null,
    consistent: ok,
  };
}
