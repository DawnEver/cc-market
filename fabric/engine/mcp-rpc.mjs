// engine/mcp-rpc.mjs — hand-rolled JSON-RPC 2.0 stdio transport for MCP servers.
// Dependency-free; supports both newline-delimited JSON (Claude Code default) and
// Content-Length framed messages (needed for Codex MCP startup). A server supplies its
// `serverInfo`, `tools` registry, and `handleToolCall`; this owns encode / parse / dispatch
// / the read loop. Extracted so every cc-market MCP server shares one transport.

export const LINE = "line";
export const FRAMED = "framed";

export function encodeRpcMessage(rpc, transport = LINE) {
  const json = JSON.stringify(rpc);
  if (transport === FRAMED) {
    return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  }
  return `${json}\n`;
}

function isFramedTransport(buffer) {
  const prefix = buffer.subarray(0, Math.min(buffer.length, "Content-Length:".length)).toString("ascii").toLowerCase();
  return "content-length:".startsWith(prefix) || prefix.startsWith("content-length:");
}

function headerEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1) return lf === -1 ? null : { index: lf, bytes: 2 };
  if (lf === -1) return { index: crlf, bytes: 4 };
  return crlf < lf ? { index: crlf, bytes: 4 } : { index: lf, bytes: 2 };
}

// Bounded-concurrency gate. acquire() resolves immediately while a slot is free,
// otherwise queues FIFO; release() hands the freed slot to the next waiter. Used
// so the read loop can dispatch many tool calls in flight (fan-out) without
// spawning an unbounded number of provider children at once.
function createLimiter(max) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      if (active < max) { active++; return Promise.resolve(); }
      return new Promise((resolve) => queue.push(resolve));
    },
    release() {
      active--;
      if (queue.length && active < max) { active++; queue.shift()(); }
    },
  };
}

// A non-positive/non-finite cap would deadlock (acquire never increments active,
// so the read loop stalls on the first request) or go unbounded (Infinity).
// Clamp to a positive integer. (SR-048)
function sanitizeConcurrency(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

const DEFAULT_MAX_CONCURRENCY = sanitizeConcurrency(process.env.FABRIC_MCP_MAX_CONCURRENCY, 8);

/**
 * Build a stdio JSON-RPC server bound to one tool registry.
 * @param {object} o  serverInfo:{name,version}, tools:[], handleToolCall(name,args), label, out,
 *                    maxConcurrency (default 8, or $FABRIC_MCP_MAX_CONCURRENCY)
 * @returns {{ send, handleRpcRequest, main }}
 */
export function createStdioServer({ serverInfo, tools, handleToolCall, label = "mcp", out = process.stdout, maxConcurrency = DEFAULT_MAX_CONCURRENCY }) {
  const limit = sanitizeConcurrency(maxConcurrency, DEFAULT_MAX_CONCURRENCY);
  // Each RPC message is encoded to a SINGLE string and emitted with ONE out.write.
  // Node serializes whole write() calls, so concurrent handlers cannot interleave
  // bytes — provided this one-message-per-write invariant holds (no streamed/partial
  // responses). Keep it that way if you add notification forwarding. (SR-043/054)
  const send = (rpc, transport = LINE) => out.write(encodeRpcMessage(rpc, transport));

  function parseJsonPayload(payload, preview) {
    try {
      return JSON.parse(payload);
    } catch {
      process.stderr.write(`${label}: bad JSON: ${preview.slice(0, 200)}\n`);
      return null;
    }
  }

  async function handleRpcRequest(req, transport = LINE) {
    const { id, method, params = {} } = req;
    try {
      switch (method) {
        case "initialize":
          return send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo } }, transport);
        case "ping":
          return send({ jsonrpc: "2.0", id, result: {} }, transport);
        case "notifications/initialized":
          return;
        case "tools/list":
          return send({ jsonrpc: "2.0", id, result: { tools } }, transport);
        case "tools/call":
          return send({ jsonrpc: "2.0", id, result: await handleToolCall(params.name, params.arguments || {}) }, transport);
        default:
          return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }, transport);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes("not found") ? -32602 : -32000;
      send({ jsonrpc: "2.0", id, error: { code, message } }, transport);
    }
  }

  async function main(input = process.stdin) {
    const limiter = createLimiter(limit);
    const inflight = new Set();

    // Dispatch a request WITHOUT blocking the read loop on its completion — the
    // whole point of the fan-out fix. handleRpcRequest owns its own reply (by
    // JSON-RPC id) and error handling, so responses may return out of order.
    // acquire() applies backpressure: the loop pauses (intentionally) only when
    // `limit` calls are already in flight, capping concurrent provider children.
    // The inner catch swallows ANY escape (e.g. a throwing out.write in the error
    // path, or limiter.release throwing) so a single bad call can neither crash
    // the process with an unhandled rejection nor tear down the drain. (SR-050/056)
    const dispatch = async (req, transport) => {
      await limiter.acquire();
      const p = (async () => {
        try { await handleRpcRequest(req, transport); }
        catch { /* handled inside handleRpcRequest; swallow anything that escapes */ }
        finally { limiter.release(); }
      })();
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    };

    let buffer = Buffer.alloc(0);
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (buffer.length > 0) {
        if (buffer[0] === 0x0a || buffer[0] === 0x0d) { buffer = buffer.subarray(1); continue; }
        if (isFramedTransport(buffer)) {
          const end = headerEnd(buffer);
          if (!end) break;
          const header = buffer.subarray(0, end.index).toString("ascii");
          const match = /^Content-Length:\s*(\d+)$/im.exec(header);
          if (!match) { process.stderr.write(`${label}: bad MCP header: ${header.slice(0, 200)}\n`); buffer = buffer.subarray(end.index + end.bytes); continue; }
          const bodyStart = end.index + end.bytes;
          const bodyEnd = bodyStart + Number(match[1]);
          if (buffer.length < bodyEnd) break;
          const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
          buffer = buffer.subarray(bodyEnd);
          const req = parseJsonPayload(body, body);
          if (req) await dispatch(req, FRAMED);
          continue;
        }
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
        buffer = buffer.subarray(lineEnd + 1);
        if (!line) continue;
        const req = parseJsonPayload(line, line);
        if (req) await dispatch(req, LINE);
      }
    }
    const trailing = buffer.toString("utf8").trim();
    if (trailing && !isFramedTransport(buffer)) {
      const req = parseJsonPayload(trailing, trailing);
      if (req) await dispatch(req, LINE);
    }
    // Drain: don't resolve until every dispatched handler has replied.
    await Promise.all(inflight);
  }

  return { send, handleRpcRequest, main };
}
