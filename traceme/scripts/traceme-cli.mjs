#!/usr/bin/env node
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';
import { openDb, closeDb, queryDailySummary, nullifyOldPrompts, nullifyOldToolCalls, deleteOldToolCalls, countOldPrompts, countOldToolCalls, countOldPromptsDate, countOldPromptsWithTextDate, countOldToolCallsDate, nullifyOldPromptsDate, nullifyOldToolCallsDate, deleteOldToolCallsDate } from './db.mjs';
import { generateReport, generateRangeReport, generateStats } from './report.mjs';
import { todayISO, getDbPath, TRACEME_DIR, ERROR_LOG } from './lib.mjs';
import { setupSync, pushSnapshot, pushAllSnapshots, pullSnapshots, pullAllSnapshots, verifyConsistency, isSyncSetup, forgetDevice, rebuildSync } from './sync.mjs';
import { setKey, hasKey } from './crypto.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'report';

let VERSION = 'dev';
try {
  const pluginJson = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
  VERSION = 'v' + JSON.parse(readFileSync(pluginJson, 'utf8')).version;
} catch {}

function usage() {
  console.log(`TraceMe ${VERSION} — personal Claude Code observability

Usage:
  traceme report [date] [--local] [--json] [--brief] [--project <name>] [--from <d> --to <d>|--range Nd]
  traceme stats [--local] [--project <name>]    Alias for \`report today --brief\`
  traceme status [--sync]                        DB health; --sync adds detailed sync diagnostics
  traceme sync setup [--key <hex>]               Generate/set encryption key, init sync repo
  traceme sync set-key <hex>                     Replace the encryption key
  traceme sync push [date|--all]                 Encrypt & push daily snapshot
  traceme sync pull [date|--all]                 Pull & import other devices' snapshots
  traceme sync verify [date]                     Compare local vs merged aggregate
  traceme sync status                            Alias for \`status --sync\`
  traceme sync forget <device-id>                Remove a device's snapshots from the sync repo
  traceme sync rebuild                           Reset sync repo and repush all local data
  traceme export [date] [--csv] [--project <name>] [--from <d> --to <d>|--range Nd]  Export daily summaries as JSON/CSV
  traceme prune [days|YYYY-MM-DD] [--keep-stats] [--dry-run] [--tool-calls]  Delete old prompt/tool_call data
  traceme errors [-n N]                          Show last N hook errors (default: 50)
  traceme pricing                                Show current model pricing
  traceme config                                 Show configuration summary
  traceme help                                   Show this help`);
}

function parseDate(arg) {
  if (!arg || arg === 'today') return todayISO();
  if (arg === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  return todayISO();
}

function parseRange(args) {
  const rangeIdx = args.indexOf('--range');
  if (rangeIdx >= 0 && args[rangeIdx + 1]) {
    const m = args[rangeIdx + 1].match(/^(\d+)d$/);
    if (m) {
      const days = parseInt(m[1]);
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - days + 1);
      return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
    }
  }
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  if (fromIdx >= 0 && toIdx >= 0 && args[fromIdx + 1] && args[toIdx + 1]) {
    return { from: parseDate(args[fromIdx + 1]), to: parseDate(args[toIdx + 1]) };
  }
  return null;
}

function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return null;
}

function printStatus(showSync) {
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

try {
  switch (cmd) {
    case 'report': {
      const range = parseRange(args);
      const local = args.includes('--local');
      const asJson = args.includes('--json');
      const brief = args.includes('--brief');
      const project = getFlag(args, '--project');
      const date = parseDate(args[1]);

      if (range) {
        const rpt = generateRangeReport({ from: range.from, to: range.to, local, brief, project });
        console.log(rpt + '\n' + `TraceMe ${VERSION}`);
      } else {
        console.log(generateReport(date, { local, json: asJson, brief, project }) + (asJson ? '' : `\nTraceMe ${VERSION}`));
      }
      break;
    }
    case 'stats': {
      const local = args.includes('--local');
      const project = getFlag(args, '--project');
      console.log(generateStats({ local, project }) + `\nTraceMe ${VERSION}`);
      break;
    }
    case 'status':
      printStatus(args.includes('--sync'));
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    case 'sync': {
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
        case 'rebuild':
          await rebuildSync();
          break;
        default:
          console.log(`Unknown sync command: ${sub}`);
          console.log('Available: setup, set-key, push, pull, verify, status, forget, rebuild');
          process.exit(1);
      }
      break;
    }
    case 'export': {
      openDb();
      const asCsv = args.includes('--csv');
      const project = getFlag(args, '--project');
      const range = parseRange(args);

      let rows;
      if (range) {
        rows = [];
        const from = new Date(range.from + 'T00:00:00');
        const to = new Date(range.to + 'T00:00:00');
        for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().slice(0, 10);
          rows.push(...queryDailySummary(dateStr));
        }
      } else {
        const date = parseDate(args[1]);
        rows = queryDailySummary(date);
      }

      if (project) {
        const lower = project.toLowerCase();
        rows = rows.filter(r => r.project.toLowerCase().includes(lower));
      }

      if (asCsv) {
        console.log('date,project,repo_origin,sessions,prompts,tokens,cost');
        for (const r of rows) {
          console.log(`${r.date},${r.project},${r.repo_origin || ''},${r.session_count},${r.prompt_count},${r.total_tokens},${r.total_cost}`);
        }
      } else {
        console.log(JSON.stringify(rows, null, 2));
      }
      break;
    }
    case 'prune': {
      const keepStats = args.includes('--keep-stats');
      const dryRun = args.includes('--dry-run');
      const toolCalls = args.includes('--tool-calls');
      const dayArg = args.slice(1).find(a => /^\d+$/.test(a) || /^\d{4}-\d{2}-\d{2}$/.test(a));
      let cutoffDate;
      let isDateString = false;
      if (dayArg && /^\d{4}-\d{2}-\d{2}$/.test(dayArg)) {
        cutoffDate = new Date(dayArg + 'T00:00:00');
        isDateString = true;
      } else {
        const days = parseInt(dayArg) || 90;
        cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
      }
      const days = Math.ceil((new Date() - cutoffDate) / (1000 * 60 * 60 * 24));
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);
      const db = openDb();

      // Prompts — use date-variant functions when a date string was provided to avoid off-by-1
      const promptTextCount = isDateString ? countOldPromptsWithTextDate(cutoffStr) : countOldPrompts(days, true);
      const promptAllCount = isDateString ? countOldPromptsDate(cutoffStr) : countOldPrompts(days, false);

      // Tool calls
      const toolCount = toolCalls ? (isDateString ? countOldToolCallsDate(cutoffStr) : countOldToolCalls(days)) : 0;

      if (dryRun) {
        if (keepStats) {
          console.log(`Would clear prompt text for ${promptTextCount} prompts older than ${days} days (before ${cutoffStr})`);
          console.log('Token, cost, and duration data would be retained.');
        } else {
          console.log(`Would delete ${promptAllCount} prompts older than ${days} days (before ${cutoffStr})`);
        }
        if (toolCalls) {
          console.log(`Would also affect ${toolCount} tool calls older than ${days} days`);
        }
        console.log('(dry run — no changes made)');
      } else {
        if (keepStats) {
          const result = isDateString ? nullifyOldPromptsDate(cutoffStr) : nullifyOldPrompts(days);
          console.log(`Cleared prompt text for ${result} prompts older than ${days} days (before ${cutoffStr})`);
          console.log('Token, cost, and duration data retained.');
        } else {
          const pResult = db.prepare('DELETE FROM prompts WHERE date(timestamp) < ?').run(cutoffStr);
          console.log(`Pruned ${pResult.changes} prompts older than ${days} days (before ${cutoffStr})`);
        }
        if (toolCalls) {
          if (keepStats) {
            const tcResult = isDateString ? nullifyOldToolCallsDate(cutoffStr) : nullifyOldToolCalls(days);
            console.log(`Cleared summary for ${tcResult} tool calls (stats retained)`);
          } else {
            const tcResult = isDateString ? deleteOldToolCallsDate(cutoffStr) : deleteOldToolCalls(days);
            console.log(`Pruned ${tcResult} tool calls`);
          }
        }
        if (!toolCalls) {
          console.log('Tool calls unaffected. Use --tool-calls to also prune tool call data.');
        }
        console.log('Sessions and daily_summary retained for historical stats.');
      }
      break;
    }
    case 'errors': {
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
      break;
    }
    case 'pricing': {
      const { loadPricing } = await import('./pricing.mjs');
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
      break;
    }
    case 'config': {
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
      }
      break;
    }
    default:
      console.log(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
} finally {
  closeDb();
}