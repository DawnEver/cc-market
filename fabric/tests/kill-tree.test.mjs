// kill-tree.test.mjs — timeout/stop kills the WHOLE process tree, not the root pid:
// a `shell:true` child on Windows is cmd.exe, and killing it orphans the real process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { killTree, treeSpawnOptions } from "../engine/kill-tree.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("killTree on win32 runs taskkill /T /F on the root pid", () => {
  const calls = [];
  killTree({ pid: 42 }, { platform: "win32", _spawnSync: (...a) => calls.push(a) });
  assert.deepEqual(calls[0].slice(0, 2), ["taskkill", ["/PID", "42", "/T", "/F"]]);
});

test("killTree on posix signals the process group", () => {
  const sent = [];
  killTree({ pid: 42 }, { platform: "linux", _kill: (pid, sig) => sent.push([pid, sig]) });
  assert.deepEqual(sent, [[-42, "SIGKILL"]]);
});

test("treeSpawnOptions makes the posix child a group leader, and leaves win32 alone", () => {
  assert.equal(treeSpawnOptions("linux").detached, true);
  assert.equal(treeSpawnOptions("win32").detached, undefined);
});

test("killTree kills a grandchild started through a shell", { timeout: 15000 }, async () => {
  // root -> (shell) -> grandchild that prints its pid and idles.
  const grand = `node -e "console.log(process.pid); setInterval(() => {}, 1000)"`;
  const root = spawn(grand, { shell: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...treeSpawnOptions() });
  const gpid = await new Promise((resolve) => root.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  assert.ok(alive(gpid), "grandchild started");
  const closed = new Promise((r) => root.once("close", r));
  killTree(root);
  await closed;
  for (let i = 0; i < 50 && alive(gpid); i++) await sleep(100);
  assert.equal(alive(gpid), false, "grandchild killed with the tree");
});

test("spawnChild kills the tree on timeout", async () => {
  const { EventEmitter } = await import("node:events");
  const { spawnChild } = await import("../engine/spawn-child.mjs");
  const killed = [];
  const child = Object.assign(new EventEmitter(), { pid: 7, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  await assert.rejects(spawnChild({ provider: "claude", prompt: "hi", _spawn: () => child, _bin: "x", timeoutMs: 20, _killTree: (c) => killed.push(c) }),
    (e) => e.kind === "timeout");
  assert.deepEqual(killed, [child]);
});

test("spawnChild kills the tree on abort", async () => {
  const { EventEmitter } = await import("node:events");
  const { spawnChild } = await import("../engine/spawn-child.mjs");
  const killed = [];
  const child = Object.assign(new EventEmitter(), { pid: 7, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const ac = new AbortController();
  const p = spawnChild({ provider: "claude", prompt: "hi", _spawn: () => child, _bin: "x", signal: ac.signal, _killTree: (c) => killed.push(c) });
  setImmediate(() => ac.abort());
  await assert.rejects(p, /cancelled/);
  assert.deepEqual(killed, [child]);
});

test("CodexAppServerClient.stop kills the tree", async () => {
  const { CodexAppServerClient } = await import("../engine/codex/app-server.mjs");
  const killed = [];
  const c = new CodexAppServerClient({ clientInfo: { name: "t", version: "0" }, _killTree: (ch) => killed.push(ch) });
  c._closed = true;
  c.child = { pid: 9, stdin: { destroyed: true } };
  await c.stop();
  assert.deepEqual(killed, [c.child]);
});

test("killTree leaves an exited child alone", () => {
  const calls = [];
  killTree({ pid: 42, exitCode: 0 }, { platform: "win32", _spawnSync: (...a) => calls.push(a) });
  assert.deepEqual(calls, []);
});
