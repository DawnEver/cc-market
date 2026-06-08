import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const JOBS_DIR = path.join(os.homedir(), ".claude", "takeover", "jobs");

function ensureDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

export function createJob(toolName, params) {
  ensureDir();
  const jobId = `job-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
  const jobDir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const state = {
    id: jobId,
    tool: toolName,
    params,
    pid: null,
    status: "queued",
    startTime: new Date().toISOString(),
    endTime: null,
    result: null,
    error: null,
    progressLog: path.join(jobDir, "progress.log"),
  };

  fs.writeFileSync(path.join(jobDir, "state.json"), JSON.stringify(state, null, 2));
  return { jobId, state, jobDir };
}

export function updateJob(jobId, update) {
  const statePath = path.join(JOBS_DIR, jobId, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  Object.assign(state, update);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

export function getJobStatus(jobId) {
  const statePath = path.join(JOBS_DIR, jobId, "state.json");
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function cancelJob(jobId, signal = "SIGTERM") {
  const state = getJobStatus(jobId);
  if (!state) throw new Error(`Job not found: ${jobId}`);
  if (state.status !== "running") {
    return { cancelled: false, reason: `Job status is ${state.status}` };
  }
  try { process.kill(state.pid, signal); } catch { /* already dead */ }
  updateJob(jobId, { status: "cancelled", endTime: new Date().toISOString() });
  return { cancelled: true };
}

export function listJobs() {
  ensureDir();
  return fs.readdirSync(JOBS_DIR)
    .filter((d) => fs.statSync(path.join(JOBS_DIR, d)).isDirectory())
    .map((d) => getJobStatus(d))
    .filter(Boolean)
    .sort((a, b) => b.startTime.localeCompare(a.startTime));
}
