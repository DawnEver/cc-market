#!/usr/bin/env node
// word-count.mjs — count words in a LaTeX project with texcount.
//
// Finds main.tex (project root, the single `*/main.tex` beneath it, or an explicit
// path argument), runs `texcount -inc -sum -sub=section`, and prints a per-section
// table plus the grand total. The bibliography is never counted: references live in
// .bib files, outside the \input chain.
//
// Usage: node word-count.mjs [root] [--target N] [--json] [--texcount "cmd"]
//   root       LaTeX project dir or path to main.tex (default: cwd)
//   --target   word-count target for the progress line (e.g. 8000)
//   --json     emit machine-readable JSON instead of the table
//   --texcount texcount command (default: $TEXCOUNT or "texcount")
//
// Exit codes: 0 ok, 1 texcount missing or failed, 2 usage/discovery error.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// texcount 3.x section subcount line: "  7+1+0 (1/0/0/0) Section: Abstract".
// Per-section sum = text + headers + captions.
const SECTION_RE = /^\s*(\d+)\+(\d+)\+(\d+)\s+\(\S+\)\s+Section:\s+(.+)$/;
// -sum summary line; the LAST one in the output is the grand total (Sum of files block).
const SUM_RE = /^Sum count:\s*(\d+)$/;

/** Locate main.tex: an explicit file arg, the root itself, or a single depth-1 subdir. */
export function findMainTex(root) {
  const dir = resolve(root);
  if (statSync(dir, { throwIfNoEntry: false })?.isFile()) {
    return { dir: dirname(dir), main: basename(dir) };
  }
  if (existsSync(join(dir, 'main.tex'))) return { dir, main: 'main.tex' };
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .filter((d) => existsSync(join(d, 'main.tex')));
  if (candidates.length === 0) {
    throw new Error(`no main.tex found under ${dir} (searched the root and its subdirectories)`);
  }
  if (candidates.length > 1) {
    throw new Error(`multiple main.tex found; pick one explicitly:\n  ${candidates.join('\n  ')}`);
  }
  return { dir: candidates[0], main: 'main.tex' };
}

/** Split a command line into tokens, honoring double quotes (for paths with spaces). */
export function tokenize(cmdline) {
  const tokens = [];
  for (const m of cmdline.matchAll(/"([^"]*)"|(\S+)/g)) tokens.push(m[1] ?? m[2]);
  return tokens;
}

/** Run texcount from the project dir; `error` is set when the binary is missing. */
export function runTexcount(cwd, main, command) {
  const [cmd, ...args] = tokenize(command);
  return spawnSync(cmd, [...args, '-inc', '-sum', '-sub=section', main], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
}

/** Parse texcount output into { sections, total }. Handles LF and CRLF line endings. */
export function parseTexcount(output) {
  const sections = [];
  let total = null;
  for (const line of output.split(/\r?\n/)) {
    const s = line.match(SECTION_RE);
    if (s) {
      const text = Number(s[1]);
      const headers = Number(s[2]);
      const captions = Number(s[3]);
      sections.push({ name: s[4], text, headers, captions, sum: text + headers + captions });
      continue;
    }
    const t = line.match(SUM_RE);
    if (t) total = Number(t[1]);
  }
  if (total === null) {
    throw new Error('could not parse texcount output: no "Sum count" line found');
  }
  return { sections, total };
}

/** Aligned per-section table plus the grand total. */
export function formatTable(sections, total) {
  const width = Math.max(...sections.map((s) => s.name.length), 'Section'.length);
  const rows = sections.map((s) => `${s.name.padEnd(width)}  ${String(s.sum).padStart(5)}`);
  return [
    `${'Section'.padEnd(width)}  Words`,
    `${'-'.repeat(width)}  -----`,
    ...rows,
    `${'Total (excl. references)'.padEnd(width)}  ${String(total).padStart(5)}`,
  ].join('\n');
}

export function fmt(n) {
  return n.toLocaleString('en-US');
}

export function targetLine(total, target) {
  const pct = Math.round((total / target) * 100);
  return `Target: ${fmt(total)} / ${fmt(target)} (${pct}%)`;
}

function main(argv) {
  const opts = { root: '.', target: null, json: false, texcount: process.env.TEXCOUNT || 'texcount' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') opts.target = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--texcount') opts.texcount = argv[++i];
    else if (a.startsWith('--')) return fail(2, `unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length > 1) return fail(2, 'too many arguments (expected one root)');
  if (positional.length === 1) opts.root = positional[0];
  if (opts.target !== null && !Number.isFinite(opts.target)) {
    return fail(2, '--target must be a number');
  }

  let found;
  try {
    found = findMainTex(opts.root);
  } catch (e) {
    return fail(2, e.message);
  }

  const r = runTexcount(found.dir, found.main, opts.texcount);
  if (r.error) {
    return fail(1, `texcount not found: ${opts.texcount} — install it (tlmgr install texcount)`);
  }
  if (r.status !== 0) {
    return fail(1, `texcount failed (exit ${r.status}):\n${(r.stderr || r.stdout).trim()}`);
  }

  let parsed;
  try {
    parsed = parseTexcount(r.stdout);
  } catch (e) {
    return fail(1, e.message);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      root: found.dir,
      main: found.main,
      total: parsed.total,
      target: opts.target,
      sections: parsed.sections,
    }, null, 2));
  } else {
    console.log(`Counting ${found.main} in ${found.dir}`);
    console.log(formatTable(parsed.sections, parsed.total));
    if (opts.target !== null) console.log(targetLine(parsed.total, opts.target));
  }
  return 0;
}

function fail(code, message) {
  console.error(message);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
