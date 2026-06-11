#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { closeDb } from './db.mjs';
import { todayISO } from './lib.mjs';
import { cmdReport, cmdStats } from './commands/report.mjs';
import { cmdExport } from './commands/export.mjs';
import { cmdRescan } from './commands/rescan.mjs';
import { cmdSync } from './commands/sync-cmd.mjs';
import { cmdStatus, cmdErrors, cmdPricing, cmdConfig } from './commands/info.mjs';
import { cmdInsights } from './commands/insights.mjs';

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
  traceme sync key [show]                        Show encryption key fingerprint
  traceme sync purge                             Clear local data and re-import from remote
  traceme sync rebuild                           Reset sync repo and repush all local data
  traceme export [date] [--csv] [--project <name>] [--from <d> --to <d>|--range Nd]  Export daily summaries as JSON/CSV
  traceme rescan [--all] [--prune]               Re-derive sessions from transcripts (--all: full rebuild, --prune: drop stale)
  traceme errors [-n N]                          Show last N hook errors (default: 50)
  traceme pricing                                Show current model pricing
  traceme config                                 Show configuration summary
  traceme insights [--day|--month|--days N] [--local] [--project <name>]  Multi-day trend analysis
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

try {
  switch (cmd) {
    case 'report':
      cmdReport(args, VERSION, parseRange, getFlag, parseDate);
      break;
    case 'stats':
      cmdStats(args, VERSION, getFlag);
      break;
    case 'status':
      cmdStatus(args);
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    case 'sync':
      await cmdSync(args, parseDate);
      break;
    case 'export':
      cmdExport(args, parseRange, getFlag, parseDate);
      break;
    case 'rescan':
      cmdRescan(args);
      break;
    case 'errors':
      cmdErrors(args);
      break;
    case 'pricing':
      await cmdPricing();
      break;
    case 'config':
      cmdConfig(VERSION);
      break;
    case 'insights':
      cmdInsights(args, VERSION);
      break;
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
