#!/usr/bin/env node
// fake-forge.mjs — test stand-in for the forge CLI rem reaches through REM_FORGE (scripts/task-forge.mjs): the
// same three issue verbs, printing the same JSON. ONE forge per directory $REM_FAKE_FORGE; a repo is its
// `origin` URL (two clones of one repo on two "machines" share it), else its git common dir. Labels are kept.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.env.REM_FAKE_FORGE;
if (!dir) { console.error('REM_FAKE_FORGE is unset'); process.exit(2); }
const git = args => spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim();
const repo = git(['config', '--get', 'remote.origin.url']) || git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
if (!repo) { console.error(`no repo at ${process.cwd()}`); process.exit(1); }
const file = path.join(dir, 'issues.json');
const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const save = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(all, null, 1)); };
const opt = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const view = i => ({ number: i.number, url: i.url, state: i.state, title: i.title });

const [noun, verb, ...args] = process.argv.slice(2);
if (noun !== 'issue' || !args.includes('--json')) { console.error(`unsupported: ${process.argv.slice(2).join(' ')}`); process.exit(2); }
const mine = all.filter(i => i.repo === repo);
if (verb === 'list') {
  const label = opt(args, '--label');
  console.log(JSON.stringify(mine.filter(i => !label || i.labels.includes(label)).map(view)));
} else if (verb === 'create') {
  const number = mine.length + 1;
  const issue = { repo, number, url: `https://forge.test/${encodeURIComponent(repo)}/issues/${number}`, state: 'open',
    title: opt(args, '--title'), body: opt(args, '--body') || '', labels: opt(args, '--label') ? [opt(args, '--label')] : [] };
  all.push(issue); save();
  console.log(JSON.stringify(view(issue)));
} else if (verb === 'close') {
  const issue = mine.find(i => i.number === Number(args[0]));
  if (!issue) { console.error(`no issue #${args[0]}`); process.exit(1); }
  issue.state = 'closed'; save();
  console.log(JSON.stringify(view(issue)));
} else { console.error(`unsupported verb ${verb}`); process.exit(2); }
