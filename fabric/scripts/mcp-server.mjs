#!/usr/bin/env node
// fabric MCP server — the "MCP" half of the dual-form fabric (the other half is
// the importable shared/ library). Hand-rolled JSON-RPC over stdio, matching takeover's
// dependency-free style (line + framed transport).
//
// Tools:
//   - list_providers : dump the provider registry (claude/codex/deepseek/…)
//   - resolve_model  : map a Claude model id → a provider's real upstream id
//   - run_task       : dispatch a one-shot headless child and return its output — the
//                      stateless orchestration primitive (spawn N concurrently for fan-out).
//                      claude/deepseek run via `claude -p` (optionally behind the observe
//                      proxy); provider="codex" runs via the codex app-server (native).
//   - spawn_session / session_send / session_close / list_sessions : PERSISTENT multi-turn
//                      sessions. The "handle-holding daemon" is this very server — an MCP
//                      stdio process is long-lived, so it holds live session handles in an
//                      in-process registry (shared/session.mjs) across discrete tool calls.
//                      Context is retained across turns; codex + claude + API alike.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { listModels, loadProviderConfig, resolveModelFromId } from '../shared/providers.mjs';
import { spawnChild } from '../shared/spawn-child.mjs';
import { summarizeFile } from '../shared/observe-reader.mjs';
import { runCodexTask } from '../shared/codex/task.mjs';
import { createSession, sendToSession, closeSession, listSessions } from '../shared/session.mjs';

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
    description: 'Dispatch a one-shot headless child model session and return its output. Anthropic-compatible providers (claude/deepseek) run via `claude -p`; provider="codex" runs via the codex app-server. Set observe:true (non-codex) to route through the observe proxy and capture API traffic to http.jsonl. Spawn several concurrently for fan-out.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider key, e.g. "deepseek", "claude", "codex".' },
        prompt: { type: 'string', description: 'The task prompt.' },
        model: { type: 'string', description: 'Claude model id (proxy remaps it per provider). Optional.' },
        observe: { type: 'boolean', description: 'Route through the observe proxy + capture jsonl (non-codex). Default false.' },
        passthroughAuth: { type: 'boolean', description: 'observe only: proxy forwards the child\'s own Authorization header instead of injecting a static key. Needed for OAuth providers (claude); defaults on for native claude.' },
        write: { type: 'boolean', description: 'codex only: enable tools so the child can act (run git, edit files). Default false (read-only).' },
        cwd: { type: 'string', description: 'Working dir for the child. codex runs its task here (e.g. the git repo). Defaults to the server cwd.' },
        runDir: { type: 'string', description: 'Isolated dir for config + capture (non-codex). Defaults to a temp dir.' },
        timeoutMs: { type: 'number', description: 'Non-codex only: kill the child after this many ms. Defaults to spawnChild\'s 120000.' },
      },
      required: ['provider', 'prompt'],
    },
  },
  {
    name: 'spawn_session',
    description: 'Open a PERSISTENT multi-turn child session and return its id. Unlike run_task (one-shot, stateless), the session stays alive across calls and retains context between turns. Drive it with session_send, then session_close when done. codex uses a native app-server thread; claude/API providers use a long-lived stream-json child.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider key: "codex", "claude", "deepseek", …' },
        model: { type: 'string', description: 'Model id. Optional — uses provider default.' },
        write: { type: 'boolean', description: 'codex only: enable tools so the session can act (git, edit files). Default false (read-only).' },
        cwd: { type: 'string', description: 'Working dir for the session. Defaults to the server cwd.' },
        observe: { type: 'boolean', description: 'Non-codex: route through the observe proxy + capture jsonl. Default false.' },
      },
      required: ['provider'],
    },
  },
  {
    name: 'session_send',
    description: 'Send one turn to a persistent session (from spawn_session) and return its reply. Context from earlier turns is retained. Turns are serialized per session — await each before the next.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id returned by spawn_session.' },
        prompt: { type: 'string', description: 'The turn text to send.' },
      },
      required: ['id', 'prompt'],
    },
  },
  {
    name: 'session_close',
    description: 'Close a persistent session and free its child process. Always close sessions you spawn.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Session id returned by spawn_session.' } },
      required: ['id'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List the currently open persistent sessions held by this server (id, provider, turn count).',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function handleToolCall(name, args = {}, deps = {}) {
  const _spawnChild = deps.spawnChild || spawnChild;
  const _runCodexTask = deps.runCodexTask || runCodexTask;
  const _createSession = deps.createSession || createSession;
  const _sendToSession = deps.sendToSession || sendToSession;
  const _closeSession = deps.closeSession || closeSession;
  const _listSessions = deps.listSessions || listSessions;
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
      // codex is native (its own app-server, not Anthropic HTTP) — it can't ride the
      // claude/spawnChild path. Route it to the codex adapter. `write` enables tools so
      // the child can actually act (run git, edit files); default read-only.
      if (args.provider === 'codex') {
        const res = await _runCodexTask(args.prompt, undefined, args.model, !!args.write, args.cwd || process.cwd());
        return textResult(res.content?.[0]?.text || '(no output)');
      }
      const runDir = args.runDir || join(tmpdir(), `fabric-task-${Date.now()}`);
      const res = await _spawnChild({
        provider: args.provider, prompt: args.prompt, model: args.model,
        observe: !!args.observe, passthroughAuth: args.passthroughAuth, runDir,
        cwd: args.cwd, timeoutMs: args.timeoutMs,
      });
      const parts = [res.stdout?.trim() || '(no output)'];
      if (res.jsonlPath) parts.push('', `--- observe capture: ${res.jsonlPath} ---`, JSON.stringify(summarizeFile(res.jsonlPath)));
      if (res.code !== 0) parts.push('', `(exit code ${res.code})`, res.stderr?.trim() || '');
      return textResult(parts.join('\n'));
    }
    case 'spawn_session': {
      if (!args.provider) throw new Error('spawn_session: provider is required');
      const desc = await _createSession({
        provider: args.provider, model: args.model, write: !!args.write,
        cwd: args.cwd || process.cwd(), observe: !!args.observe,
      });
      return textResult(JSON.stringify(desc));
    }
    case 'session_send': {
      if (!args.id || !args.prompt) throw new Error('session_send: id and prompt are required');
      const res = await _sendToSession(args.id, args.prompt);
      return textResult(res.text || '(no output)');
    }
    case 'session_close': {
      if (!args.id) throw new Error('session_close: id is required');
      return textResult(JSON.stringify(await _closeSession(args.id)));
    }
    case 'list_sessions':
      return textResult(JSON.stringify(_listSessions()));
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
