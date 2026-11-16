// task-verbs.mjs — THE one list of task.js verbs. `task.js help` and `task.js verbs --json` print
// it; the guard's door and every doc point here instead of restating it. Dependency-free, so a
// hook can import it without loading the tasks library.
//
//   who: user  -- the user's /rem:task command (refused without its authority record)
//        agent -- any session          bound -- the session bound to the task
//   kind: append  -- appends ONE line to the bound task's JOURNAL.md
//         rewrite -- rewrites one journal line in place, then appends an audit line
//         read    -- writes nothing

export const VERBS = [
  { verb: 'open', who: 'user', kind: 'write', args: '<slug> "<goal>" [--scope <paths>] [--owner <who>]',
    does: 'open a task: .claude/tasks/<slug>/{TASK,JOURNAL}.md' },
  { verb: 'close', who: 'user', kind: 'write', args: '<slug> ["<reason>"] [--journal-only D<n>,...]',
    does: 'refuse until every item is closed and every decision distilled, then archive into memory' },
  { verb: 'request', who: 'agent', kind: 'write', args: '<slug> "<goal>"',
    does: 'ask the user to authorize an open; they reply `approve <code>`' },
  { verb: 'log', who: 'bound', kind: 'append', args: '"<progress>"', does: 'progress line' },
  { verb: 'decide', who: 'bound', kind: 'append', args: '"<decision>"', does: 'decision, numbered D<n>' },
  { verb: 'open-item', who: 'bound', kind: 'append', args: '"<text>"', does: 'open item, numbered O<n>' },
  { verb: 'close-item', who: 'bound', kind: 'append', args: 'O<n> "<how>"', does: 'close an open item' },
  { verb: 'handoff', who: 'bound', kind: 'append', args: '"<text>"', does: 'what the next session picks up' },
  { verb: 'translate', who: 'bound', kind: 'rewrite', args: '--line <n> "<english line>"',
    does: 'turn a foreign-script line into English; the prefix stays byte-identical' },
  { verb: 'amend', who: 'bound', kind: 'rewrite', args: '--line <n> "<line>" --reason "<why>" --approved "<user\'s words>"',
    does: 'correct a line that is WRONG as written, with the user\'s approval (a changed mind is a new decision)' },
  { verb: 'place', who: 'agent', kind: 'write', args: '<slug>',
    does: 'copy an open task of this checkout into the main checkout when absent there' },
  { verb: 'commit-record', who: 'bound', kind: 'write', args: '<slug>',
    does: 'copy the open task\'s record from the main checkout into this worktree to commit it' },
  { verb: 'status', who: 'agent', kind: 'read', args: '[<slug>] [--distill]',
    does: 'the bound (or named) task in <=2 KB; --distill adds the undistilled decisions' },
  { verb: 'list', who: 'agent', kind: 'read', args: '', does: 'every task: slug, status, open items, decisions, goal' },
  { verb: 'show', who: 'agent', kind: 'read', args: '[<slug>]', does: 'TASK.md and the whole journal (an archived task too)' },
  { verb: 'help', who: 'agent', kind: 'read', args: '', does: 'this table' },
  { verb: 'verbs', who: 'agent', kind: 'read', args: '--json', does: 'this table as JSON' },
];

// Every verb is run as `task.js <verb>`; --task <slug> names the task where a verb needs the bound one.
export const verbsOf = kind => VERBS.filter(v => v.kind === kind).map(v => v.verb);

export function helpText() {
  const width = Math.max(...VERBS.map(v => `${v.verb} ${v.args}`.trim().length));
  return ['task.js <verb> -- who: user = the user\'s /rem:task; bound = the session bound to the task (--task <slug>)', '',
    ...VERBS.map(v => `  ${`${v.verb} ${v.args}`.trim().padEnd(width)}  [${v.who}] ${v.does}`)].join('\n');
}
