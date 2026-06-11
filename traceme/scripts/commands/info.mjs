import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from '../db.mjs';
import { getDbPath, TRACEME_DIR, ERROR_LOG } from '../lib.mjs';
import { isSyncSetup } from '../sync.mjs';
import { hasKey } from '../crypto.mjs';

export function printStatus(showSync) {
  const db = openDb();
  const dbPath = getDbPath();
  console.log(`TraceMe database: ${dbPath}`);
  const stats = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
  console.log(`Sessions recorded: ${stats.count}`);
  const range = db.prepare('SELECT MIN(started_at) as earliest, MAX(started_at) as latest FROM sessions').get();
  if (range.earliest) {
    console.log(`Date range: ${range.earliest.slice(0, 10)} — ${range.latest.slice(0, 10)}`);
  }
  if (existsSync(dbPath)) {
    const sizeKB = Math.round(statSync(dbPath).size / 1024);
    console.log(`DB size: ${sizeKB} KB`);
  }
  console.log(`Sync: ${isSyncSetup() ? 'configured' : 'not configured (run traceme sync setup)'}`);

  if (showSync) {
    const syncDir = join(TRACEME_DIR, 'sync-repo');
    console.log(`\n  Encryption key: ${hasKey() ? 'present' : 'missing'}`);
    console.log(`  TRACEME_SYNC_REMOTE: ${process.env.TRACEME_SYNC_REMOTE ? 'set' : 'not set'}`);
    const repoExists = existsSync(syncDir) && existsSync(join(syncDir, '.git'));
    console.log(`  Local sync repo: ${repoExists ? 'exists' : 'missing'}`);
    if (repoExists) {
      const deviceId = db.prepare("SELECT value FROM meta WHERE key = 'device_id'").get()?.value || '';
      if (deviceId) {
        const lastPush = spawnSync('git', ['log', '--all', '--oneline', '--author', deviceId, '-1', '--format=%ai'], { cwd: syncDir, encoding: 'utf8', timeout: 5000 });
        console.log(`  Last push (by this device): ${lastPush.stdout.trim() || 'never'}`);
      } else {
        console.log('  Last push (by this device): unknown (no device_id set)');
      }
      const fetchHead = spawnSync('git', ['log', '-1', '--format=%ai', 'FETCH_HEAD'], { cwd: syncDir, encoding: 'utf8', timeout: 5000, ignoreError: true });
      console.log(`  Last fetch: ${fetchHead.stdout.trim() || 'never'}`);
      const encCount = spawnSync('git', ['ls-tree', '-r', '--name-only', 'origin/main'], { cwd: syncDir, encoding: 'utf8', timeout: 10000 })
        .stdout.split('\n').map(f => f.trim()).filter(f => f.endsWith('.enc')).length;
      console.log(`  Encrypted snapshots on origin/main: ${encCount}`);
    } else {
      console.log('  Last push (by this device): n/a (no sync repo)');
      console.log('  Last fetch: n/a (no sync repo)');
      console.log('  Encrypted snapshots on origin/main: n/a (no sync repo)');
    }
    console.log(`  Sync configured: ${isSyncSetup() ? 'YES' : 'NO'}`);
  }
}

export function cmdStatus(args) {
  printStatus(args.includes('--sync'));
}

export function cmdErrors(args) {
  const nFlag = args.indexOf('-n');
  const n = (nFlag >= 0 && args[nFlag + 1]) ? parseInt(args[nFlag + 1]) || 50 : 50;
  if (!existsSync(ERROR_LOG)) {
    console.log('No errors logged.');
  } else {
    const content = readFileSync(ERROR_LOG, 'utf8');
    if (!content.trim()) {
      console.log('No errors logged.');
    } else {
      const lines = content.trim().split('\n');
      const recent = lines.slice(-n);
      console.log(`Last ${recent.length} error(s) from ${ERROR_LOG}:`);
      console.log(recent.join('\n'));
    }
  }
}

export async function cmdPricing() {
  const { loadPricing } = await import('../pricing.mjs');
  const pricing = loadPricing();
  console.log(`Model pricing (${join(TRACEME_DIR, 'model_pricing.json')}):`);
  console.log('');
  for (const [model, p] of Object.entries(pricing)) {
    const parts = [];
    if (p.input) parts.push(`input=$${p.input}/Mtok`);
    if (p.output) parts.push(`output=$${p.output}/Mtok`);
    if (p.cache_write) parts.push(`cache_write=$${p.cache_write}/Mtok`);
    if (p.cache_read) parts.push(`cache_read=$${p.cache_read}/Mtok`);
    if (p.cache_hit) parts.push(`cache_hit=$${p.cache_hit}/Mtok`);
    console.log(`  ${model}`);
    console.log(`    ${parts.join(', ')}`);
  }
}

export function cmdConfig(VERSION) {
  console.log(`TraceMe ${VERSION}`);
  console.log(`DB path:     ${getDbPath()}`);
  console.log(`Key file:    ${join(TRACEME_DIR, 'key.txt')} (${hasKey() ? 'present' : 'missing'})`);
  console.log(`Sync remote: ${process.env.TRACEME_SYNC_REMOTE || 'not set'}`);
  console.log(`Sync repo:   ${join(TRACEME_DIR, 'sync-repo')} (${isSyncSetup() ? 'configured' : 'not configured'})`);
  if (existsSync(getDbPath())) {
    const db = openDb();
    const stats = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
    const range = db.prepare('SELECT MIN(started_at) as earliest, MAX(started_at) as latest FROM sessions').get();
    console.log(`Sessions:    ${stats.count}${range.earliest ? ` (${range.earliest.slice(0, 10)} — ${range.latest.slice(0, 10)})` : ''}`);
    const sizeKB = Math.round(statSync(getDbPath()).size / 1024);
    console.log(`DB size:     ${sizeKB} KB`);
    console.log(`Pricing:     ${join(TRACEME_DIR, 'model_pricing.json')}`);
  }
}
