#!/usr/bin/env node
// lint-prose.mjs — mechanical check of the writing-style rules (reference/writing-style.md).
//
// Splits the prose of .tex files into sentences (floats, TikZ and display maths skipped;
// \cite/\ref and inline maths replaced by tokens) and reports candidate violations of the
// rules a pattern can catch. Hits are candidates: the reviewer confirms or dismisses each
// (rule 34); the lint never replaces the review.
//
// Usage: node lint-prose.mjs [files...] [--config path] [--json]
//   files     .tex files (default: Sections/*.tex under cwd, else *.tex in cwd)
//   --config  project JSON with extra patterns (default: .claude/prose-lint.json found
//             upwards from cwd): {"patterns": [{"id","regex","message","flags"?}],
//             "maxWords"?: 38, "minWords"?: 7}
//   --json    machine-readable output
//
// Exit codes: 0 no hits, 1 hits, 2 usage error.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isMain } from '../shared/lib.mjs';

// [rule id, regex, message] — generic rules only; project wording goes in --config.
export const RULES = [
  ['33-whereas', /\bwhereas\b/i, "no 'whereas': two sentences, contrast marked in the second"],
  ['31-relative', /\b(that|which|who|whose)\b/i, 'relative or noun clause: adjective, phrase or own sentence'],
  ['29-tail', /,\s*(which|whose|computed|giving|resulting)\b/i, 'trailing clause: give the fact its own sentence'],
  ['22-nested', /\b(in which|so that)\b/i, 'nested clause'],
  ['26-verb', /\b(sees?|feeds?|decides?|meets?|pursu\w*|wants?|knows?|case by case)\b/i,
    'personified or spoken verb: use the physical action'],
  ['22-announce', /\b(novelty|attribution)\b/i, 'announced novelty or vague wording'],
  ['25-vague', /^(There|This split|These studies)\b/, 'vague subject'],
  ['22-nounclause', /^(How|What)\b/, 'noun-clause subject'],
  ['size', /\bhardly\b/i, "give the size of a small change or 'changes little'"],
];
const OPENER = /^(In|At|Under|For|With|By|From|On|Unlike|Because|Although|When|While|As|After|Before|Using|Compared|Without|Through|Across|Between|Since|If|Below|Above|Near|To|Following|Grouped)\b/;
const SKIP_ENV = /\\(begin|end)\{(figure\*?|table\*?|tikzpicture|equation\*?|align\*?|tabular)\}/;

/** Yield {line, text} sentences from LaTeX source. */
export function sentences(src) {
  const out = [];
  let buf = [], start = null, depth = 0;
  const flush = () => {
    if (buf.length) {
      let p = buf.join(' ')
        .replace(/\\(cite|ref|eqref|label)\{[^}]*\}/g, 'X')
        .replace(/\$[^$]*\$/g, 'M');
      for (const s of p.split(/(?<=[.!?])\s+(?=[A-Z\\])/)) if (s.trim()) out.push({ line: start, text: s.trim() });
    }
    buf = []; start = null;
  };
  src.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.replace(/(?<!\\)%.*/, '').trim();
    const m = s.match(SKIP_ENV);
    if (m && m[1] === 'begin') { flush(); depth++; }
    if (depth) { if (m && m[1] === 'end') depth--; return; }
    if (!s || /^\\(sub)*section|^\\label|^\\noindent\\textbf/.test(s)) { flush(); return; }
    if (start === null) start = i + 1;
    buf.push(s);
  });
  flush();
  return out;
}

/** Return hits [{file, line, rule, message, text}] for one file's source. */
export function lint(src, file = '', cfg = {}) {
  const rules = [...RULES, ...(cfg.patterns || []).map(p => [p.id, new RegExp(p.regex, p.flags ?? 'i'), p.message])];
  const maxW = cfg.maxWords ?? 38, minW = cfg.minWords ?? 7;
  const hits = [];
  let prevOpen = false, prevIts = false;
  for (const { line, text } of sentences(src)) {
    const plain = text.replace(/\\[a-zA-Z]+\*?(\{[^}]*\})?|[{}~]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = plain.split(' ');
    const add = (rule, message) => hits.push({ file, line, rule, message, text });
    for (const [id, rx, msg] of rules) if (rx.test(plain)) add(id, msg);
    const open = OPENER.test(plain) && words.slice(0, 14).join(' ').includes(',');
    if (open && prevOpen) add('33-openers', 'two phrase-plus-comma openings in a row');
    const its = plain.startsWith('Its ');
    if (its && prevIts) add('26-its', "run of 'Its ...' openers");
    if (words.length > maxW) add('length', `${words.length} words: split at a logical link`);
    if (words.length < minW) add('bare', `${words.length} words: bare assertion? link it`);
    prevOpen = open; prevIts = its;
  }
  return hits;
}

function findConfig(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const p = join(d, '.claude', 'prose-lint.json');
    if (existsSync(p)) return p;
    if (dirname(d) === d) return null;
  }
}

function main(argv) {
  const files = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--config') opts.config = argv[++i];
    else files.push(argv[i]);
  }
  if (!files.length) {
    const dir = existsSync('Sections') ? 'Sections' : '.';
    for (const f of readdirSync(dir).sort()) if (f.endsWith('.tex')) files.push(join(dir, f));
  }
  if (!files.length) { console.error('lint-prose: no .tex files'); return 2; }
  const cfgPath = opts.config ?? findConfig(process.cwd());
  const cfg = cfgPath ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  const hits = files.flatMap(f => lint(readFileSync(f, 'utf8'), basename(f), cfg));
  if (opts.json) console.log(JSON.stringify(hits, null, 2));
  else {
    for (const h of hits) console.log(`${h.file}:${h.line}  [${h.rule}] ${h.message}\n    ${h.text.slice(0, 160)}`);
    console.log(`${hits.length} candidate hits${cfgPath ? ` (config ${cfgPath})` : ''}`);
  }
  return hits.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
