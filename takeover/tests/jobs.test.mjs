import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createJob, getJobStatus, listJobs, cancelJob } from "../scripts/jobs.mjs";

describe("createJob", () => {
  test("creates job with queued status and valid id", () => {
    const { jobId, state, jobDir } = createJob("codex_task", { prompt: "hello" });

    assert.ok(jobId.startsWith("job-"));
    assert.equal(state.status, "queued");
    assert.equal(state.tool, "codex_task");
    assert.deepEqual(state.params, { prompt: "hello" });
    assert.ok(fs.existsSync(jobDir));
    assert.ok(fs.existsSync(path.join(jobDir, "state.json")));

    // Cleanup
    fs.rmSync(jobDir, { recursive: true, force: true });
  });
});

describe("getJobStatus", () => {
  test("returns null for unknown job", () => {
    assert.equal(getJobStatus("nonexistent-job-id"), null);
  });

  test("returns state for created job", () => {
    const { jobId, state } = createJob("codex_task", { prompt: "test" });
    const loaded = getJobStatus(jobId);
    assert.equal(loaded.id, jobId);
    assert.equal(loaded.status, "queued");

    // Cleanup
    const jobsDir = path.join(os.homedir(), ".claude", "takeover", "jobs", jobId);
    fs.rmSync(jobsDir, { recursive: true, force: true });
  });
});

describe("cancelJob", () => {
  test("throws for unknown job", () => {
    assert.throws(() => cancelJob("nonexistent-job-id"), /Job not found/);
  });

  test("returns not-cancelled for non-running job", () => {
    const { jobId } = createJob("codex_task", { prompt: "test" });
    const result = cancelJob(jobId);
    assert.equal(result.cancelled, false);
    assert.ok(result.reason.includes("queued"));

    // Cleanup
    const jobsDir = path.join(os.homedir(), ".claude", "takeover", "jobs", jobId);
    fs.rmSync(jobsDir, { recursive: true, force: true });
  });
});

describe("listJobs", () => {
  test("returns array (may be empty)", () => {
    const jobs = listJobs();
    assert.ok(Array.isArray(jobs));
  });
});
