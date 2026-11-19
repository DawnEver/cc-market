import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHookFacts, isCodexHost, hookSessionKey, isAgyHost, normalizeHookInput, isFirstInvocation, hookOutput } from '../hook-facts.mjs';

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
  assert.equal(isCodexHost({ CLAUDE_PLUGIN_ROOT: '/x/.claude-seat/plugins/rem', CODEX_THREAD_ID: 'outer' }), false);
  assert.equal(isCodexHost({ CLAUDE_PLUGIN_ROOT: '/tmp/.claude/custom-codex/plugins/cache/rem', CODEX_HOME: '/tmp/.claude/custom-codex' }), true);
  assert.equal(isCodexHost({ CLAUDE_PLUGIN_ROOT: '/tmp/.claude/plugins/cache/rem', CODEX_HOME: '/tmp/.claude/custom-codex' }), false);
  assert.equal(isCodexHost({ CLAUDE_PLUGIN_ROOT: 'C:\\CUSTOM\\.claude\\codex-home\\plugins\\cache\\rem', CODEX_HOME: 'c:\\custom\\.claude\\codex-home' }), true);
  assert.equal(isCodexHost({ CLAUDE_PLUGIN_ROOT: '/tmp/claude-custom/plugins/cache/rem', CLAUDE_CONFIG_DIR: '/tmp/claude-custom', CODEX_HOME: '/tmp/codex' }), false);
  assert.equal(isCodexHost({ CLAUDE_PLUGIN_ROOT: '/tmp/claude-custom/plugins/codex/plugins/cache/rem', CLAUDE_CONFIG_DIR: '/tmp/claude-custom', CODEX_HOME: '/tmp/claude-custom/plugins/codex' }), true);
  assert.equal(isCodexHost({ CLAUDE_PLUGIN_ROOT: '/tmp/codex/plugins/claude/plugins/cache/rem', CLAUDE_CONFIG_DIR: '/tmp/codex/plugins/claude', CODEX_HOME: '/tmp/codex' }), false);
  assert.equal(isCodexHost({ CODEX_THREAD_ID: 'thread' }), true);
});

test('hook session keys distinguish execution threads from Codex root lineage', () => {
  const env = { CODEX_THREAD_ID: 'stale-thread', CODEX_SESSION_ID: 'root' };
  assert.equal(hookSessionKey({ session_id: 'root', thread_id: 'child' }, env), 'child');
  assert.equal(hookSessionKey({ session_id: 'root', agent_id: 'agent' }, env), 'agent');
  const uuid = '12345678-1234-1234-1234-123456789abc';
  assert.equal(hookSessionKey({ session_id: 'root', transcript_path: `/tmp/rollout-date-${uuid}.jsonl` }, env), uuid);
  assert.equal(hookSessionKey({ session_id: 'root', transcript_path: '/tmp/rollout-not-an-id.jsonl' }, env), 'stale-thread');
  assert.equal(hookSessionKey({ session_id: 'root' }, { CODEX_HOME: '/tmp/codex' }, []), null);
  assert.equal(hookSessionKey({ session_id: 'root' }, { CODEX_SESSION_ID: 'root' }, []), null);
  assert.equal(hookSessionKey({ session_id: 'root' }, { HARNESS_AGENT: 'codex' }, []), null);
  assert.equal(hookSessionKey({ session_id: 'claude' }, { ...env, CLAUDE_PLUGIN_ROOT: '/tmp/.claude/plugins/rem' }, []), 'claude');
});

test('agy: host detection, <USER_REQUEST> stripping, ANTIGRAVITY_CONVERSATION_ID and session key', () => {
  const raw = {
    conversationId: 'c1',
    hookEventName: 'PreToolUse',
    workspacePaths: ['/w'],
    transcriptPath: '/t.jsonl',
    lastUserInput: '<USER_REQUEST>\ntask: feature-x\ndo it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfoo\n</ADDITIONAL_METADATA>',
    toolCall: { name: 'run_command', args: { CommandLine: 'node task.js open x' } },
  };
  assert.equal(isAgyHost(raw, {}, []), true);
  assert.equal(isAgyHost({ session_id: 's' }, {}, ['node', 'x.js', '--host', 'agy']), true);
  assert.equal(isAgyHost({}, { ANTIGRAVITY_CONVERSATION_ID: 'conv-env' }, []), true);
  assert.equal(isAgyHost({}, { ANTIGRAVITY_AGENT: '1' }, []), true);
  assert.equal(isAgyHost({}, { ANTIGRAVITY_AGENT: '1', CLAUDE_PLUGIN_ROOT: '/tmp/.claude/plugins/rem' }, []), false);
  assert.equal(isAgyHost({}, { ANTIGRAVITY_CONVERSATION_ID: 'conv-env', CODEX_HOME: '/tmp/codex' }, []), false);
  assert.equal(isAgyHost({ session_id: 's' }, {}, []), false);
  const n = normalizeHookInput(raw, {}, []);
  assert.equal(n.tool_name, 'Bash');
  assert.equal(n.tool_input.command, 'node task.js open x');
  assert.equal(n.cwd, '/w');
  assert.equal(n.transcript_path, '/t.jsonl');
  assert.equal(n.prompt, 'task: feature-x\ndo it');
  assert.equal(normalizeHookInput({ hookEventName: 'PreInvocation', lastUserInput: '  plain prompt  ' }, {}, []).prompt, 'plain prompt');
  assert.equal(hookSessionKey(raw, { CODEX_HOME: '/c' }, []), 'c1');
  assert.equal(hookSessionKey({}, { ANTIGRAVITY_CONVERSATION_ID: 'conv-env' }, []), 'conv-env');
  assert.equal(normalizeHookInput({}, { ANTIGRAVITY_CONVERSATION_ID: 'conv-env' }, []).session_id, 'conv-env');
  assert.equal(normalizeHookInput({ toolCall: { name: 'write_to_file', args: { TargetFile: '/a' } } }, {}, []).tool_input.file_path, '/a');
  assert.equal(normalizeHookInput({ toolCall: { name: 'write_file', args: { Path: '/b' } } }, {}, []).tool_input.file_path, '/b');
  assert.equal(isFirstInvocation({}), true);
  assert.equal(isFirstInvocation({ invocationNum: 2 }), false);
});

test('agy: transcript steps normalize to the same facts', () => {
  const f = normalizeHookFacts([
    { type: 'USER_INPUT', content: 'go' },
    { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { Path: '"/w/a.js"' } }] },
    { type: 'PLANNER_RESPONSE', content: 'Which option?' },
  ]);
  assert.equal(f.hasEdits, true);
  assert.deepEqual(f.readPaths, ['/w/a.js']);
  assert.equal(f.waitingForInput, true);
});

test('hookOutput shapes per host', () => {
  assert.deepEqual(JSON.parse(hookOutput({ host: 'agy', kind: 'deny', reason: 'r' }).stdout), { decision: 'deny', reason: 'r' });
  assert.deepEqual(JSON.parse(hookOutput({ host: 'agy', event: 'PreToolUse', kind: 'none' }).stdout), { decision: 'ask' });
  assert.equal(hookOutput({ host: 'agy', event: 'Stop', kind: 'none' }).stdout, '{}');
  assert.deepEqual(hookOutput({ host: 'agy', kind: 'block', reason: 'r' }), { stdout: '{"decision":"continue","reason":"r"}', stderr: '', code: 0 });
  assert.equal(hookOutput({ host: 'agy', kind: 'block', reason: 'r', input: { continuationActive: true } }).stdout, '{}');
  assert.deepEqual(JSON.parse(hookOutput({ host: 'agy', kind: 'context', reason: 'm' }).stdout), { injectSteps: [{ systemMessage: { systemMessage: 'm' } }] });
  assert.deepEqual(hookOutput({ host: 'claude', kind: 'block', reason: 'r' }), { stdout: '', stderr: 'r', code: 2 });
  assert.equal(JSON.parse(hookOutput({ host: 'claude', event: 'PreToolUse', kind: 'deny', reason: 'r' }).stdout).hookSpecificOutput.permissionDecision, 'deny');
});
