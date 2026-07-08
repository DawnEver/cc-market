// Tests for the fabric MCP server — tool registry + dispatch. run_task uses an injected
// fake spawnChild so no `claude`/network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, handleToolCall } from '../scripts/mcp-server.mjs';

const text = (r) => r.content[0].text;

test('TOOLS registers the expected tool names', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['list_providers', 'resolve_model', 'run_task']);
});

test('unknown tool throws', async () => {
  await assert.rejects(handleToolCall('nope', {}), /Tool not found/);
});

test('run_task requires provider + prompt', async () => {
  await assert.rejects(handleToolCall('run_task', { provider: 'deepseek' }), /required/);
});

test('run_task dispatches to spawnChild and returns its output', async () => {
  let seen = null;
  const fakeSpawnChild = async (opts) => { seen = opts; return { code: 0, stdout: 'hello from child', stderr: '', jsonlPath: null }; };
  const res = await handleToolCall('run_task', { provider: 'deepseek', prompt: 'do it', model: 'claude-haiku-4-5' }, { spawnChild: fakeSpawnChild });
  assert.equal(seen.provider, 'deepseek');
  assert.equal(seen.prompt, 'do it');
  assert.equal(seen.observe, false);
  assert.match(text(res), /hello from child/);
});

test('run_task surfaces a non-zero exit code + stderr', async () => {
  const fakeSpawnChild = async () => ({ code: 2, stdout: '', stderr: 'boom', jsonlPath: null });
  const res = await handleToolCall('run_task', { provider: 'deepseek', prompt: 'x' }, { spawnChild: fakeSpawnChild });
  assert.match(text(res), /exit code 2/);
  assert.match(text(res), /boom/);
});

test('run_task routes provider=codex to the codex app-server, not spawnChild', async () => {
  let codexArgs = null;
  let spawnCalled = false;
  const fakeRunCodexTask = async (prompt, systemPrompt, model, write, cwd) => {
    codexArgs = { prompt, model, write, cwd };
    return { content: [{ type: 'text', text: 'tidied by codex' }] };
  };
  const fakeSpawnChild = async () => { spawnCalled = true; return { code: 0, stdout: '', stderr: '', jsonlPath: null }; };
  const res = await handleToolCall(
    'run_task',
    { provider: 'codex', prompt: 'run git-tidy', write: true, cwd: '/repo' },
    { runCodexTask: fakeRunCodexTask, spawnChild: fakeSpawnChild },
  );
  assert.equal(spawnCalled, false, 'codex must not go through the claude spawnChild path');
  assert.equal(codexArgs.prompt, 'run git-tidy');
  assert.equal(codexArgs.write, true);
  assert.equal(codexArgs.cwd, '/repo');
  assert.match(text(res), /tidied by codex/);
});

test('run_task codex path defaults write=false and cwd=process.cwd()', async () => {
  let codexArgs = null;
  const fakeRunCodexTask = async (prompt, systemPrompt, model, write, cwd) => {
    codexArgs = { write, cwd };
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  await handleToolCall('run_task', { provider: 'codex', prompt: 'x' }, { runCodexTask: fakeRunCodexTask });
  assert.equal(codexArgs.write, false);
  assert.equal(codexArgs.cwd, process.cwd());
});
