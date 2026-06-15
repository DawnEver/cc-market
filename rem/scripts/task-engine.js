#!/usr/bin/env node
// task-engine.js — CLI entry point for task management (owned by rem)
// Pure logic lives in task-lib.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { todayISO, findMemoryScope } from '../lib.mjs';
import {
  ROOT,
  scanManualTasks,
  scanAllScopes, formatScopeReport,
  markFinding,
} from './task-lib.mjs';

const PREFIX = '[task-engine]';

// Version from plugin.json (stable across cache updates)
let VERSION = 'dev';
try {
  const pluginJson = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
  VERSION = 'v' + JSON.parse(readFileSync(pluginJson, 'utf8')).version;
} catch {}

// ── add ──

function handleAdd(args, today, implicitSummary) {
  let summary, severity = 'MEDIUM', module = 'manual';
  // --scope flag support
  const scopeIdx = args.indexOf('--scope');
  let targetScope = findMemoryScope();
  if (scopeIdx >= 0 && args[scopeIdx + 1]) {
    targetScope = join(ROOT, args[scopeIdx + 1]);
    args = args.filter((_, i) => i !== scopeIdx && i !== scopeIdx + 1);
  }
  const targetMemDir = join(targetScope, '.claude', 'memory');

  if (implicitSummary) {
    summary = implicitSummary;
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
      const positional = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-')) { i++; continue; }
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
  const existingTasks = scanManualTasks(targetMemDir);
  for (const id of existingTasks.map(t => t.id)) {
    if (!id.startsWith('MANUAL-')) continue;
    const num = parseInt(id.slice(-3), 10);
    if (num >= seq) seq = num + 1;
  }
  const id = `MANUAL-${today.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;

  const dayPath = today.replace(/-/g, '/');
  const dir = join(targetMemDir, dayPath);
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
      '---',
      '',
    ].join('\n');
    writeFileSync(manualFile, content + '\n', 'utf8');
  }

  content += `\n- [ ] ${id} [${severity}] ${summary} (${today})\n      module: ${module}\n`;
  writeFileSync(manualFile, content + '\n', 'utf8');
  const relPath = relative(ROOT, manualFile).replace(/\\/g, '/');
  console.log(`${PREFIX} Added: ${id} [${severity}] ${summary} → ${relPath}`);
}

// ── remove ──

function handleRemove(id) {
  if (!id) { console.error(`${PREFIX} remove requires a task ID`); process.exit(1); }

  const scope = findMemoryScope();
  const memDir = join(scope, '.claude', 'memory');

  const manualTasks = scanManualTasks(memDir);
  const manual = manualTasks.find(t => t.id === id);

  if (manual) {
    let found = false;
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.name !== 'manual.md') continue;
        let content = readFileSync(full, 'utf8');
        if (!content.includes(id)) continue;
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
        console.log(`${PREFIX} Removed: ${id} from memory/${relative(memDir, full).replace(/\\/g, '/')}`);
        found = true;
        return;
      }
    }
    walk(memDir);
    if (!found) console.error(`${PREFIX} Task ${id} not found in any manual.md`);
  } else if (id.startsWith('SR-')) {
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
        console.log(`${PREFIX} Closed: ${id} in memory/${relative(memDir, full).replace(/\\/g, '/')}`);
        found = true;
        return;
      }
    }
    walk(memDir);
    if (!found) console.error(`${PREFIX} Finding ${id} not found in any sharp-review.md`);
  } else {
    console.error(`${PREFIX} Unknown ID format: ${id}. Use SR-* or MANUAL-* ID.`);
    process.exit(1);
  }
  process.exit(0);
}

// ── mark ──

function handleMark(id, status) {
  if (!id || !status) {
    console.error(`${PREFIX} mark requires <id> <open|fixed|closed>`);
    process.exit(1);
  }
  const scope = findMemoryScope();
  const memDir = join(scope, '.claude', 'memory');
  const result = markFinding(memDir, id, status);
  if (!result.found) {
    console.error(`${PREFIX} ${result.error}`);
    process.exit(1);
  }
  const rel = relative(memDir, result.file).replace(/\\/g, '/');
  console.log(`${PREFIX} Marked ${id} as ${status.toUpperCase()} in memory/${rel}`);
}

// ── report (multi-scope) ──

function handleReport(today) {
  const { findings, manual } = scanAllScopes();

  if (findings.length === 0 && manual.length === 0) {
    console.log(`${PREFIX} No tasks found`);
    return;
  }

  const report = formatScopeReport(findings, manual, today);
  if (!report.includes('total:')) {
    // formatScopeReport returned minimal output — print stats directly
    const openCount = findings.filter(f => f.status === 'open').length + manual.filter(t => t.status === 'open').length;
    console.log(`${PREFIX} ${openCount} open`);
  } else {
    console.log(report);
  }

  // Stats summary (single scope for now — legacy)
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
  todo report, check        Same as above
  todo <summary>            Add a manual task (implicit add)
  todo add, -a <summary>    Add a manual task (explicit)
       --severity HIGH|MEDIUM|LOW   (default MEDIUM)
       --module name                (default 'manual')
       --scope path                 target scope (default: auto-detect from cwd)
  todo remove, rm, -r <id>  Remove manual task or close SR finding
  todo mark <id> <status>   Set status: open | fixed | closed
  todo help                 Show this help`);
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const today = todayISO();

  if (args.length === 0) return handleReport(today);

  const cmd = args[0];

  if (cmd === '--add' || cmd === 'add' || cmd === '-a')    return handleAdd(args.slice(1), today, null);
  if (cmd === '--remove' || cmd === '--rm' || cmd === 'remove' || cmd === 'rm') return handleRemove(args[1]);
  if (cmd === '--mark' || cmd === 'mark' || cmd === '-m') return handleMark(args[1], args[2]);
  if (cmd === '--report' || cmd === 'report' || cmd === 'check')    return handleReport(today);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return handleHelp();

  handleAdd(args.slice(1), today, args.join(' '));
}

main();
