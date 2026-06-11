import { createInterface } from 'node:readline';
import { openDb } from '../db.mjs';
import { hasKey, setKey, generateKey } from '../crypto.mjs';
import { todayISO } from '../lib.mjs';
import { getRemote, getDeviceId, git, ensureSyncRepo, isSyncSetup } from './repo.mjs';
import { listRemoteSnapshots, pushAllSnapshots, pullAllSnapshots, pushSnapshot } from './transfer.mjs';

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
      console.log('Key generated — copy this to your other device(s):');
      console.log(key);
      console.log('Store this key securely — it encrypts all your traceme sync data.');
    }
  } else {
    const key = generateKey();
    console.log(`Key generated (non-TTY): ${key}`);
  }

  ensureSyncRepo();
  if (!getRemote()) {
    console.warn('TRACEME_SYNC_REMOTE not set — local-only mode (no push/pull)');
  } else {
    console.log('Pulling data from other devices...');
    try { pullAllSnapshots(); } catch (e) { console.warn(`Pull failed: ${e.message}`); }
  }
  console.log(`Sync repo: ${SYNC_DIR}`);
  console.log(`Device: ${getDeviceId()}`);
}

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
To start fresh with only local data, run \`traceme sync purge\`.`);
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

export async function purgeLocalData() {
  if (!isSyncSetup()) throw new Error('Sync not configured — nothing to purge');

  const db = openDb();

  // Push today's data first to save unpushed local data
  const today = todayISO();
  try {
    await pushSnapshot(today);
  } catch (e) {
    console.warn(`Push before purge failed (continuing): ${e.message}`);
  }

  // Clear data tables but keep traceme_meta (device_id, sync timestamps, etc.)
  db.exec('DELETE FROM tool_calls');
  db.exec('DELETE FROM prompts');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM daily_summary');

  // Re-import from remote
  console.log('Cleared local data. Re-importing from sync remote...');
  pullAllSnapshots();

  console.log('Purge complete. Local data now matches sync remote.');
}
