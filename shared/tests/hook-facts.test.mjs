import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHookFacts, isCodexHost } from '../hook-facts.mjs';

test('Claude and current Codex edits and last assistant text normalize to the same facts', () => {
  const claude = [{ message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: '/work/file.js' } },
    { type: 'text', text: 'Which option?' },
  ] } }];
  const codex = [
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: [] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Which option?' }] } } },
  ];
  for (const rows of [claude, codex]) {
    const f = normalizeHookFacts(rows);
    assert.equal(f.hasEdits, true);
    assert.equal(f.lastAssistantText, 'Which option?');
    assert.equal(f.waitingForInput, true);
  }
});

test('native hook fields override transcript text and raw shell reads are not guessed', () => {
  const f = normalizeHookFacts([
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat secret.md"}' } },
    { message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/work/.claude/memory/2026/10/23/a.md' } }] } },
  ], { last_assistant_message: 'Finished.' });
  assert.equal(f.lastAssistantText, 'Finished.');
  assert.equal(f.waitingForInput, false);
  assert.deepEqual(f.readPaths, ['/work/.claude/memory/2026/10/23/a.md']);
});

test('host detection prefers the plugin host over inherited outer-host env', () => {
  assert.equal(isCodexHost({ CLAUDE_PLUGIN_ROOT: '/x/.claude/plugins/rem', CODEX_HOME: '/x' }), false);
  assert.equal(isCodexHost({ CODEX_THREAD_ID: 'thread' }), true);
});
