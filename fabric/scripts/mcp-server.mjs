#!/usr/bin/env node
// fabric MCP server — the "MCP" half of the dual-form fabric (the other half is
// the importable shared/ library). Hand-rolled JSON-RPC over stdio, matching takeover's
// dependency-free style (line + framed transport).
//
// Tools:
//   - list_providers : dump the provider registry (claude/codex/deepseek/…)
//   - resolve_model  : map a Claude model id → a provider's real upstream id
//   - run_task       : dispatch a one-shot headless child (claude -p) for any provider,
//                      optionally behind the observe proxy — the stateless orchestration
//                      primitive (spawn N concurrently for fan-out).
//
// Roadmap (next slice — needs a handle-holding daemon, since MCP calls are discrete but
// child sessions are persistent): spawn_session / session_send / session_close for
// PERSISTENT multi-turn sessions. Not stubbed here — declared so the surface is honest.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { listModels, loadProviderConfig, resolveModelFromId } from '../shared/providers.mjs';
import { spawnChild } from '../shared/spawn-child.mjs';
import { summarizeFile } from '../shared/observe-reader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginJson = JSON.parse(readFileSync(join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
const SERVER_NAME = pluginJson.name;
const SERVER_VERSION = pluginJson.version;

const LINE = 'line', FRAMED = 'framed';
export function encodeRpcMessage(rpc, transport = LINE) {
  const json = JSON.stringify(rpc);
  return transport === FRAMED
    ? `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`
    : `${json}\n`;
}
function send(rpc, transport = LINE) { process.stdout.write(encodeRpcMessage(rpc, transport)); }
const textResult = (s) => ({ content: [{ type: 'text', text: s }] });

export const TOOLS = [
  {
    name: 'list_providers',
    description: 'List configured model providers (claude/codex + any Anthropic-compatible API from claude_env_settings.json) and their model aliases.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve_model',
    description: 'Resolve a full Claude model id (e.g. "claude-haiku-4-5-...") to a provider\'s real upstream model id, using the provider\'s tier aliases.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider key, e.g. "deepseek".' },
        model: { type: 'string', description: 'Full Claude model id to remap.' },
      },
      required: ['provider', 'model'],
    },
  },
  {
    name: 'run_task',
    description: 'Dispatch a one-shot headless child model session (claude -p) for a provider and return its output. Set observe:true to route through the observe proxy and capture the API traffic to http.jsonl. Spawn several concurrently for fan-out.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider key, e.g. "deepseek".' },
        prompt: { type: 'string', description: 'The task prompt.' },
        model: { type: 'string', description: 'Claude model id (proxy remaps it per provider). Optional.' },
        observe: { type: 'boolean', description: 'Route through the observe proxy + capture jsonl. Default false.' },
        runDir: { type: 'string', description: 'Isolated dir for config + capture. Defaults to a temp dir.' },
      },
      required: ['provider', 'prompt'],
    },
  },
];

export async function handleToolCall(name, args = {}, deps = {}) {
  const _spawnChild = deps.spawnChild || spawnChild;
  switch (name) {
    case 'list_providers':
      return textResult(listModels());
    case 'resolve_model': {
      const cfg = loadProviderConfig(args.provider);
      if (cfg.native) return textResult(`${args.provider} is native — no model remapping.`);
      return textResult(resolveModelFromId(cfg, args.model));
    }
    case 'run_task': {
      if (!args.provider || !args.prompt) throw new Error('run_task: provider and prompt are required');
      const runDir = args.runDir || join(tmpdir(), `fabric-task-${Date.now()}`);
      const res = await _spawnChild({
        provider: args.provider, prompt: args.prompt, model: args.model,
        observe: !!args.observe, runDir,
      });
      const parts = [res.stdout?.trim() || '(no output)'];
      if (res.jsonlPath) parts.push('', `--- observe capture: ${res.jsonlPath} ---`, JSON.stringify(summarizeFile(res.jsonlPath)));
      if (res.code !== 0) parts.push('', `(exit code ${res.code})`, res.stderr?.trim() || '');
      return textResult(parts.join('\n'));
    }
    default:
      throw new Error(`Tool not found: ${name}`);
  }
}

export async function handleRpcRequest(req, transport = LINE) {
  const { id, method, params = {} } = req;
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } } }, transport);
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} }, transport);
      case 'notifications/initialized':
        return;
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }, transport);
      case 'tools/call':
        return send({ jsonrpc: '2.0', id, result: await handleToolCall(params.name, params.arguments || {}) }, transport);
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }, transport);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ jsonrpc: '2.0', id, error: { code: -32000, message } }, transport);
  }
}

async function main(input = process.stdin) {
  let buffer = '';
  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffer += chunk;
    // Line transport only (Claude Code's default); framed encoding still supported on send.
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { await handleRpcRequest(JSON.parse(line)); }
      catch (e) { process.stderr.write(`fabric-mcp: bad message: ${e.message}\n`); }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
