// Hermetic tests for the observe proxy — no network, no API key. A fake local upstream
// stands in for DeepSeek: it echoes the received model (proving in-body rewrite) and
// emits a chunked SSE stream with a delay between chunks (proving non-buffered passthrough).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startObserveProxy } from '../shared/observe-proxy.mjs';
import { clearConfigCache } from '../shared/providers.mjs';

// A fake Anthropic-compatible upstream: captures the request, streams SSE back slowly.
function startFakeUpstream() {
  let seenModel = null, seenApiKey = null, seenPath = null;
  const server = http.createServer((req, res) => {
    seenPath = req.url;
    seenApiKey = req.headers['x-api-key'];
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      try { seenModel = JSON.parse(Buffer.concat(chunks).toString()).model; } catch { /* */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      // Second chunk after a delay — if the proxy buffers, both arrive together.
      setTimeout(() => {
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
        res.end();
      }, 120);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, get seenModel() { return seenModel; }, get seenApiKey() { return seenApiKey; }, get seenPath() { return seenPath; }, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function fixtureFor(port) {
  const dir = mkdtempSync(join(tmpdir(), 'obsproxy-'));
  const cfgPath = join(dir, 'reg.json');
  writeFileSync(cfgPath, JSON.stringify({
    'env:fake': {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: 'sk-fake-key',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fake-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'fake-pro',
    },
  }));
  clearConfigCache();
  return { dir, cfgPath };
}

test('proxy rewrites model, injects key, streams SSE unbuffered, captures jsonl', async () => {
  const up = await startFakeUpstream();
  const { dir, cfgPath } = fixtureFor(up.port);
  const proxy = await startObserveProxy({ provider: 'fake', runDir: dir, configPath: cfgPath });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);

    const reader = res.body.getReader();
    const flushes = [];
    let full = '';
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flushes.push(Date.now());
      full += dec.decode(value, { stream: true });
    }

    // Transport correctness
    assert.ok(full.includes('message_start') && full.includes('content_block_delta'), 'both SSE events arrived');
    assert.ok(flushes.length > 1, 'arrived in >1 flush (non-buffered)');
    assert.ok(flushes[flushes.length - 1] - flushes[0] >= 80, 'flushes were spread in time, not batched');

    // Routing correctness (observed at the fake upstream)
    assert.equal(up.seenModel, 'fake-flash', 'model rewritten in-body before upstream');
    assert.equal(up.seenApiKey, 'sk-fake-key', 'provider key injected, placeholder replaced');
    assert.equal(up.seenPath, '/v1/messages', 'path forwarded');
  } finally {
    await proxy.close();
    await up.close();
  }

  // Capture correctness
  const lines = readFileSync(proxy.jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const req = lines.find((r) => r.t === 'request');
  const resp = lines.find((r) => r.t === 'response');
  assert.equal(req.modelBefore, 'claude-haiku-4-5-20251001');
  assert.equal(req.modelAfter, 'fake-flash');
  assert.equal(resp.status, 200);
  assert.ok(resp.body.includes('message_start'));
});
