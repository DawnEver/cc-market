import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, replaceSession } from '../scripts/db.mjs';
import { generateReport, generateStats } from '../scripts/report.mjs';

const TEST_DB = join(tmpdir(), `traceme-report-${randomUUID()}.db`);

describe('Report Generator', () => {
  before(() => {
    process.env.TRACEME_DB_PATH = TEST_DB;
    openDb({ path: TEST_DB });

    replaceSession({
      id: 'sess-r1', date: '2026-06-09', project: 'my-project', project_path: '/home/user/my-project',
      repo_origin: 'github.com/user/my-project', branch: 'main',
      started_at: '2026-06-09T10:00:00Z', ended_at: '2026-06-09T11:00:00Z',
      prompt_count: 2, input_tokens: 8000, output_tokens: 3500, cache_read_tokens: 500, cache_creation_tokens: 0,
      total_tokens: 12000, total_cost: 0.045, top_model: 'claude-sonnet-4-6',
      models: [{ model: 'claude-sonnet-4-6', requests: 2, input: 8000, output: 3500, cache_read: 500, cache_creation: 0, cost: 0.045 }],
      tools: [{ tool_name: 'Edit', count: 1 }, { tool_name: 'Bash', count: 1 }, { tool_name: 'Read', count: 1 }],
      skills: [],
    });
  });

  after(() => {
    closeDb();
    delete process.env.TRACEME_DB_PATH;
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('should generate a daily report with project stats', () => {
    const report = generateReport('2026-06-09', { local: true });
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
        { project: 'my-project', repo_origin: 'github.com/user/my-project', session_count: 3, prompt_count: 6, total_tokens: 27000, total_cost: 0.105, top_model: 'claude-sonnet-4' },
        { project: 'other-project', repo_origin: 'github.com/other/other-project', session_count: 1, prompt_count: 3, total_tokens: 10000, total_cost: 0.04, top_model: 'claude-sonnet-4' },
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
  });

  it('should generate stats from local DB (always local-only)', () => {
    // Without merged data → local-only label
    const stats = generateStats({ local: true });
    assert.ok(stats.includes('TraceMe Stats'));
    assert.ok(stats.includes('Today (local only)'));
    assert.ok(stats.includes('1 sessions'));
  });

  it('should show cross-device stats when merged data is available', () => {
    const merged = {
      devices: ['linxu-win', 'linxu-mac'],
      aggregated_at: '2026-06-09T23:00:00Z',
      daily_summary: [
        { project: 'my-project', repo_origin: 'github.com/user/my-project', session_count: 3, prompt_count: 6, total_tokens: 27000, total_cost: 0.105, top_model: 'claude-sonnet-4' },
      ],
      sessions: [],
      tool_usage: [],
      skill_usage: [],
    };

    const stats = generateStats({ mergedSnapshot: merged });
    assert.ok(stats.includes('TraceMe Stats'));
    assert.ok(stats.includes('cross-device'));
    assert.ok(stats.includes('2 device(s): linxu-win, linxu-mac'));
    assert.ok(stats.includes('3 sessions'));
  });
});
