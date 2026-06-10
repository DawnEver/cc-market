import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb } from '../scripts/db.mjs';
import { generateReport, generateStats } from '../scripts/report.mjs';

const TEST_DB = join(tmpdir(), `traceme-report-${randomUUID()}.db`);

describe('Report Generator', () => {
  before(() => {
    process.env.TRACEME_DB_PATH = TEST_DB;
    const db = openDb({ path: TEST_DB });

    db.prepare(`INSERT OR REPLACE INTO sessions (id, project, project_path, branch, started_at, prompt_count, total_tokens, total_cost)
      VALUES (?,?,?,?,?,?,?,?)`).run('sess-r1', 'my-project', '/home/user/my-project', 'main', '2026-06-09T10:00:00Z', 2, 12000, 0.045);

    db.prepare(`INSERT OR REPLACE INTO prompts (id, session_id, turn_index, text, timestamp, input_tokens, output_tokens, cache_tokens, cost_usd, model)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('sess-r1_0', 'sess-r1', 0, 'Refactor the auth module', '2026-06-09T10:01:00Z', 5000, 2000, 1000, 0.025, 'claude-sonnet-4');

    db.prepare(`INSERT OR REPLACE INTO prompts (id, session_id, turn_index, text, timestamp, input_tokens, output_tokens, cache_tokens, cost_usd, model)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('sess-r1_1', 'sess-r1', 1, 'Add tests for auth flow', '2026-06-09T10:30:00Z', 3000, 1500, 500, 0.020, 'claude-sonnet-4');

    db.prepare(`INSERT OR REPLACE INTO tool_calls (id, session_id, tool_name, summary, timestamp)
      VALUES (?,?,?,?,?)`).run('tr1', 'sess-r1', 'Edit', 'Edit src/auth.js', '2026-06-09T10:02:00Z');
    db.prepare(`INSERT OR REPLACE INTO tool_calls (id, session_id, tool_name, summary, timestamp)
      VALUES (?,?,?,?,?)`).run('tr2', 'sess-r1', 'Bash', 'npm test', '2026-06-09T10:03:00Z');
    db.prepare(`INSERT OR REPLACE INTO tool_calls (id, session_id, tool_name, summary, timestamp)
      VALUES (?,?,?,?,?)`).run('tr3', 'sess-r1', 'Read', 'Read src/auth.js', '2026-06-09T10:31:00Z');

    db.prepare(`INSERT OR REPLACE INTO daily_summary (date, project, session_count, prompt_count, total_tokens, total_cost, top_model)
      VALUES (?,?,?,?,?,?,?)`).run('2026-06-09', 'my-project', 1, 2, 12000, 0.045, 'claude-sonnet-4');
  });

  after(() => {
    closeDb();
    delete process.env.TRACEME_DB_PATH;
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('should generate a daily report with project stats', () => {
    const report = generateReport('2026-06-09');
    assert.ok(report.includes('TraceMe Report'));
    assert.ok(report.includes('my-project'));
    assert.ok(report.includes('$0.045'), `Cost not found. Report: ${report.slice(0, 500)}`);
    assert.ok(report.includes('Edit'));
    assert.ok(report.includes('Bash'));
    assert.ok(report.includes('Read'));
  });

  it('should return no-data message for empty date', () => {
    const report = generateReport('2025-01-01');
    assert.ok(report.includes('No data for this date'));
  });

  it('should generate stats summary', () => {
    const stats = generateStats();
    assert.ok(stats.includes('TraceMe Stats'));
  });

  it('should label local-only output when no merged snapshot is available', () => {
    const report = generateReport('2026-06-09', { mergedSnapshot: null });
    assert.ok(report.includes('Local-only (no cross-device aggregate available'));
    assert.ok(report.includes('my-project'));
  });

  it('should prefer merged cross-device data when available', () => {
    const merged = {
      devices: ['linxu-win', 'linxu-mac'],
      aggregated_at: '2026-06-09T23:00:00Z',
      daily_summary: [
        { project: 'my-project', session_count: 3, prompt_count: 6, total_tokens: 27000, total_cost: 0.105, top_model: 'claude-sonnet-4' },
        { project: 'other-project', session_count: 1, prompt_count: 3, total_tokens: 10000, total_cost: 0.04, top_model: 'claude-sonnet-4' },
      ],
      sessions: [],
      tool_usage: [{ tool_name: 'Edit', count: 5 }],
      skill_usage: [{ skill_name: 'sharp-review', count: 2 }],
    };

    const report = generateReport('2026-06-09', { mergedSnapshot: merged });
    assert.ok(report.includes('Aggregated across 2 device(s): linxu-win, linxu-mac'));
    assert.ok(report.includes('other-project'));
    assert.ok(report.includes('37.0K'), `Total tokens not found. Report: ${report.slice(0, 600)}`);
    assert.ok(report.includes('$0.1450'), `Total cost not found. Report: ${report.slice(0, 600)}`);
    // Top prompts remain local-only even with merged data
    assert.ok(report.includes('Top Expensive Prompts'));
    assert.ok(report.includes('Local device only — prompt text not synced'));
    assert.ok(report.includes('Refactor the auth module'));
  });

  it('should generate stats from merged data when available', () => {
    const merged = {
      devices: ['linxu-win', 'linxu-mac'],
      aggregated_at: '2026-06-09T23:00:00Z',
      daily_summary: [
        { project: 'my-project', session_count: 3, prompt_count: 6, total_tokens: 27000, total_cost: 0.105, top_model: 'claude-sonnet-4' },
      ],
      sessions: [],
      tool_usage: [],
      skill_usage: [],
    };

    const stats = generateStats({ mergedSnapshot: merged });
    assert.ok(stats.includes('linxu-win, linxu-mac'));
    assert.ok(stats.includes('3 sessions'));
  });
});
