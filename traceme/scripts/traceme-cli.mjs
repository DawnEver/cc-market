#!/usr/bin/env node
import { openDb, closeDb } from './db.mjs';
import { generateReport, generateStats } from './report.mjs';
import { todayISO } from './lib.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'report';

function usage() {
  console.log(`TraceMe — personal Claude Code observability

Usage:
  traceme report [today|yesterday|YYYY-MM-DD|week]  Daily markdown report
  traceme stats                                       Quick summary
  traceme setup                                       Initialize database
  traceme help                                        Show this help`);
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
      console.log(generateReport(date));
      break;
    }
    case 'stats': {
      console.log(generateStats());
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
