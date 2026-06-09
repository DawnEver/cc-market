import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, queryDailySummary } from '../scripts/db.mjs';

// Test the pure logic: dumpDailyData, importDailyData, verifyConsistency
// (git/age operations tested manually)

const TEST_DB = join(tmpdir(), `traceme-sync-${randomUUID()}.db`);

describe('Sync Data Dump/Import', () => {
  before(() => {
    process.env.TRACEME_DB_PATH = TEST_DB;
    // Seed test data
    const db = openDb({ path: TEST_DB });
    db.prepare(`INSERT OR REPLACE INTO sessions (id, project, project_path, branch, started_at, prompt_count, total_tokens, total_cost)
      VALUES (?,?,?,?,?,?,?,?)`).run('sess-s1', 'my-project', '/home/user/my-project', 'main', '2026-06-09T10:00:00Z', 5, 25000, 0.095);
    db.prepare(`INSERT OR REPLACE INTO daily_summary (date, project, session_count, prompt_count, total_tokens, total_cost, top_model)
      VALUES (?,?,?,?,?,?,?)`).run('2026-06-09', 'my-project', 1, 5, 25000, 0.095, 'claude-sonnet-4');
    db.prepare(`INSERT OR REPLACE INTO tool_calls (id, session_id, tool_name, summary, timestamp)
      VALUES (?,?,?,?,?)`).run('t1', 'sess-s1', 'Edit', 'Edit src/a.js', '2026-06-09T10:02:00Z');
    db.prepare(`INSERT OR REPLACE INTO tool_calls (id, session_id, tool_name, summary, timestamp)
      VALUES (?,?,?,?,?)`).run('t2', 'sess-s1', 'Bash', 'npm test', '2026-06-09T10:03:00Z');
    db.prepare(`INSERT OR REPLACE INTO skill_calls (id, session_id, skill_name, timestamp)
      VALUES (?,?,?,?)`).run(1, 'sess-s1', 'sharp-review', '2026-06-09T11:00:00Z');
  });

  after(() => {
    closeDb();
    delete process.env.TRACEME_DB_PATH;
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('should dump daily data with correct structure', async () => {
    // Dynamic import to get fresh TRACEME_DB_PATH
    const { dumpDailyData } = await import('../scripts/sync.mjs');
    const data = dumpDailyData('2026-06-09');

    assert.equal(data.version, 1);
    assert.equal(data.date, '2026-06-09');
    assert.ok(data.device);
    assert.ok(data.generated_at);
    assert.equal(data.daily_summary.length, 1);
    assert.equal(data.daily_summary[0].project, 'my-project');
    assert.equal(data.daily_summary[0].total_tokens, 25000);
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].project, 'my-project');
    // Prompt text must NOT be in sessions
    assert.equal(data.sessions[0].text, undefined);
    // project_path must NOT be in sessions
    assert.equal(data.sessions[0].project_path, undefined);
    assert.equal(data.tool_usage.length, 2);
    assert.equal(data.skill_usage.length, 1);
  });

  it('should import data from another device without corrupting local', async () => {
    const { importDailyData } = await import('../scripts/sync.mjs');
    const foreignData = {
      version: 1,
      date: '2026-06-09',
      device: 'linxu-mac',
      generated_at: '2026-06-09T23:00:00Z',
      daily_summary: [
        { project: 'my-project', session_count: 2, prompt_count: 8, total_tokens: 30000, total_cost: 0.12, top_model: 'claude-opus-4' },
        { project: 'other-project', session_count: 1, prompt_count: 3, total_tokens: 10000, total_cost: 0.04, top_model: 'claude-sonnet-4' },
      ],
      sessions: [
        { id: 'sess-m1', project: 'my-project', branch: 'feat/x', started_at: '2026-06-09T14:00:00Z', ended_at: '2026-06-09T15:00:00Z', prompt_count: 4, total_tokens: 15000, total_cost: 0.06 },
        { id: 'sess-m2', project: 'other-project', branch: 'main', started_at: '2026-06-09T16:00:00Z', ended_at: '2026-06-09T17:00:00Z', prompt_count: 3, total_tokens: 10000, total_cost: 0.04 },
      ],
      tool_usage: [{ tool_name: 'Edit', count: 3 }, { tool_name: 'Grep', count: 2 }],
      skill_usage: [{ skill_name: 'code-review', count: 1 }],
    };

    importDailyData(foreignData);

    const db = openDb();
    // Should now have both projects
    const summary = queryDailySummary('2026-06-09');
    assert.equal(summary.length, 2);
    const myProj = summary.find(r => r.project === 'my-project');
    assert.ok(myProj);
    // Local had 1 session, foreign had 2 — MAX keeps 2
    assert.equal(myProj.session_count, 2);

    // New session should be inserted (foreign sessions)
    const allSessions = db.prepare("SELECT * FROM sessions WHERE date(started_at)='2026-06-09'").all();
    assert.equal(allSessions.length, 3); // 1 local + 2 foreign

    // Original local session intact
    const localSess = db.prepare('SELECT * FROM sessions WHERE id=?').get('sess-s1');
    assert.equal(localSess.total_tokens, 25000);
  });

  it('should not re-insert duplicate sessions', async () => {
    const { importDailyData } = await import('../scripts/sync.mjs');
    // Re-import same foreign data
    const sameData = {
      version: 1, date: '2026-06-09', device: 'linxu-mac',
      daily_summary: [{ project: 'other-project', session_count: 1, prompt_count: 3, total_tokens: 10000, total_cost: 0.04, top_model: 'claude-sonnet-4' }],
      sessions: [{ id: 'sess-m1', project: 'my-project', branch: 'feat/x', started_at: '2026-06-09T14:00:00Z', prompt_count: 4, total_tokens: 15000, total_cost: 0.06 }],
      tool_usage: [],
      skill_usage: [],
    };
    importDailyData(sameData);

    const db = openDb();
    const allSessions = db.prepare("SELECT * FROM sessions WHERE date(started_at)='2026-06-09'").all();
    // Still 3 — no duplicates
    assert.equal(allSessions.length, 3);
  });

  it('should return empty dump for date with no data', async () => {
    const { dumpDailyData } = await import('../scripts/sync.mjs');
    const data = dumpDailyData('2025-01-01');
    assert.equal(data.daily_summary.length, 0);
    assert.equal(data.sessions.length, 0);
  });
});
