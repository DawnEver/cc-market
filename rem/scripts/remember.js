#!/usr/bin/env node
// Immediate-save CLI for explicit "remember this" requests — host-agnostic
// (works on Claude Code and Codex alike, since it's just a CLI the agent runs).
//
//   node remember.js --name <kebab-slug> --type <user|feedback|project|reference>
//                    --body <text> [--scope <dir|auto>] [--description <text>] [--update]
//   (body may also be piped on stdin instead of --body)
//
// Writes .claude/memory/YYYY/MM/DD/<slug>.md with generated frontmatter (volatile
// fields forbidden — enforced) and regenerates the derived index. Refuses a different-bodied file without --update, which APPENDS (never drops).
// Prints the created/updated file path.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import {
  findMemoryScope, rebuildIndex,
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

// Access bookkeeping never belongs in an entry: reading leaves no trace.
if (VOLATILE_RE.test(body)) {
  usage('body contains a volatile metadata field (accessed|count|tier|dropped) — an entry carries no access bookkeeping');
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
// metadata.type is nested YAML — recall and the index read it as metadata.type;
// a flat dotted key would be invisible to them (feedback would lose its weight).
let content = `---\nname: ${name}\ndescription: ${yamlScalar(desc)}\nmetadata:\n  type: ${type}\n---\n\n${body}`;

// ── Overwrite guard ──
// Memory keeps everything: --update never drops prior text. A body that already contains the
// old body is written as-is; any other revision is APPENDED under a dated heading.
if (existsSync(file)) {
  const existing = readFileSync(file, 'utf8');
  if (existing === content) {
    console.log(file);
    process.exit(0);
  }
  if (!update) {
    console.error(`[remember] file exists with different content: ${file}`);
    console.error('[remember] re-run with --update to append the revision');
    process.exit(1);
  }
  const oldBody = existing.replace(/^---\n[\s\S]*?\n---\n\n?/, '').trim();
  if (!body.includes(oldBody)) content = `${existing.trimEnd()}\n\n## Update ${date}\n\n${body}`;
}

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, content, 'utf8');

rebuildIndex(scopeRoot);

console.log(file);
