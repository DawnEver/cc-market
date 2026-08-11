// web/server.mjs — HTTP shell of the fabric management console.
//
// The console is a proper little web project:
//   web/api.mjs      pure JSON API handler (tested in tests/web-api.test.mjs)
//   web/public/      index.html + ES modules (state.js, render.js, main.js) + style.css
//                    served statically (re-read per request so the UI is editable
//                    without a restart); the display formatters come straight from
//                    scripts/lib/format.mjs via the /lib/ static mapping (one source)
//   web/server.mjs   this file: static + API wiring, exported as startConsole()
//
// Run standalone (`node web/server.mjs [--port N]`) or together with the LAN node
// server via `scripts/serve.mjs`, which starts both. Loopback only; session-bound — it
// dies with the terminal that started it.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebApi } from "./api.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
// The scripts/lib/format.mjs formatters are the ONE display-formatting source — the
// browser imports them directly from the server's static route instead of re-spelling
// them. fmtUptime/fmtMem/fmtAgo have no Node-only deps; exporting fmtAgo is the only
// addition to format.mjs.
const LIBS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib");

// Extension-whitelisted static serving: the UI's own files re-read per request (no
// restart to iterate the console), and nothing outside public/ or lib/ is ever served.
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};
function staticFile(urlPath) {
  if (urlPath === "/") urlPath = "/index.html";
  const rel = urlPath.replace(/^\//, "");
  if (!rel || rel.includes("..")) return null;
  // lib/ mapping FIRST: /lib/format.mjs → scripts/lib/format.mjs. It must be checked
  // before the public prefix test — web/public/lib/... also starts with PUBLIC_DIR.
  const libMatch = rel.match(/^lib\/(.+)$/);
  if (libMatch) {
    const p = resolve(LIBS, libMatch[1]);
    if (!p.startsWith(resolve(LIBS) + "\\") || extname(p).toLowerCase() !== ".mjs" || !existsSync(p)) return null;
    return { path: p, type: CONTENT_TYPES[".mjs"] };
  }
  const inPublic = resolve(PUBLIC_DIR, rel).startsWith(resolve(PUBLIC_DIR) + "\\")
    || resolve(PUBLIC_DIR, rel) === resolve(PUBLIC_DIR);
  if (inPublic) {
    const ext = extname(rel).toLowerCase();
    if (!CONTENT_TYPES[ext] || !existsSync(join(PUBLIC_DIR, rel))) return null;
    return { path: join(PUBLIC_DIR, rel), type: CONTENT_TYPES[ext] };
  }
  return null;
}

/** Start the console. Returns { port, close }. Throws EADDRINUSE like any listen. */
export async function startConsole({ port = 7678, host = "127.0.0.1" } = {}) {
  const api = createWebApi();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const asset = req.method === "GET" && staticFile(url.pathname);
    if (asset) {
      res.writeHead(200, { "content-type": asset.type });
      res.end(readFileSync(asset.path));
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { port, close: () => new Promise((r) => server.close(r)) };
}

/** True when a fabric console already answers on the port (idempotent-start probe).
 *  Probes the static index, not the API — /api/catalogue's first hit runs seconds-long
 *  provider probes and would blow the timeout (observed live 2026-08-09). */
export async function consoleAlreadyServing(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return r.ok && (r.headers.get("content-type") || "").includes("text/html");
  } catch { return false; }
}

// ── CLI ──
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pf = args.indexOf("--port");
  const port = pf !== -1 ? Number(args[pf + 1]) : 7678;
  try {
    await startConsole({ port });
    process.stdout.write(`fabric console: http://127.0.0.1:${port}  (local only; close this terminal to stop)\n`);
  } catch (e) {
    if (e.code === "EADDRINUSE" && await consoleAlreadyServing(port)) {
      process.stdout.write(`fabric console already serving on http://127.0.0.1:${port} — nothing to do\n`);
      process.exit(0);
    }
    process.stderr.write(`fabric console: ${e.message}\n`);
    process.exit(1);
  }
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
