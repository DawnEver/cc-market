// Tests for engine/sysinfo.mjs (cross-platform system facts) and scripts/lib/format.mjs
// (fleet display formatting). No network, no child processes — the CPU sample runs a
// ~40ms wait at most, the rest is pure math.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleCpuBusyPct, localStatus } from "../engine/sysinfo.mjs";
import { fmtUptime, fmtMem, fmtAgo } from "../scripts/lib/format.mjs";

test("sampleCpuBusyPct(<=0) skips the sample and returns null (cheap callers opt out)", async () => {
  assert.equal(await sampleCpuBusyPct(0), null);
  assert.equal(await sampleCpuBusyPct(-5), null);
});

test("sampleCpuBusyPct over a real window returns a number in [0,100]", async () => {
  const busy = await sampleCpuBusyPct(40);
  assert.equal(typeof busy, "number");
  assert.ok(busy >= 0 && busy <= 100, `busy=${busy} must be within [0,100]`);
});

test("localStatus reports the machine facts node/status shapes", async () => {
  const st = await localStatus({ cpuSampleMs: 0 }); // skip the wait; cpu_busy_pct is null
  assert.equal(typeof st.hostname, "string");
  assert.equal(typeof st.uptime_s, "number");
  assert.ok(st.uptime_s >= 0);
  assert.ok(Number.isInteger(st.cpu) && st.cpu > 0, `cpu cores = ${st.cpu}`);
  assert.equal(st.cpu_busy_pct, null);
  assert.ok(st.mem_available_mb > 0 && st.mem_total_mb > 0);
  assert.ok(st.mem_available_mb <= st.mem_total_mb);
});

test("localStatus with a sample computes cpu_busy_pct", async () => {
  const st = await localStatus({ cpuSampleMs: 40 });
  assert.equal(typeof st.cpu_busy_pct, "number");
  assert.ok(st.cpu_busy_pct >= 0 && st.cpu_busy_pct <= 100);
});

test("fmtUptime renders days/hours/minutes, dropping leading zero units", () => {
  assert.equal(fmtUptime(0), "0s");
  assert.equal(fmtUptime(59), "59s");
  assert.equal(fmtUptime(60), "1m");
  assert.equal(fmtUptime(3600), "1h");
  assert.equal(fmtUptime(3661), "1h 1m");
  assert.equal(fmtUptime(90061), "1d 1h 1m");
  assert.equal(fmtUptime(2 * 86400 + 3 * 3600 + 5 * 60), "2d 3h 5m");
  // non-numeric / negative input is clamped, never a crash
  assert.equal(fmtUptime(-10), "0s");
  assert.equal(fmtUptime(undefined), "0s");
});

test("fmtMem renders MB under 1GB, GB above", () => {
  assert.equal(fmtMem(512), "512MB");
  assert.equal(fmtMem(1023), "1023MB");
  assert.equal(fmtMem(1024), "1.0GB");
  assert.equal(fmtMem(2048), "2.0GB");
  assert.equal(fmtMem(32600), "31.8GB");
  assert.equal(fmtMem(undefined), "?");
});

test("fmtAgo renders relative human time", () => {
  const now = Date.now();
  assert.equal(fmtAgo(now - 3000), "just now");
  assert.equal(fmtAgo(now - 20000), "20s ago");
  assert.equal(fmtAgo(now - 120000), "2m ago");
  assert.equal(fmtAgo(now - 3 * 3600000), "3h ago");
  assert.equal(fmtAgo(now - 2 * 86400000), "2d ago");
  assert.equal(fmtAgo(null), "");
});
