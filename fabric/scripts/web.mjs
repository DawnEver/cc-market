#!/usr/bin/env node
// scripts/web.mjs — the local fabric management console.
//
//   node scripts/web.mjs [--port N]     (default 7678, binds 127.0.0.1 ONLY)
//
// One page: fleet status (every configured node's capacity facts), sessions this
// console spawned (spawn/chat/ping/close, any provider, any node), and the journal's
// reconcile view. Session-bound like serve and ci_loop — run it in a terminal you keep
// open; closing the terminal stops the console (its remote sessions are then reaped by
// the peers' owner-connection cleanup).

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebApi } from "../engine/web-api.mjs";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : 7678;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`fabric web: invalid --port\n`);
  process.exit(1);
}

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "web-ui.html");
const api = createWebApi();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(htmlPath)); // re-read per request: edit the UI without restarting
    return;
  }
  let body = null;
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
    catch { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad json"}'); return; }
  }
  const out = await api.handle(req.method, url.pathname, body);
  res.writeHead(out.status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(out.body));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fabric console: http://127.0.0.1:${port}  (local only; close this terminal to stop)\n`);
});
process.on("SIGINT", () => { server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
