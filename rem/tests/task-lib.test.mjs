/**
 * Tests for rem/scripts/task-lib.mjs — task management logic.
 * Run: node --test cc-market/rem/tests/task-lib.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Pure-function imports (no filesystem dependency) ────────────────────────────

import {
  STALE_DAYS, TASK_LINE_RE,
  isStale, detectScale,
  parseExistingTasks,
  groupByModule, groupByCategory,
  scanMemoryForFindings, scanManualTasks,
  markFinding,
} from "../scripts/task-lib.mjs";

// ── Constants ────────────────────────────────────────────────────────────────────

test("STALE_DAYS is 90", () => assert.equal(STALE_DAYS, 90));

test("TASK_LINE_RE matches standard task line", () => {
  const m = "- [ ] SR-20260608-001 [HIGH] Some bug description (2026-06-08)".match(TASK_LINE_RE);
  assert.ok(m);
  assert.equal(m[1], " ");
  assert.equal(m[2], "SR-20260608-001");
  assert.equal(m[3], "HIGH");
  assert.equal(m[4], "Some bug description");
  assert.equal(m[5], "2026-06-08");
});

test("TASK_LINE_RE matches checked lines", () => {
  const m = "- [x] MANUAL-20260609-001 [LOW] Done (undefined)".match(TASK_LINE_RE);
  assert.ok(m);
  assert.equal(m[1], "x");
  assert.equal(m[5], "undefined");
});

test("TASK_LINE_RE matches compact date format", () => {
  const m = "- [ ] SR-20260608-001 [MEDIUM] Bug (20260608)".match(TASK_LINE_RE);
  assert.ok(m);
  assert.equal(m[5], "20260608");
});

test("TASK_LINE_RE matches lines with trailing annotations", () => {
  const m = "- [ ] SR-001 [HIGH] Bug (2026-06-08) ⚠ stale ⚠ likely-resolved".match(TASK_LINE_RE);
  assert.ok(m);
  assert.equal(m[4], "Bug");
});

// ── isStale ──────────────────────────────────────────────────────────────────────

describe("isStale", () => {
  test("returns false when no discovered date", () => {
    assert.equal(isStale({}, "2026-06-09"), false);
  });

  test("returns false for recent finding", () => {
    assert.equal(isStale({ discovered: "2026-06-08" }, "2026-06-09"), false);
  });

  test("returns true for finding older than 90 days", () => {
    assert.equal(isStale({ discovered: "2026-01-01" }, "2026-06-09"), true);
  });

  test("returns false exactly at 90-day boundary (day 91 is stale)", () => {
    // 2026-03-11 to 2026-06-09 = 90 days exactly
    assert.equal(isStale({ discovered: "2026-03-11" }, "2026-06-09"), false);
  });
});

// ── detectScale ──────────────────────────────────────────────────────────────────

describe("detectScale", () => {
  test("small: 0–9", () => {
    assert.equal(detectScale(0), "small");
    assert.equal(detectScale(9), "small");
  });

  test("medium: 10–49", () => {
    assert.equal(detectScale(10), "medium");
    assert.equal(detectScale(49), "medium");
  });

  test("large: 50+", () => {
    assert.equal(detectScale(50), "large");
    assert.equal(detectScale(100), "large");
  });
});

// ── parseExistingTasks ───────────────────────────────────────────────────────────

describe("parseExistingTasks", () => {
  test("returns empty map for empty content", () => {
    assert.equal(parseExistingTasks("").size, 0);
    assert.equal(parseExistingTasks(null).size, 0);
  });

  test("parses single task with all fields", () => {
    const content = [
      "## engine",
      "- [ ] SR-20260608-001 [HIGH] Some bug (2026-06-08)",
    ].join("\n");
    const result = parseExistingTasks(content);
    assert.equal(result.size, 1);
    const t = result.get("SR-20260608-001");
    assert.equal(t.id, "SR-20260608-001");
    assert.equal(t.checked, false);
    assert.equal(t.severity, "HIGH");
    assert.equal(t.summary, "Some bug");
    assert.equal(t.discovered, "2026-06-08");
    assert.equal(t.module, "engine");
  });

  test("parses checked task", () => {
    const content = "- [x] SR-001 [MEDIUM] Fixed (2026-06-08)";
    assert.equal(parseExistingTasks(content).get("SR-001").checked, true);
  });

  test("handles undefined date", () => {
    const content = "- [ ] SR-001 [HIGH] Bug (undefined)";
    assert.equal(parseExistingTasks(content).get("SR-001").discovered, undefined);
  });

  test("normalizes compact date (20260608) to ISO (2026-06-08)", () => {
    const content = "- [ ] SR-001 [MEDIUM] Bug (20260608)";
    assert.equal(parseExistingTasks(content).get("SR-001").discovered, "2026-06-08");
  });

  test("tracks current module from ## section headers", () => {
    const content = [
      "## first",
      "- [ ] SR-001 [HIGH] A (2026-06-01)",
      "## second",
      "- [ ] SR-002 [LOW] B (2026-06-02)",
    ].join("\n");
    const result = parseExistingTasks(content);
    assert.equal(result.get("SR-001").module, "first");
    assert.equal(result.get("SR-002").module, "second");
  });

  test("### sub-headers override module (medium-format semantics)", () => {
    const content = [
      "## module-a",
      "### sub-section",
      "- [ ] SR-001 [HIGH] Bug (2026-06-01)",
    ].join("\n");
    // ### overrides module — correct for medium format where ## is category, ### is module
    assert.equal(parseExistingTasks(content).get("SR-001").module, "sub-section");
  });

  test("defaults module to 'unknown' when no ## header", () => {
    const content = "- [ ] SR-001 [HIGH] Bug (2026-06-01)";
    assert.equal(parseExistingTasks(content).get("SR-001").module, "unknown");
  });

  test("handles multiple tasks in same module", () => {
    const content = [
      "## engine",
      "- [ ] SR-001 [HIGH] A (2026-06-01)",
      "- [ ] SR-002 [MEDIUM] B (2026-06-02)",
      "- [x] SR-003 [LOW] C (2026-06-03)",
    ].join("\n");
    const result = parseExistingTasks(content);
    assert.equal(result.size, 3);
    [["SR-001", "engine"], ["SR-002", "engine"], ["SR-003", "engine"]].forEach(([id, mod]) => {
      assert.equal(result.get(id).module, mod);
    });
  });
});

// ── groupByModule / groupByCategory ──────────────────────────────────────────────

describe("groupByModule", () => {
  test("groups findings by module, defaults missing to 'unknown'", () => {
    const findings = [
      { id: "SR-001", module: "engine" },
      { id: "SR-002", module: "engine" },
      { id: "SR-003", module: "ui" },
      { id: "SR-004" },
    ];
    const groups = groupByModule(findings);
    assert.equal(groups.get("engine").length, 2);
    assert.equal(groups.get("ui").length, 1);
    assert.equal(groups.get("unknown").length, 1);
  });
});

describe("groupByCategory", () => {
  test("groups by category, seeds Bug/Feature/Performance buckets", () => {
    const findings = [
      { id: "SR-001", category: "Bug" },
      { id: "SR-002", category: "Bug" },
      { id: "SR-003", category: "Feature" },
      { id: "SR-004" },
    ];
    const groups = groupByCategory(findings);
    assert.equal(groups.Bug.length, 3); // 2 explicit + 1 default
    assert.equal(groups.Feature.length, 1);
    assert.equal(groups.Performance.length, 0);
  });
});

// ── scanMemoryForFindings / scanManualTasks ──────────────────────────────────────

describe("scanMemoryForFindings", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-lib-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for empty directory", () => {
    assert.deepEqual(scanMemoryForFindings(tmpDir), []);
  });

  test("parses OPEN finding from sharp-review.md", () => {
    const dayDir = path.join(tmpDir, "2026", "06", "09");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "sharp-review.md"), [
      "---",
      "name: sharp-review-2026-06-09",
      "description: Sharp review findings — 2 total",
      "metadata:",
      "  type: project",
      "---",
      "",
      "## Review 2026-06-09",
      "",
      "### [SR-20260609-001] [HIGH] test/file.js — A serious bug",
      "- **Category:** Bug",
      "- **Module:** engine",
      "- **Status:** OPEN",
      "- **Suggestion:** Fix it",
      "",
      "### [SR-20260609-002] [LOW] test/ui.js — Minor glitch",
      "- **Category:** Feature",
      "- **Module:** ui",
      "- **Status:** FIXED",
      "- **Suggestion:** Already fixed",
    ].join("\n"), "utf8");

    const findings = scanMemoryForFindings(tmpDir);
    const open = findings.filter(f => f.status === "open");
    const fixed = findings.filter(f => f.status === "fixed");

    assert.equal(findings.length, 2);
    assert.equal(open.length, 1);
    assert.equal(fixed.length, 1);

    assert.equal(open[0].id, "SR-20260609-001");
    assert.equal(open[0].severity, "HIGH");
    assert.equal(open[0].summary, "A serious bug");
    assert.equal(open[0].discovered, "2026-06-09");
    assert.equal(open[0].module, "engine");
    assert.equal(open[0].file, "test/file.js");
  });

  test("skips non-sharp-review.md files", () => {
    const dayDir = path.join(tmpDir, "2026", "06", "09");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "other.md"), "### [SR-001] [HIGH] — Nope", "utf8");

    assert.deepEqual(scanMemoryForFindings(tmpDir), []);
  });

  test("handles multiple date directories", () => {
    const dir1 = path.join(tmpDir, "2026", "06", "08");
    const dir2 = path.join(tmpDir, "2026", "06", "09");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    fs.writeFileSync(path.join(dir1, "sharp-review.md"), [
      "---", "name: r1", "---",
      "### [SR-20260608-001] [MEDIUM] a.js — Bug (2026-06-08)",
      "- **Status:** OPEN",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(dir2, "sharp-review.md"), [
      "---", "name: r2", "---",
      "### [SR-20260609-001] [LOW] b.js — Feat (2026-06-09)",
      "- **Status:** FIXED",
    ].join("\n"), "utf8");

    const findings = scanMemoryForFindings(tmpDir);
    assert.equal(findings.length, 2);
  });
});

describe("scanManualTasks", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-lib-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for empty directory", () => {
    assert.deepEqual(scanManualTasks(tmpDir), []);
  });

  test("parses manual tasks from manual.md", () => {
    const dayDir = path.join(tmpDir, "2026", "06", "09");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "manual.md"), [
      "## manual",
      "- [ ] MANUAL-20260609-001 [LOW] Write docs (2026-06-09)",
      "- [x] MANUAL-20260609-002 [MEDIUM] Fix bug (2026-06-09)",
    ].join("\n"), "utf8");

    const tasks = scanManualTasks(tmpDir);
    assert.equal(tasks.length, 2);
    const open = tasks.filter(t => t.status === "open");
    const fixed = tasks.filter(t => t.status === "fixed");
    assert.equal(open.length, 1);
    assert.equal(fixed.length, 1);
    assert.equal(open[0].id, "MANUAL-20260609-001");
    assert.equal(open[0].summary, "Write docs");
    assert.equal(open[0].module, "manual");
  });

  test("ignores non-MANUAL entries in manual.md", () => {
    const dayDir = path.join(tmpDir, "2026", "06", "09");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "manual.md"), [
      "- [ ] SR-001 [HIGH] Bug (2026-06-09)",
      "- [ ] MANUAL-20260609-001 [LOW] Task (2026-06-09)",
    ].join("\n"), "utf8");

    const tasks = scanManualTasks(tmpDir);
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].id.startsWith("MANUAL-"));
  });
});

// ── markFinding ────────────────────────────────────────────────────────────────

describe("markFinding", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-lib-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeReview(content) {
    const dayDir = path.join(tmpDir, "2026", "06", "09");
    fs.mkdirSync(dayDir, { recursive: true });
    const file = path.join(dayDir, "sharp-review.md");
    fs.writeFileSync(file, content, "utf8");
    return file;
  }

  test("marks SR finding fixed and updates frontmatter", () => {
    const file = writeReview([
      "---",
      "name: sharp-review-2026-06-09",
      "description: Sharp review findings — 1 total",
      "metadata:",
      "  type: project",
      "---",
      "",
      "### [SR-20260609-901] [HIGH] test/file.js — A serious bug",
      "- **Category:** Bug",
      "- **Module:** engine",
      "- **Status:** OPEN",
      "- **Suggestion:** Fix it",
    ].join("\n"), "utf8");

    const result = markFinding(tmpDir, "SR-20260609-901", "fixed");
    assert.equal(result.found, true);
    assert.equal(result.file, file);

    const content = fs.readFileSync(file, "utf8");
    assert.match(content, /\*\*Status:\*\*\s*FIXED/);
  });

  test("marks SR finding open", () => {
    const file = writeReview([
      "---", "name: sharp-review-2026-06-09", "---",
      "### [SR-20260609-901] [HIGH] test/file.js — A serious bug",
      "- **Status:** FIXED",
    ].join("\n"), "utf8");

    const result = markFinding(tmpDir, "SR-20260609-901", "open");
    assert.equal(result.found, true);
    assert.match(fs.readFileSync(file, "utf8"), /\*\*Status:\*\*\s*OPEN/);
  });

  test("returns error for unknown SR id", () => {
    writeReview([
      "---", "name: sharp-review-2026-06-09", "---",
      "### [SR-20260609-901] [HIGH] test/file.js — A serious bug",
      "- **Status:** OPEN",
    ].join("\n"), "utf8");

    const result = markFinding(tmpDir, "SR-20260609-999", "fixed");
    assert.equal(result.found, false);
    assert.match(result.error, /not found/);
  });

  test("toggles MANUAL task checkbox", () => {
    const dayDir = path.join(tmpDir, "2026", "06", "09");
    fs.mkdirSync(dayDir, { recursive: true });
    const file = path.join(dayDir, "manual.md");
    fs.writeFileSync(file, "- [ ] MANUAL-20260609-001 [LOW] Write docs (2026-06-09)\n", "utf8");

    const fixed = markFinding(tmpDir, "MANUAL-20260609-001", "fixed");
    assert.equal(fixed.found, true);
    assert.match(fs.readFileSync(file, "utf8"), /- \[x\] MANUAL-20260609-001/);

    const reopened = markFinding(tmpDir, "MANUAL-20260609-001", "open");
    assert.equal(reopened.found, true);
    assert.match(fs.readFileSync(file, "utf8"), /- \[ \] MANUAL-20260609-001/);
  });

  test("rejects invalid status", () => {
    const result = markFinding(tmpDir, "SR-20260609-901", "wat");
    assert.equal(result.found, false);
    assert.match(result.error, /Invalid status/);
  });

  test("rejects unknown id format", () => {
    const result = markFinding(tmpDir, "FOO-001", "fixed");
    assert.equal(result.found, false);
    assert.match(result.error, /Unknown ID format/);
  });
});



