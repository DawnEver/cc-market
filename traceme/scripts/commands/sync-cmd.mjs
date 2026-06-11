import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRACEME_DIR } from '../lib.mjs';
import { setupSync, pushSnapshot, pushAllSnapshots, pullSnapshots, pullAllSnapshots, verifyConsistency, isSyncSetup, forgetDevice, rebuildSync, purgeLocalData } from '../sync.mjs';
import { setKey, hasKey } from '../crypto.mjs';
import { printStatus } from './info.mjs';

export async function cmdSync(args, parseDate) {
  const sub = args[1] || 'help';
  const date = parseDate(args[2]);
  switch (sub) {
    case 'setup': {
      const keyIdx = args.indexOf('--key');
      const key = keyIdx >= 0 ? args[keyIdx + 1] : null;
      await setupSync(key ? { key } : {});
      break;
    }
    case 'set-key': {
      const hexKey = args[2];
      if (!hexKey) { console.error('Usage: traceme sync set-key <64-char-hex>'); process.exit(1); }
      setKey(hexKey);
      console.log(`Key set (${hexKey.slice(0, 8)}...). Run \`traceme sync pull --all\` to import data from other devices.`);
      if (isSyncSetup()) {
        console.log('Key replaced. Existing encrypted snapshots from other devices were encrypted with the old key and will be unreadable until those devices adopt the new key. Run `traceme sync rebuild` to repush local data with the new key.');
      }
      break;
    }
    case 'push':
      if (args[2] === '--all') await pushAllSnapshots();
      else await pushSnapshot(date);
      break;
    case 'pull':
      if (args[2] === '--all') pullAllSnapshots();
      else pullSnapshots(date);
      break;
    case 'verify': {
      const result = verifyConsistency(date);
      console.log(`Local:  ${result.local.tokens.toLocaleString()} tokens, ${result.local.projects} projects`);
      if (result.merged) {
        console.log(`Merged: ${result.merged.tokens.toLocaleString()} tokens`);
        console.log(`Consistent: ${result.consistent ? 'YES' : 'NO (diff > 1%)'}`);
        if (result.details && result.details.length > 0) {
          console.log('\nPer-project breakdown:');
          for (const d of result.details) {
            const diff = d.local - d.merged;
            const flag = !d.consistent ? ' *' : '';
            console.log(`  ${d.project}: local=${d.local.toLocaleString()} merged=${d.merged.toLocaleString()} diff=${diff > 0 ? '+' : ''}${diff.toLocaleString()}${flag}`);
          }
        }
      } else {
        console.log('No merged snapshot found — run `traceme sync pull` first');
      }
      break;
    }
    case 'status':
      printStatus(true);
      break;
    case 'forget': {
      const deviceId = args[2];
      if (!deviceId) { console.error('Usage: traceme sync forget <device-id>'); process.exit(1); }
      await forgetDevice(deviceId);
      break;
    }
    case 'key': {
      if (args[2] === 'show' || !args[2]) {
        if (!hasKey()) {
          console.log('No encryption key found. Run `traceme sync setup` to create one.');
        } else {
          const keyPath = join(TRACEME_DIR, 'key.txt');
          const keyHex = readFileSync(keyPath, 'utf8').trim();
          console.log(`Key fingerprint: ${keyHex.slice(0, 8)}...`);
          console.log(`Key file: ${keyPath}`);
        }
      } else {
        console.log(`Unknown key command: ${args[2]}`);
        console.log('Available: show');
      }
      break;
    }
    case 'purge':
      await purgeLocalData();
      break;
    case 'rebuild':
      await rebuildSync();
      break;
    default:
      console.log(`Unknown sync command: ${sub}`);
      console.log('Available: setup, set-key, push, pull, verify, status, forget, key, purge, rebuild');
      process.exit(1);
  }
}
