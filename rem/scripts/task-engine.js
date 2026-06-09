#!/usr/bin/env node
// task-engine.js — CLI entry point for task management (owned by rem)
// Pure logic lives in task-lib.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { todayISO, stampMissingFields } from '../lib.mjs';
import {
  ROOT,
  isStale, checkFileModified,
  groupByModule,
  scanMemoryForFindings, scanManualTasks,
} from './task-lib.mjs';

const PREFIX = '[task-engine]';
const MEMORY_DIR = join(ROOT, '.claude', 'memory');

// Version from plugin.json (stable across cache updates)
let VERSION = 'dev';
try {
  const pluginJson = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
  VERSION = 'v' + JSON.parse(readFileSync(pluginJson, 'utf8')).version;
} catch {}

// ── add ──

function handleAdd(args, today, implicitSummary) {
  let summary, severity = 'MEDIUM', module = 'manual';

  if (implicitSummary) {
    summary = implicitSummary;
    // Parse optional flags from remaining args
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--severity' && args[i + 1]) severity = args[++i];
      else if (args[i] === '--module' && args[i + 1]) module = args[++i];
    }
  } else {
    const si = args.indexOf('--summary');
    if (si >= 0) {
      summary = args[si + 1];
      if (!summary) { console.error(`${PREFIX} --summary value is required`); process.exit(1); }
    } else {
      // Collect positional args (skip flags and their values)
      const positional = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-')) { i++; continue; } // skip --flag value
        positional.push(args[i]);
      }
      if (positional.length > 0) {
        summary = positional.join(' ');
      } else {
        console.error(`${PREFIX} add requires a summary`);
        process.exit(1);
      }
    }
    const sevIdx = args.indexOf('--severity');
    severity = (sevIdx >= 0 ? args[sevIdx + 1] : 'MEDIUM') || 'MEDIUM';
    const modIdx = args.indexOf('--module');
    module = (modIdx >= 0 ? args[modIdx + 1] : 'manual') || 'manual';
  }

  let seq = 1;
  const existingTasks = scanManualTasks(MEMORY_DIR);
  for (const id of existingTasks.map(t => t.id)) {
    if (!id.startsWith('MANUAL-')) continue;
    const num = parseInt(id.slice(-3), 10);
    if (num >= seq) seq = num + 1;
  }
  const id = `MANUAL-${today.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;

  const dayPath = today.replace(/-/g, '/');
  const dir = join(MEMORY_DIR, dayPath);
  const manualFile = join(dir, 'manual.md');

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let content = '';
  if (existsSync(manualFile)) {
    content = readFileSync(manualFile, 'utf8').trimEnd();
  } else {
    content = [
      '---',
      `name: manual-${today}`,
      `description: Manual tasks created on ${today}`,
      'metadata:',
      '  type: project',
      `created: ${today}`,
      `accessed: ${today}`,
      'tier: short',
      '---',
      '',
    ].join('\n');
    writeFileSync(manualFile, content + '\n', 'utf8');
    stampMissingFields(manualFile);
    content = readFileSync(manualFile, 'utf8').trimEnd();
  }

  content += `\n- [ ] ${id} [${severity}] ${summary} (${today})\n      module: ${module}\n`;
  writeFileSync(manualFile, content + '\n', 'utf8');
  console.log(`${PREFIX} Added: ${id} [${severity}] ${summary} → memory/${dayPath}/manual.md`);
}

// ── remove ──

function handleRemove(id) {
  if (!id) { console.error(`${PREFIX} remove requires a task ID`); process.exit(1); }

  // Try MANUAL-* first
  const manualTasks = scanManualTasks(MEMORY_DIR);
  const manual = manualTasks.find(t => t.id === id);

  if (manual) {
    // Find the manual.md that contains this task and remove the line
    let found = false;
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.name !== 'manual.md') continue;
        let content = readFileSync(full, 'utf8');
        if (!content.includes(id)) continue;
        // Remove the task line(s): the `- [ ]` line and its trailing `module:` line
        const lines = content.split('\n');
        const filtered = [];
        let skip = false;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(`- [ ] ${id}`) || lines[i].includes(`- [x] ${id}`)) {
            skip = true;
            continue;
          }
          if (skip && /^\s{6}module:/.test(lines[i])) { skip = false; continue; }
          skip = false;
          filtered.push(lines[i]);
        }
        writeFileSync(full, filtered.join('\n'), 'utf8');
        console.log(`${PREFIX} Removed: ${id} from memory/${relative(MEMORY_DIR, full).replace(/\\/g, '/')}`);
        found = true;
        return;
      }
    }
    walk(MEMORY_DIR);
    if (!found) console.error(`${PREFIX} Task ${id} not found in any manual.md`);
  } else if (id.startsWith('SR-')) {
    // SR finding — mark as CLOSED in sharp-review.md
    let found = false;
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.name !== 'sharp-review.md') continue;
        let content = readFileSync(full, 'utf8');
        if (!content.includes(id)) continue;
        content = content.replace(
          new RegExp(`(### \\[${id}\\][\\s\\S]*?)\\*\\*Status:\\*\\*\\s*\\w+`, 'g'),
          '$1**Status:** CLOSED'
        );
        writeFileSync(full, content, 'utf8');
        console.log(`${PREFIX} Closed: ${id} in memory/${relative(MEMORY_DIR, full).replace(/\\/g, '/')}`);
        found = true;
        return;
      }
    }
    walk(MEMORY_DIR);
    if (!found) console.error(`${PREFIX} Finding ${id} not found in any sharp-review.md`);
  } else {
    console.error(`${PREFIX} Unknown ID format: ${id}. Use SR-* or MANUAL-* ID.`);
    process.exit(1);
  }
  process.exit(0);
}

// ── report (merged with check stats) ──

function handleReport(today) {
  const memDir = join(ROOT, '.claude', 'memory');
  if (!existsSync(memDir)) {
    console.log(`${PREFIX} No memory directory — nothing to report`);
    return;
  }

  const findings = scanMemoryForFindings(memDir);
  const manual = scanManualTasks(memDir);

  if (findings.length === 0 && manual.length === 0) {
    console.log(`${PREFIX} No tasks found`);
    return;
  }

  // Open items
  const allOpen = [
    ...findings.filter(f => f.status === 'open'),
    ...manual.filter(t => t.status === 'open'),
  ];

  if (allOpen.length === 0) {
    console.log(`${PREFIX} 0 open`);
  } else {
    const byMod = groupByModule(allOpen);
    const sorted = [...byMod].sort(([a], [b]) => a.localeCompare(b));

    console.log(`${PREFIX} ${allOpen.length} open`);
    for (const [mod, items] of sorted) {
      console.log(`  ## ${mod}`);
      for (const f of items) {
        const stale = isStale(f, today) ? ' ⚠ stale' : '';
        const likely = checkFileModified(f, today) ? ' ⚠ likely-resolved' : '';
        console.log(`  - [ ] ${f.id} [${f.severity}] ${f.summary} (${f.discovered})${stale}${likely}`);
      }
    }
    console.log('');
  }

  // Stats summary
  const open = findings.filter(f => f.status === 'open').length;
  const fixed = findings.filter(f => f.status === 'fixed').length;
  const closed = findings.filter(f => f.status === 'closed').length;
  const parts = [`${findings.length} findings`];
  if (open > 0) parts.push(`${open} open`);
  if (fixed > 0) parts.push(`${fixed} fixed`);
  if (closed > 0) parts.push(`${closed} closed`);
  if (manual.length > 0) parts.push(`${manual.length} manual`);
  console.log(`${PREFIX} ${parts.join(', ')}  (${VERSION})`);
}

// ── help ──

function handleHelp() {
  console.log(`todo — task management CLI

Usage:
  todo                      Show open tasks + stats (default)
  todo report               Same as above
  todo <summary>            Add a manual task (implicit add)
  todo add, -a <summary>    Add a manual task (explicit)
       --severity HIGH|MEDIUM|LOW   (default MEDIUM)
       --module name                (default 'manual')
  todo remove, rm, -r <id>  Remove manual task or close SR finding
  todo help                 Show this help`);
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const today = todayISO();

  // No args → report
  if (args.length === 0) return handleReport(today);

  const cmd = args[0];

  // Explicit subcommands
  if (cmd === '--add' || cmd === 'add' || cmd === '-a')    return handleAdd(args.slice(1), today, null);
  if (cmd === '--remove' || cmd === '--rm' || cmd === 'remove' || cmd === 'rm') return handleRemove(args[1]);
  if (cmd === '--report' || cmd === 'report')    return handleReport(today);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return handleHelp();

  // Implicit add: treat all args as the summary
  handleAdd(args.slice(1), today, args.join(' '));
}

main();
