#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openDb, closeDb } from './db.mjs';
import { generateReport, generateStats } from './report.mjs';
import { todayISO } from './lib.mjs';
import { setupSync, pushSnapshot, pushAllSnapshots, pullSnapshots, pullAllSnapshots, aggregateAndPush, verifyConsistency } from './sync.mjs';

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
  traceme report [today|yesterday|YYYY-MM-DD] [--local-only]  Daily markdown report
  traceme stats [--local-only]                   Quick summary
  traceme setup                                  Initialize database
  traceme sync setup                             Generate age keypair, init sync repo
  traceme sync push [date|--all]                 Encrypt & push daily snapshot (--all: backfill all history)
  traceme sync pull [date|--all]                 Pull & import snapshots from other devices (--all: full sync)
  traceme sync aggregate [date]                  Merge all device snapshots → encrypted main
  traceme sync verify [date]                     Compare local SQLite vs merged aggregate
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

try {
  switch (cmd) {
    case 'report': {
      const date = parseDate(args[1]);
      const localOnly = args.includes('--local-only');
      console.log(generateReport(date, { localOnly }) + `\nTraceMe ${VERSION}`);
      break;
    }
    case 'stats': {
      const localOnly = args.includes('--local-only');
      console.log(generateStats({ localOnly }) + `\nTraceMe ${VERSION}`);
      break;
    }
    case 'setup': {
      const db = openDb();
      console.log('TraceMe database initialized at ~/.claude/traceme/traceme.db');
      const stats = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
      console.log(`Sessions recorded: ${stats.count}`);
      closeDb();
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    case 'sync': {
      const sub = args[1] || 'help';
      const date = parseDate(args[2]);
      switch (sub) {
        case 'setup':
          setupSync();
          break;
        case 'push':
          if (args[2] === '--all') pushAllSnapshots();
          else pushSnapshot(date);
          break;
        case 'pull':
          if (args[2] === '--all') pullAllSnapshots();
          else pullSnapshots(date);
          break;
        case 'aggregate':
          aggregateAndPush(date);
          break;
        case 'verify': {
          const result = verifyConsistency(date);
          console.log(`Local:  ${result.local.tokens.toLocaleString()} tokens, ${result.local.projects} projects`);
          if (result.merged) {
            console.log(`Merged: ${result.merged.tokens.toLocaleString()} tokens`);
            console.log(`Consistent: ${result.consistent ? 'YES' : 'NO (diff > 1%)'}`);
          } else {
            console.log('No merged aggregate found — run `traceme sync aggregate` first');
          }
          break;
        }
        default:
          console.log(`Unknown sync command: ${sub}`);
          console.log('Available: setup, push, pull, aggregate, verify');
          process.exit(1);
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
