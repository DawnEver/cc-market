#!/usr/bin/env node
// lint-prose.mjs — mechanical check of the writing-style rules (reference/writing-style.md).
//
// Splits the prose of .tex files into sentences (floats, TikZ and display maths skipped;
// \cite/\ref and inline maths replaced by tokens) and reports candidate violations of the
// rules a pattern can catch. Hits are candidates: the reviewer confirms or dismisses each
// (rule 34); the lint never replaces the review.
//
// Rule 44 (allocation wording) is checked on prose only; rule 46 (conclusion tense) only
// inside a section whose title starts with "Conclusion".
//
// Project-specific wording rules are not linted; the prose-reviewer agent applies them
// from the project's writing rules. The one exception is the English variant (rule 40): a
// line "English variant: British|American" in the nearest .claude/rules/*.md at or above cwd
// turns on the spelling check; without it no variant is enforced. A line "lint-prose off: id, id"
// there suppresses those hit ids (a project rule relaxing a generic one, e.g. 29-tail).
//
// Usage: node lint-prose.mjs [files...] [--json] [--english british|american] [--off id,id]
//   files      .tex files (default: Sections/*.tex under cwd, else *.tex in cwd)
//   --json     machine-readable output
//   --english  enforce this variant (overrides the project rules)
//   --off      hit ids to suppress (overrides "lint-prose off: id, id" in the project rules)
//
// Exit codes: 0 no hits, 1 hits, 2 usage error.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isMain } from '../shared/lib.mjs';

// [rule id, regex, message] — generic rules only.
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
// Rule 44: division of a quantity among parts; tested on prose only (LaTeX code removed).
const ALLOCATION = /\b(split|splits|splitting|shares?|portions?)\b|\bdivide[sd]?\b.*\bbetween\b/i;
// Rule 46: past tense for what the paper did; tested inside \section{Conclusion...} only.
const PAST_SELF = /\bThis (paper|study|work) (analysed|analyzed|presented|studied|showed|proposed|investigated|examined|developed|compared|demonstrated|derived|evaluated|quantified|identified)\b/i;
const OPENER = /^(In|At|Under|For|With|By|From|On|Unlike|Because|Although|When|While|As|After|Before|Using|Compared|Without|Through|Across|Between|Since|If|Below|Above|Near|To|Following|Grouped)\b/;
const SKIP_ENV = /\\(begin|end)\{(figure\*?|table\*?|tikzpicture|equation\*?|align\*?|tabular)\}/;

// ── Rule 40: English variant ──
// Each entry: [American stem, British stem, suffixes shared by both, kind]. A hit on one
// variant's form suggests the other's with the same suffix.
const PAIRS = [
  ...['behavior', 'color', 'labor', 'favor', 'honor', 'humor', 'neighbor', 'vapor', 'rigor', 'harbor',
    'flavor', 'odor', 'armor', 'endeavor', 'rumor', 'vigor']
    .map(w => [w, w.replace(/or$/, 'our'),
      ['', 's', 'al', 'ally', 'ed', 'ing', 'able', 'ite', 'ites', 'ful', 'less', 'hood'], '-or/-our']),
  ...['cent', 'fib', 'lit', 'theat', 'calib', 'lust', 'somb', 'millimet', 'centimet', 'kilomet', 'nanomet']
    .map(w => [w + 'er', w + 're', ['', 's'], '-er/-re']),
  ['center', 'centre', ['ed', 'ing', 'line', 'lines'], '-er/-re'],
  ['meter', 'metre', ['', 's'], '-er/-re, unit only'],
  ...['model', 'label', 'travel', 'cancel', 'signal', 'level', 'fuel', 'total', 'channel', 'tunnel', 'counsel']
    .map(w => [w, w + 'l', ['ed', 'ing', 'er', 'ers'], 'doubled l']),
  ['analog', 'analogue', ['', 's'], 'analog/analogue'],
  ['catalog', 'catalogue', ['', 's'], 'catalog/catalogue'],
  ['gray', 'grey', ['', 's', 'ish', 'scale', 'ed'], 'gray/grey'],
  ['program', 'programme', ['', 's'], 'program/programme, non-computer only'],
  ['toward', 'towards', [''], 'toward/towards'],
  ['aluminum', 'aluminium', [''], 'aluminum/aluminium'],
  ['defense', 'defence', ['', 's'], '-se/-ce'],
  ['offense', 'offence', ['', 's'], '-se/-ce'],
  ['skeptic', 'sceptic', ['', 'al', 'ally', 'ism'], 'sk/sc'],
  ['maneuver', 'manoeuvre', ['', 's'], 'maneuver/manoeuvre'],
  ['fulfill', 'fulfil', ['', 's'], 'fulfill/fulfil'],
];
// FOREIGN[variant]: other-variant word -> [suggestion, kind].
const FOREIGN = { british: new Map(), american: new Map() };
for (const [am, br, sufs, kind] of PAIRS) for (const x of sufs) {
  FOREIGN.british.set(am + x, [br + x, kind]);
  FOREIGN.american.set(br + x, [am + x, kind]);
}
const ZE = '(e|es|ed|ing|er|ers|ation|ations|ational|able)';
// Words spelt -ize / -ise in every variant (tested on the base form, also as a word ending).
const ALWAYS_IZE = /^(.*size|seize|prize|capsize|maize|baize|assize)$/;
const ALWAYS_ISE = new RegExp('(advise|exercise|comprise|surprise|revise|supervise|televise|devise|compromise'
  + '|enterprise|franchise|merchandise|premise|promise|raise|rise|wise|noise|poise|praise|precise|concise'
  + '|disguise|despise|expertise|chastise|incise|excise|apprise|mise|guise|cruise|bruise|treatise|paradise'
  + '|anise|reprise|improvise|advertise|cerise|valise|practise)$');
const caseLike = (from, to) => (from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);

/** [suggestion, kind] when `word` is the other variant's spelling, else null. */
function foreign(word, variant) {
  const w = word.toLowerCase();
  const hit = FOREIGN[variant].get(w);
  if (hit) return hit;
  let m;
  if (variant === 'british') {
    if ((m = w.match(new RegExp(`^(\\w+)yz${ZE}$`)))) return [`${m[1]}ys${m[2]}`, '-yze/-yse'];
    if ((m = w.match(new RegExp(`^(\\w+)iz${ZE}$`))) && !ALWAYS_IZE.test(`${m[1]}ize`))
      return [`${m[1]}is${m[2]}`, '-ize/-ise'];
  } else {
    // "analyses" is also the plural of "analysis": not flagged.
    if ((m = w.match(/^(ana|para|cata|electro|hydro|dia|auto)lys(e|ed|ing|er|ers)$/)))
      return [`${m[1]}lyz${m[2]}`, '-yze/-yse'];
    if ((m = w.match(new RegExp(`^(\\w+)is${ZE}$`))) && !ALWAYS_ISE.test(`${m[1]}ise`))
      return [`${m[1]}iz${m[2]}`, '-ize/-ise'];
  }
  return null;
}

// Environments with no prose to spell: maths, code, bibliography (published titles), quotations.
const NO_SPELL_ENV = /\\(begin|end)\{(equation|align|gather|multline|eqnarray|displaymath|math|verbatim|lstlisting|minted|comment|thebibliography|quote|quotation)\*?\}/g;
// Commands whose arguments are all code: keys, labels, paths, colour names, options.
const CODE_ALL = /\\(cite\w*|ref|eqref|autoref|[cC]ref|pageref|label|begin|end|includegraphics|input|include|usepackage|RequirePackage|documentclass|definecolor|colorlet|bibliography|bibliographystyle|bibitem|url|hypersetup|tikzset|pgfplotsset|setlength|newcommand|renewcommand|providecommand|usetikzlibrary|newenvironment|pagestyle|thispagestyle)\*?(\s*\[[^\]]*\]|\s*\{[^{}]*\})*/g;
// Commands whose first argument is code (a colour or a URL) and the rest prose.
const CODE_FIRST = /\\(color|textcolor|colorbox|fcolorbox|pagecolor|href)\s*(\[[^\]]*\])?\s*\{[^{}]*\}/g;

/** One LaTeX line reduced to its prose: comments, maths, quotations and code removed. */
function prose(line) {
  return line
    .replace(/\$\$?[^$]*\$\$?|\\\(.*?\\\)|\\\[.*?\\\]/g, ' ')
    .replace(/``.*?''|\\enquote\{[^}]*\}/g, ' ')
    .replace(CODE_ALL, ' ')
    .replace(CODE_FIRST, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\w./-]+\s*=\s*[\w!./-]+/g, ' ') // key=value options split over lines
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/\w*_\w*/g, ' ');
}

/** Spelling hits [{line, word, suggest, kind}] for words not in `variant` (british|american). */
export function spelling(src, variant) {
  const out = [];
  let depth = 0;
  src.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.replace(/(?<!\\)%.*/, '');
    const envs = [...s.matchAll(NO_SPELL_ENV)];
    for (const m of envs) depth = Math.max(0, depth + (m[1] === 'begin' ? 1 : -1));
    if (depth || envs.length) return;
    for (const m of prose(s).matchAll(/[A-Za-z]+/g)) {
      const f = foreign(m[0], variant);
      if (f) out.push({ line: i + 1, word: m[0], suggest: caseLike(m[0], f[0]), kind: f[1] });
    }
  });
  return out;
}

/** First match of `rx` in the nearest .claude/rules/*.md at or above `dir`, else null. */
function projectSetting(dir, rx) {
  for (let d = dir; ; d = dirname(d)) {
    const rules = join(d, '.claude', 'rules');
    if (existsSync(rules)) {
      for (const f of readdirSync(rules).sort()) {
        if (!f.endsWith('.md')) continue;
        const m = readFileSync(join(rules, f), 'utf8').match(rx);
        if (m) return m;
      }
    }
    if (dirname(d) === d) return null;
  }
}

/** English variant declared in the project rules ("English variant: British"), else null. */
export function findVariant(dir = process.cwd()) {
  const m = projectSetting(dir, /English variant\W*(British|American)\b/i);
  return m ? m[1].toLowerCase() : null;
}

const splitIds = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

/** Hit ids the project switches off ("lint-prose off: 29-tail, 26-verb"), else []. */
export function findOff(dir = process.cwd()) {
  const m = projectSetting(dir, /lint-prose off:[ \t]*([\w-]+(?:[ \t]*,[ \t]*[\w-]+)*)/i);
  return m ? splitIds(m[1]) : [];
}

/** Yield {line, text, section} sentences from LaTeX source (section: current \section title). */
export function sentences(src) {
  const out = [];
  let buf = [], start = null, depth = 0, section = '';
  const flush = () => {
    if (buf.length) {
      let p = buf.join(' ')
        .replace(/\\(cite|ref|eqref|label)\{[^}]*\}/g, 'X')
        .replace(/\$[^$]*\$/g, 'M');
      for (const s of p.split(/(?<=[.!?])\s+(?=[A-Z\\])/)) if (s.trim()) out.push({ line: start, text: s.trim(), section });
    }
    buf = []; start = null;
  };
  src.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.replace(/(?<!\\)%.*/, '').trim();
    const m = s.match(SKIP_ENV);
    if (m && m[1] === 'begin') { flush(); depth++; }
    if (depth) { if (m && m[1] === 'end') depth--; return; }
    const sec = s.match(/^\\section\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/);
    if (sec) section = sec[1].trim();
    if (!s || /^\\(sub)*section|^\\label|^\\noindent\\textbf/.test(s)) { flush(); return; }
    if (start === null) start = i + 1;
    buf.push(s);
  });
  flush();
  return out;
}

/** Return hits [{file, line, rule, message, text}] for one file's source. */
export function lint(src, file = '', { maxWords: maxW = 38, minWords: minW = 7, english = null, off = [] } = {}) {
  const hits = [];
  let prevOpen = false, prevIts = false;
  const tailsAllowed = off.includes('29-tail');
  for (const { line, text, section } of sentences(src)) {
    const plain = text.replace(/\\[a-zA-Z]+\*?(\{[^}]*\})?|[{}~]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = plain.split(' ');
    const add = (rule, message) => hits.push({ file, line, rule, message, text });
    // With ", which" allowed (29-tail off, rule 41), 31-relative no longer counts those clauses.
    const relPlain = tailsAllowed ? plain.replace(/,\s*which\b/gi, ',') : plain;
    for (const [id, rx, msg] of RULES) if (rx.test(id === '31-relative' ? relPlain : plain)) add(id, msg);
    if (ALLOCATION.test(prose(text)))
      add('44-allocation', "division of a quantity: write 'allocation' or 'distribution'");
    if (/^Conclusion/i.test(section) && PAST_SELF.test(plain))
      add('46-tense', "conclusion: present perfect, 'This paper has <verb>'");
    const open = OPENER.test(plain) && words.slice(0, 14).join(' ').includes(',');
    if (open && prevOpen) add('33-openers', 'two phrase-plus-comma openings in a row');
    const its = plain.startsWith('Its ');
    if (its && prevIts) add('26-its', "run of 'Its ...' openers");
    if (words.length > maxW) add('length', `${words.length} words: split at a logical link`);
    if (words.length < minW) add('bare', `${words.length} words: bare assertion? link it`);
    prevOpen = open; prevIts = its;
  }
  if (english) {
    for (const { line, word, suggest, kind } of spelling(src, english)) {
      hits.push({ file, line, rule: '40-english', message: `${word} -> ${suggest} (${english}; ${kind})`, text: word });
    }
  }
  return hits.filter(h => !off.includes(h.rule)).sort((a, b) => a.line - b.line);
}

function main(argv) {
  const files = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--off') opts.off = splitIds(argv[++i] || '');
    else if (argv[i] === '--english') {
      opts.english = (argv[++i] || '').toLowerCase();
      if (!['british', 'american'].includes(opts.english)) {
        console.error('lint-prose: --english takes british or american');
        return 2;
      }
    }
    else files.push(argv[i]);
  }
  if (!files.length) {
    const dir = existsSync('Sections') ? 'Sections' : '.';
    for (const f of readdirSync(dir).sort()) if (f.endsWith('.tex')) files.push(join(dir, f));
  }
  if (!files.length) { console.error('lint-prose: no .tex files'); return 2; }
  const english = opts.english || findVariant();
  const off = opts.off || findOff();
  const hits = files.flatMap(f => lint(readFileSync(f, 'utf8'), basename(f), { english, off }));
  if (opts.json) console.log(JSON.stringify(hits, null, 2));
  else {
    for (const h of hits) console.log(`${h.file}:${h.line}  [${h.rule}] ${h.message}\n    ${h.text.slice(0, 160)}`);
    console.log(`${hits.length} candidate hits`);
  }
  return hits.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
