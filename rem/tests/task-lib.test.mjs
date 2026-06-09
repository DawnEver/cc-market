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
  archiveResolved,
  scanMemoryForFindings, scanManualTasks,
  ARCHIVE_DIR,
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
      "created: 2026-06-09",
      "accessed: 2026-06-09",
      "tier: short",
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

// ── archiveResolved (integration — writes to real project archive) ──────────────

describe("archiveResolved", () => {
  let savedFiles = new Map(); // path → content (or null if didn't exist)
  const TEST_IDS = ["TEST-ARCHIVE-001", "TEST-ARCHIVE-002", "TEST-ARCHIVE-003", "TEST-ARCHIVE-004"];

  beforeEach(() => {
    // Snapshot archive files that may be touched (YYYY/MM/DD.md structure)
    const days = ["2026/06/08", "2026/05/30", "2026/06/09", "2026/07/01"];
    for (const d of days) {
      const f = path.join(ARCHIVE_DIR, `${d}.md`);
      if (fs.existsSync(f)) {
        savedFiles.set(f, fs.readFileSync(f, "utf8"));
      } else {
        savedFiles.set(f, null);
      }
    }
  });

  afterEach(() => {
    for (const [f, content] of savedFiles) {
      if (content === null) {
        if (fs.existsSync(f)) {
          const current = fs.readFileSync(f, "utf8");
          if (TEST_IDS.some(id => current.includes(id))) {
            // Remove lines containing TEST_ ids
            const cleaned = current.split('\n').filter(l => !TEST_IDS.some(id => l.includes(id))).join('\n').trim();
            if (cleaned.replace(/^# .+\n*/, '').trim() === '') {
              // Only header left — remove file and empty parent dirs
              fs.unlinkSync(f);
            } else {
              fs.writeFileSync(f, cleaned + '\n', "utf8");
            }
          }
        }
      } else {
        fs.writeFileSync(f, content, "utf8");
      }
    }
  });

  test("creates archive files grouped by day", () => {
    const findings = [
      { id: "TEST-ARCHIVE-001", severity: "HIGH", status: "fixed", summary: "Bug A", discovered: "2026-06-08" },
      { id: "TEST-ARCHIVE-002", severity: "MEDIUM", status: "fixed", summary: "Bug B", discovered: "2026-05-30" },
    ];
    archiveResolved(findings, "2026-06-09", "[test]");

    const junFile = path.join(ARCHIVE_DIR, "2026/06/08.md");
    assert.ok(fs.existsSync(junFile));
    const junContent = fs.readFileSync(junFile, "utf8");
    assert.ok(junContent.includes("TEST-ARCHIVE-001"));
    assert.ok(junContent.includes("Bug A"));

    const mayFile = path.join(ARCHIVE_DIR, "2026/05/30.md");
    assert.ok(fs.existsSync(mayFile));
    const mayContent = fs.readFileSync(mayFile, "utf8");
    assert.ok(mayContent.includes("TEST-ARCHIVE-002"));
    assert.ok(mayContent.includes("Bug B"));
  });

  test("does not duplicate entries already in archive", () => {
    const dayFile = path.join(ARCHIVE_DIR, "2026/06/08.md");
    const dir = path.dirname(dayFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(dayFile) ? fs.readFileSync(dayFile, "utf8") : "# Resolved Tasks — 2026-06-08\n";
    if (!existing.includes("TEST-ARCHIVE-003")) {
      fs.writeFileSync(dayFile, existing.trimEnd() + "\n\n- [x] TEST-ARCHIVE-003 [LOW] Already there\n      → FIXED 2026-06-09: marked resolved\n\n", "utf8");
    }

    const findings = [
      { id: "TEST-ARCHIVE-003", severity: "LOW", status: "fixed", summary: "Already there", discovered: "2026-06-08" },
      { id: "TEST-ARCHIVE-004", severity: "HIGH", status: "fixed", summary: "New bug", discovered: "2026-06-09" },
    ];
    archiveResolved(findings, "2026-06-09", "[test]");

    const content = fs.readFileSync(dayFile, "utf8");
    const count = [...content.matchAll(/TEST-ARCHIVE-003/g)].length;
    assert.equal(count, 1);
    // TEST-ARCHIVE-004 goes to its own day file
    const day2File = path.join(ARCHIVE_DIR, "2026/06/09.md");
    assert.ok(fs.existsSync(day2File));
    assert.ok(fs.readFileSync(day2File, "utf8").includes("TEST-ARCHIVE-004"));
  });

  test("skips when no resolved findings", () => {
    const findings = [
      { id: "TEST-ARCHIVE-001", severity: "HIGH", status: "open", summary: "Still open", discovered: "2026-06-08" },
    ];
    archiveResolved(findings, "2026-06-09", "[test]");
    for (const f of savedFiles.keys()) {
      if (fs.existsSync(f)) {
        assert.ok(!fs.readFileSync(f, "utf8").includes("Still open"));
      }
    }
  });

  test("resolvedDate overrides day grouping", () => {
    const findings = [
      { id: "TEST-ARCHIVE-001", severity: "HIGH", status: "fixed", summary: "Dated bug", discovered: "2026-06-08", resolvedDate: "2026-07-01" },
    ];
    archiveResolved(findings, "2026-06-09", "[test]");
    const julFile = path.join(ARCHIVE_DIR, "2026/07/01.md");
    assert.ok(fs.existsSync(julFile));
    assert.ok(fs.readFileSync(julFile, "utf8").includes("TEST-ARCHIVE-001"));
  });
});


