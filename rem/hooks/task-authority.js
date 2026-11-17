// task-authority.js — the task half of rem's ONE UserPromptSubmit hook (hooks/user-prompt.js): the
// user's own prompt is the only authority over tasks, and this records each form of it. Never blocks.
//   - `/rem:task open|close <slug> …`, or `approve <code>` for an agent's live request: record that
//     authority (scripts/authority.mjs) so openTask/closeTask may proceed once;
//   - a FIRST line `task: <slug>`: bind this session to that open task (tasks.mjs bindSession) -- the
//     ONE session -> task record, which rem reads and other tools read as a documented contract
//     (skills/rem/reference/tasks.md § The binding file). The session is the one a git hook run inside
//     it names (shared/hook-facts.mjs hookSessionKey: a Codex thread, never its parent).
// Any other prompt records nothing. Node only: no project interpreter takes part, so a broken venv
// cannot stop a binding.
// REM_AUTHORITY_PROBE=1 also logs the raw prompt to the store's probe.jsonl (live check).
// Every prompt runs this: a prompt that cannot be the command (no "task" nor an approval word) returns
// before the authority library (crypto, locking) is even loaded.

// What a binding prompt tells the session: its task and PR heads, or why nothing was bound.
async function bind(cwd, payload, slug) {
  const { bindSession } = await import('../scripts/tasks.mjs');
  const { hookSessionKey } = await import('../shared/hook-facts.mjs');
  try {
    const task = bindSession(cwd, hookSessionKey(payload) || payload.session_id || '', slug);
    return `this session works on task ${task}: its PR heads are pr/${slug}/<feature> (never a bare pr/${slug}).`;
  } catch (refused) {
    return `\`task: ${slug}\` binds nothing: ${refused.message}`;
  }
}

/** Record the authority a prompt carries; the context a binding prompt tells the session, else null. */
export async function authorityContext(p) {
  const prompt = String(p.prompt || p.user_prompt || '');
  const cwd = typeof p.cwd === 'string' ? p.cwd : process.cwd();
  const probing = process.env.REM_AUTHORITY_PROBE === '1';
  if (!probing && !/task|approve|\u6279\u51c6|\u540c\u610f/i.test(prompt)) return null;
  try {
    const { recordUserCommand, probe } = await import('../scripts/authority.mjs');
    if (probing) probe(prompt);
    recordUserCommand(cwd, prompt, p.session_id || '');
  } catch { /* a hook never breaks the session */ }
  // Only a prompt that starts `task:` loads the task library; parseBindPrompt is the definition.
  if (!/^[ \t]*task:/.test(prompt)) return null;
  try {
    const { parseBindPrompt } = await import('../scripts/tasks.mjs');
    const slug = parseBindPrompt(prompt);
    return slug ? await bind(cwd, p, slug) : null;
  } catch { return null; /* a hook never breaks the session */ }
}
