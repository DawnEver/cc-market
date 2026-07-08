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
