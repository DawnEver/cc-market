#!/usr/bin/env node
// Immediate-save CLI for explicit "remember this" requests — host-agnostic
// (works on Claude Code and Codex alike, since it's just a CLI the agent runs).
//
//   node remember.js --name <kebab-slug> --type <user|feedback|project|reference>
//                    --body <text> [--scope <dir|auto>] [--description <text>] [--update]
//   (body may also be piped on stdin instead of --body)
//
// Writes .claude/memory/YYYY/MM/DD/<slug>.md with generated frontmatter (volatile
// fields forbidden — enforced), creates the _meta.json entry, and upserts the
// MEMORY.md index. Refuses to overwrite a different-bodied file without --update.
// Prints the created/updated file path.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { upsertIndexEntry } from '../shared/stamp.mjs';
import {
  findMemoryScope, saveMemoryMeta, loadMemoryState,
  isInsideDir, todayISO, dateToPath,
} from './lib.mjs';

const TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VOLATILE_RE = /^(accessed|count|tier|dropped)\s*:/m;

// YAML-safe scalar for frontmatter values that come from free text: emit plain
// only for a conservative safe alphabet, otherwise double-quote via
// JSON.stringify (a JSON string is a valid YAML double-quoted scalar).
const PLAIN_SAFE_RE = /^[\w][\w ./()+-]*$/u;
function yamlScalar(s) {
  return PLAIN_SAFE_RE.test(s) ? s : JSON.stringify(s);
}

function usage(msg) {
  if (msg) console.error(`[remember] ${msg}`);
  console.error('Usage: node remember.js --name <kebab-slug> --type <user|feedback|project|reference> --body <text> [--scope <dir|auto>] [--description <text>] [--update]');
  process.exit(1);
}

// ── Args ──
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}
const name = argValue('--name');
const type = argValue('--type');
const scopeArg = argValue('--scope') || 'auto';
const description = argValue('--description');
const update = args.includes('--update');
let body = argValue('--body');

if (!name || !NAME_RE.test(name)) usage(`--name must be a kebab-case slug, got: ${name || '(missing)'}`);
if (!type || !TYPES.has(type)) usage(`--type must be one of ${[...TYPES].join('|')}, got: ${type || '(missing)'}`);

if (body === null && !process.stdin.isTTY) {
  body = readFileSync(0, 'utf8');
}
if (!body || !body.trim()) usage('--body is required (or pipe body on stdin)');
body = body.trim() + '\n';

// Volatile metadata never belongs in file content (frontmatter or body) — it lives
// in _meta.json only.
if (VOLATILE_RE.test(body)) {
  usage('body contains a volatile metadata field (accessed|count|tier|dropped) — these live in _meta.json, never in the file');
}

// ── Scope & path security ──
const scopeRoot = scopeArg === 'auto' ? findMemoryScope() : resolve(scopeArg);
const memDir = join(scopeRoot, '.claude', 'memory');
const date = todayISO();
const relPath = `${dateToPath()}/${name}.md`;
const file = resolve(memDir, relPath);
if (!isInsideDir(memDir, file)) {
  console.error(`[remember] path traversal denied: ${relPath}`);
  process.exit(1);
}

// ── Content ──
if (description && /[\r\n]/.test(description)) {
  usage('--description must be a single line (no newlines)');
}
const desc = description
  || body.split('\n').map(l => l.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim())
    .find(l => l.length > 0)?.slice(0, 80)
  || name;
// metadata.type is nested YAML — prune-memory.js and recall.js read it via the
// structured parser as metadata.type. A flat dotted key would be invisible to
// them (feedback entries would lose their eviction exemption and recall weight).
const content = `---\nname: ${name}\ndescription: ${yamlScalar(desc)}\nmetadata:\n  type: ${type}\n---\n\n${body}`;

// ── Overwrite guard ──
if (existsSync(file)) {
  const existing = readFileSync(file, 'utf8');
  if (existing === content) {
    console.log(file);
    process.exit(0);
  }
  if (!update) {
    console.error(`[remember] file exists with different content: ${file}`);
    console.error('[remember] re-run with --update to overwrite');
    process.exit(1);
  }
}

// Snapshot state BEFORE writing — loadMemoryState backfills on-disk files, so a
// post-write snapshot would always contain relPath and skip the meta entry.
const isNewEntry = !loadMemoryState(scopeRoot).has(relPath);

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, content, 'utf8');

// ── Volatile metadata (new entries only — updates keep their history) ──
if (isNewEntry) {
  saveMemoryMeta(scopeRoot, relPath, { accessed: date, count: 1, tier: 'short' });
}

// ── Index upsert ──
upsertIndexEntry(scopeRoot, relPath, { name, date });

console.log(file);
