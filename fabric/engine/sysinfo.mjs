// engine/sysinfo.mjs — cross-platform system facts for the fleet surfaces (node/status
// capacity reporting, the MCP list_nodes "this machine" row). CPU busy % needs a short
// sample because os.loadavg() is [0,0,0] on Windows; os.cpus() cumulative times work
// everywhere, so the delta over a small window is the portable measure.

import os from "node:os";

/**
 * CPU busy % over a short window, cross-platform. Two os.cpus() reads are taken
 * `intervalMs` apart and the delta measured (user/nice/sys/irq are busy, idle is not).
 * `intervalMs <= 0` skips the wait and returns null — tests and "cheap" callers opt out.
 * Returns a number in [0,100] with one decimal, or null when it cannot be computed.
 */
export async function sampleCpuBusyPct(intervalMs = 120) {
  if (!(intervalMs > 0)) return null;
  const read = () => {
    let idle = 0, total = 0;
    for (const c of os.cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    return { idle, total };
  };
  const a = read();
  await new Promise((r) => setTimeout(r, intervalMs));
  const b = read();
  const dTotal = b.total - a.total;
  if (dTotal <= 0) return null;
  return Math.round(((dTotal - (b.idle - a.idle)) / dTotal) * 1000) / 10;
}

/**
 * This machine's status facts — the same shape node/status reports, computed locally
 * (the "this machine" row of a fleet view). `cpu_busy_pct` is null when `cpuSampleMs <= 0`.
 */
export async function localStatus({ cpuSampleMs = 120 } = {}) {
  const cpuBusy = await sampleCpuBusyPct(cpuSampleMs);
  return {
    hostname: os.hostname(),
    uptime_s: Math.round(os.uptime()),
    cpu: os.cpus().length,
    cpu_busy_pct: cpuBusy,
    mem_available_mb: Math.round(os.freemem() / 1048576),
    mem_total_mb: Math.round(os.totalmem() / 1048576),
  };
}
