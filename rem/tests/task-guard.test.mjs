// task-guard.test.mjs — the PreToolUse guard judges what a command DOES, not what it mentions:
// the task.js VERB in argv position, and the TARGET path of known writers. Message and body
// arguments and read-only commands never match. (Detection in scope-validate is the backstop.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideTaskGuard } from '../hooks/task-guard.js';

const shell = (command, tool = 'Bash') => decideTaskGuard({ tool_name: tool, tool_input: { command } }).deny;

describe('allowed: the false positives seen live', () => {
  for (const cmd of [
    'node task.js open-item "port the helper" --task integrator',
    'node "C:/p/rem/scripts/task.js" close-item O3 "ported" --task integrator',
    'node task.js log "closed the open question" --task x',
    'git commit -m "docs: .claude/tasks/integrator/TASK.md records the goal"',
    'forge pr create --title t --body "moves .claude/tasks to memory; TASK.md and JOURNAL.md kept"',
    'git status --short -- .claude/tasks && cat .claude/tasks/integrator/TASK.md',
    "sed -i 's#^.claude/tasks/$#!.claude/tasks/#' .gitignore",
    'grep -n opened .claude/tasks/x/JOURNAL.md > /tmp/out.txt',
    'git log --oneline -- .claude/tasks/x/TASK.md',
    'node "C:/Users/u/.claude/plugins/cache/cc-market/rem/2.3.0/scripts/task.js" open-item "re-run the open gate; node tests -> green" --task integrator 2>&1',
    'git commit -m "feat(rem): node task.js open moves .claude/tasks/x -> memory; TASK.md stays (mv, not rm)" 2>&1 | tail -1',
    'forge pr create --body "python and node scripts open .claude/tasks/x/TASK.md > nothing; cp of JOURNAL.md" 2>&1',
    'git status --short -- .claude/tasks 2>&1; cat .claude/tasks/integrator/TASK.md 2>/dev/null',
    "sed -i -e 's#^.claude/tasks/x/TASK.md$##' .gitignore 2>&1",
  ]) it(cmd, () => assert.equal(shell(cmd), false));
});

describe('refused: every bypass from the reviews', () => {
  for (const [cmd, tool] of [
    [`node -e "import('./rem/scripts/tasks.mjs').then(m=>m.openTask('.','x','g'))"`],
    [`node -e "require('./tasks.mjs').closeTask(1)"`],
    ['node task.js --task y close'],
    ['node rem/scripts/task.js --owner me open x goal'],
    ['node "/p/rem/scripts/task.js" open x "goal"'],
    ['node task.js close x'],
    ['cd .claude/tasks/x && echo > TASK.md'],
    [`python -c "open('.claude/tasks/x/TASK.md','w')"`],
    [`python3 -c "import os; os.makedirs('.claude/tasks/x')"`],
    ['echo {} >> ~/.claude/rem/authority/abc.jsonl'],
    ['echo hi > .claude/tasks/x/TASK.md'],
    ['tee -a .claude/tasks/x/JOURNAL.md < notes'],
    ['cp /tmp/forged.md .claude/tasks/x/TASK.md'],
    ["sed -i 's/open/closed/' .claude/tasks/x/TASK.md"],
    ['mkdir -p .claude/tasks/x'],
    ['Set-Content .claude\\tasks\\x\\TASK.md hi', 'PowerShell'],
    ['Set-Content -Path .claude/tasks/x/JOURNAL.md -Value hi', 'PowerShell'],
    // heredoc bodies fed to an interpreter are code, like -e / -c
    ["python - <<EOF\nopen('.claude/tasks/x/TASK.md', 'w').write('x')\nEOF"],
    ["node <<'JS'\nrequire('fs').writeFileSync('.claude/tasks/x/JOURNAL.md', '')\nJS"],
    // a shell's -c / -Command string is a command line, judged recursively
    ['bash -c "echo hi > .claude/tasks/x/TASK.md"'],
    ["sh -c 'node task.js close x'"],
    ['pwsh -c "Set-Content .claude/tasks/x/TASK.md hi"'],
    [`powershell -Command "bash -c 'echo > .claude/tasks/x/TASK.md'"`],
    // consecutive cd's compose into one effective cwd
    ['cd .claude && cd tasks/x && echo > TASK.md'],
    ['cd .claude; cd tasks; cd x; tee JOURNAL.md < notes'],
  ]) it(cmd, () => assert.equal(shell(cmd, tool), true));
});

describe('still allowed after the deeper parse', () => {
  for (const cmd of [
    'bash -c "cat .claude/tasks/x/TASK.md"',
    'cat <<EOF > notes.md\nmentions .claude/tasks/x/TASK.md\nEOF',
    'cd .claude && cd memory && echo > note.md',
  ]) it(JSON.stringify(cmd), () => assert.equal(shell(cmd), false));
});

describe('translate is a task.js verb; every other journal rewrite stays refused', () => {
  it('allows task.js translate (flags before or after the verb)', () => {
    assert.equal(shell('node task.js translate --task x --line 4 "- 2026-11-13 D1: use English"'), false);
    assert.equal(shell('node task.js --line 4 --task x translate "- 2026-11-13 D1: use English"'), false);
  });
  it('planted control: --line before the verb cannot hide open/close', () => {
    assert.equal(shell('node task.js --line 4 close x'), true);
  });
  it('planted control: a direct journal rewrite is still refused', () => {
    assert.equal(shell("sed -i 's/a/b/' .claude/tasks/x/JOURNAL.md"), true);
    const edit = decideTaskGuard({ tool_name: 'Edit', tool_input: { file_path: '/r/.claude/tasks/x/JOURNAL.md' } });
    assert.equal(edit.deny, true);
  });
});
