// engine/observe-proxy.mjs — minimal Anthropic-compatible reverse proxy for the
// fabric observe/debug layer. Deliberately NOT a full trace platform (no sqlite,
// live view, blob offload). Its whole job:
//
//   child (any provider) --ANTHROPIC_BASE_URL=http://127.0.0.1:PORT--> proxy --> real upstream
//
// so the child always speaks vanilla Anthropic HTTP and the proxy alone owns the
// provider's endpoint + auth + model alias. This dissolves the Foundry-vs-tap conflict:
// observe mode = vanilla+proxy (no Foundry env); normal mode = Foundry direct-connect.
//
// Core structural asymmetry:
//   REQUEST  — buffered, parsed, model-remapped in-body (small, non-stream).
//   RESPONSE — SSE streamed back UNBUFFERED, teed to jsonl (the one real risk; validated).
//
// Provider routing (upstream/auth/model) comes from engine/providers.mjs — the single
// source of truth. Auth forks by provider: static-key providers get x-api-key injected;
// pass passthroughAuth:true for OAuth providers (claude) to forward the child's own header.

import http from 'node:http';
import https from 'node:https';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { resolveUpstream } from './providers.mjs';

/**
 * @param {object} opts
 * @param {string}  opts.provider          registry key ('deepseek', ...)
 * @param {string}  opts.runDir            dir to append http.jsonl into
 * @param {boolean} [opts.passthroughAuth] forward child's Authorization instead of injecting a key
 * @param {string}  [opts.configPath]      override registry path (tests)
 * @returns {Promise<{url, port, jsonlPath, close}>}
 */
export async function startObserveProxy({ provider, runDir, passthroughAuth = false, configPath }) {
  const { baseUrl, token, resolveModel } = resolveUpstream(provider, configPath);
  const upstream = new URL(baseUrl);
  const isHttps = upstream.protocol === 'https:';
  const agent = isHttps ? https : http;

  mkdirSync(runDir, { recursive: true });
  const jsonlPath = join(runDir, 'http.jsonl');
  const log = createWriteStream(jsonlPath, { flags: 'a' });
  const append = (obj) => { if (!log.writableEnded) log.write(JSON.stringify(obj) + '\n'); };

  let seq = 0;

  const server = http.createServer((cReq, cRes) => {
    const id = ++seq;
    const started = Date.now();
    const inChunks = [];
    cReq.on('data', (d) => inChunks.push(d));
    cReq.on('end', () => {
      let body = Buffer.concat(inChunks);
      let parsed = null, modelBefore = null, modelAfter = null;
      // REQUEST rewrite — the only body mutation: remap the model id in-place.
      try {
        parsed = JSON.parse(body.toString('utf8'));
        if (parsed && typeof parsed === 'object' && 'model' in parsed) {
          modelBefore = parsed.model;
          modelAfter = resolveModel(parsed.model);
          if (modelAfter !== modelBefore) {
            parsed.model = modelAfter;
            body = Buffer.from(JSON.stringify(parsed), 'utf8');
          }
        }
      } catch { /* non-JSON/empty body — forward verbatim */ }

      const inUrl = new URL(cReq.url, 'http://x');
      const path = upstream.pathname.replace(/\/$/, '') + inUrl.pathname + inUrl.search;

      const headers = { ...cReq.headers };
      delete headers['content-length'];
      delete headers['host'];
      delete headers['accept-encoding']; // no gzip → SSE + jsonl stay readable
      headers['host'] = upstream.host;
      headers['content-length'] = Buffer.byteLength(body);
      if (!passthroughAuth && token) {
        headers['x-api-key'] = token; // Anthropic-compatible gateways (incl. DeepSeek)
        delete headers['authorization'];
      }

      append({ t: 'request', id, ts: started, provider, method: cReq.method, path, modelBefore, modelAfter, body: parsed ?? body.toString('utf8') });

      const uReq = agent.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (isHttps ? 443 : 80),
          method: cReq.method, path, headers,
        },
        (uRes) => {
          // Flush status+headers immediately; stream body through untouched (SSE-safe).
          cRes.writeHead(uRes.statusCode, uRes.headers);
          const outChunks = [];
          uRes.on('data', (d) => { outChunks.push(d); cRes.write(d); });
          uRes.on('end', () => {
            cRes.end();
            append({ t: 'response', id, ts: Date.now(), duration_ms: Date.now() - started, status: uRes.statusCode, headers: uRes.headers, body: Buffer.concat(outChunks).toString('utf8') });
          });
        },
      );
      uReq.on('error', (err) => {
        append({ t: 'error', id, ts: Date.now(), message: err.message });
        if (!cRes.headersSent) cRes.writeHead(502);
        cRes.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
      });
      uReq.end(body);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    jsonlPath,
    async close() {
      await new Promise((r) => server.close(r));
      await new Promise((r) => { log.end(r); });
    },
  };
}
