import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encrypt, decrypt } from '../crypto.mjs';
import { openDb, setMeta } from '../db.mjs';
import { todayISO } from '../lib.mjs';
import { SYNC_DIR, getRemote, getDeviceId, git, ensureSyncRepo, datePath } from './repo.mjs';
import { dumpDailyData, importDailyData } from './dump.mjs';

// List all .enc snapshot files from the cached origin/main ref.
// Pass an optional `dir` (e.g. "2026/06/11") to filter to a date directory.
export function listRemoteSnapshots(dir) {
  const args = ['ls-tree', '-r', '--name-only', 'origin/main'];
  if (dir) args.push(dir);
  const fileList = git(args, { ignoreError: true }).stdout;
  return fileList.split('\n').map(f => f.trim()).filter(f => f.endsWith('.enc'));
}

// Fetch and decrypt a single snapshot file from origin/main.
// Returns the parsed JSON object, or null if the file could not be read/decrypted.
export function readRemoteSnapshot(file) {
  const r = git(['show', `origin/main:${file}`], { ignoreError: true });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(decrypt(r.stdout));
  } catch (e) {
    console.warn(`Failed to decrypt ${file}: ${e.message}`);
    return null;
  }
}

// ── Push ──

export async function pushSnapshot(date) {
  date = date || todayISO();
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set — cannot push');

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
    console.log(`No data for ${date} — skipping push.`);
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

// ── Pull ──

export function pullSnapshots(date) {
  date = date || todayISO();
  const remote = getRemote();
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set — cannot pull');

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
  if (!remote) throw new Error('TRACEME_SYNC_REMOTE not set — cannot pull');

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
