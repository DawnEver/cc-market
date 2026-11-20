// task-forge.mjs — the ONE door from rem to the forge, for a task's identity (D88, cc-market #44): a task IS one
// forge issue, labelled `task:<slug>`, on the forge of the repo that hosts the task. The per-machine ledger
// (.claude/tasks/<slug>/) is that machine's journal of it; TASK.md's `issue:` names the issue.
//
// rem holds no forge credential and cannot import Python, so it spawns ONE command named by ONE variable,
// REM_FORGE: a JSON array, the argv prefix of the family's forge CLI (dev-lab writes it with LAB_COMMONS_HOME:
// `python -m dev_lab.dev.remhome --install`, the interpreter that install resolved, then `-m dev_lab.dev.forge`).
// Unset, every verb that needs the forge refuses naming that command -- rem never guesses an interpreter.
// The verbs, run in the hosting repo's checkout (the CLI resolves the forge from it), each printing JSON:
//   issue list --label task:<slug> --state all --json         -> [{number, url, state, title}, ...]
//   issue create --title <t> --body <b> --label task:<slug> --json -> {number, url, state, title}
//   issue close <number> --json                               -> {number, url, state, title}

import { spawnSync } from '../shared/spawn.mjs';

export const FORGE_ENV = 'REM_FORGE';
export const FORGE_DOOR = `${FORGE_ENV} is unset, so rem cannot reach the forge that holds a task's identity (its `
  + 'task:<slug> issue). Door: `python -m dev_lab.dev.remhome --install` (dev-lab) writes it into the user Claude '
  + 'settings; restart the session';
export const label = slug => `task:${slug}`;

// The argv prefix REM_FORGE names; throws FORGE_DOOR when unset, naming the variable when malformed.
export function forgeCommand(env = process.env) {
  const raw = env[FORGE_ENV];
  if (!raw) throw new Error(FORGE_DOOR);
  let argv;
  try { argv = JSON.parse(raw); } catch { argv = null; }
  if (!Array.isArray(argv) || !argv.length || !argv.every(a => typeof a === 'string' && a)) {
    throw new Error(`${FORGE_ENV} must be a JSON array of strings (the forge CLI's argv prefix); got ${raw.slice(0, 80)}`);
  }
  return argv;
}

function run(cwd, args, env) {
  const [cmd, ...pre] = forgeCommand(env);
  const r = spawnSync(cmd, [...pre, ...args], { cwd, encoding: 'utf8', env });
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || r.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new Error(`the forge refused \`issue ${args[1] ?? ''}\` from ${cwd}: ${why || `exit ${r.status}`}`);
  }
  try { return JSON.parse(r.stdout); } catch { throw new Error(`the forge answered \`issue ${args[1]}\` with no JSON: ${r.stdout.slice(0, 120)}`); }
}

// Every issue labelled task:<slug> on the forge of the repo checked out at `checkout` (any state).
export function findTaskIssues(checkout, slug, env = process.env) {
  const rows = run(checkout, ['issue', 'list', '--label', label(slug), '--state', 'all', '--json'], env);
  return (Array.isArray(rows) ? rows : []).filter(i => Number.isInteger(i?.number) && typeof i.url === 'string');
}

export function openTaskIssue(checkout, slug, goal, env = process.env) {
  return run(checkout, ['issue', 'create', '--title', `task: ${slug} -- ${goal}`,
    '--body', `The identity of task \`${slug}\` (rem tasks, D88): each machine's ledger journals it and links here.\n\nGoal: ${goal}`,
    '--label', label(slug), '--json'], env);
}

export function closeTaskIssue(checkout, number, env = process.env) {
  return run(checkout, ['issue', 'close', String(number), '--json'], env);
}

// The issue number a TASK.md `issue:` URL names (…/issues/<n>), or null.
export const issueNumber = url => Number(String(url || '').match(/\/issues\/(\d+)\/?$/)?.[1]) || null;
