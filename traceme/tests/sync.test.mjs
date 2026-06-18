import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, queryDailySummary, replaceSession } from '../scripts/db.mjs';

// Test the pure logic: dumpDailyData, importDailyData, verifyConsistency
// (git/age operations tested manually)

const TEST_DB = join(tmpdir(), `traceme-sync-${randomUUID()}.db`);

describe('Sync Data Dump/Import', () => {
  before(() => {
    process.env.TRACEME_DB_PATH = TEST_DB;
    // Set before first import so crypto.mjs captures the test key path, not the real one
    process.env.TRACEME_KEY_FILE = join(tmpdir(), `traceme-no-key-${randomUUID()}.txt`);
    // Seed test data
    openDb({ path: TEST_DB });
    replaceSession({
      id: 'sess-s1', date: '2026-06-09', project: 'my-project', project_path: '/home/user/my-project',
      repo_origin: 'github.com/user/my-project', branch: 'main',
      started_at: '2026-06-09T10:00:00Z', ended_at: '2026-06-09T11:00:00Z',
      prompt_count: 5, input_tokens: 18000, output_tokens: 6500, cache_read_tokens: 500, cache_creation_tokens: 0,
      total_tokens: 25000, total_cost: 0.095, top_model: 'claude-sonnet-4-6',
      models: [{ model: 'claude-sonnet-4-6', requests: 5, input: 18000, output: 6500, cache_read: 500, cache_creation: 0, cost: 0.095 }],
      tools: [{ tool_name: 'Edit', count: 1 }, { tool_name: 'Bash', count: 1 }],
      skills: [{ skill_name: 'code-review', count: 2 }],
      active_min: 42,
    });
  });

  after(() => {
    closeDb();
    delete process.env.TRACEME_DB_PATH;
    delete process.env.TRACEME_KEY_FILE;
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
    assert.equal(data.daily_summary[0].repo_origin, 'github.com/user/my-project');
    assert.equal(data.daily_summary[0].total_tokens, 25000);
    assert.equal(data.daily_summary[0].billable_tokens, 24500); // 18000+6500+0, excludes cache_read
    // per-model facts sync so cross-device per-model views work
    assert.ok(data.model_facts.length >= 1);
    assert.equal(data.model_facts[0].model, 'claude-sonnet-4-6');
    assert.ok('input' in data.model_facts[0] && 'output' in data.model_facts[0]);
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].project, 'my-project');
    // Prompt text must NOT be in sessions
    assert.equal(data.sessions[0].text, undefined);
    // project_path must NOT be in sessions
    assert.equal(data.sessions[0].project_path, undefined);
    // repo_origin must NOT be undefined (may be null for pre-migration data)
    assert.equal('repo_origin' in data.sessions[0], true);
    assert.equal(data.tool_usage.length, 2);
    // active_min synced so cross-device time aggregation works
    assert.equal(data.sessions[0].active_min, 42);
    // skill_usage synced so cross-device skill rankings work
    assert.equal(data.skill_usage.length, 1);
    assert.equal(data.skill_usage[0].skill_name, 'code-review');
    assert.equal(data.skill_usage[0].count, 2);
    assert.equal(data.skill_usage[0].project, 'my-project');
  });

  it('mergeSkillFacts aggregates per (skill, project) across devices', async () => {
    const { mergeSkillFacts } = await import('../scripts/sync.mjs');
    const merged = mergeSkillFacts([
      { data: { skill_usage: [
        { skill_name: 'code-review', project: 'p1', count: 2 },
        { skill_name: 'rem', project: 'p1', count: 1 },
      ] } },
      { data: { skill_usage: [
        { skill_name: 'code-review', project: 'p1', count: 3 },
        { skill_name: 'code-review', project: 'p2', count: 1 },
      ] } },
      { data: {} }, // older snapshot predating skill_usage — ignored
    ]);
    const cr1 = merged.find(r => r.skill_name === 'code-review' && r.project === 'p1');
    const cr2 = merged.find(r => r.skill_name === 'code-review' && r.project === 'p2');
    const rem = merged.find(r => r.skill_name === 'rem');
    assert.equal(cr1.count, 5);   // 2 + 3 across devices
    assert.equal(cr2.count, 1);   // distinct project kept separate
    assert.equal(rem.count, 1);
  });

  it('mergeSkillFacts key is collision-proof across (skill, project) boundaries', async () => {
    const { mergeSkillFacts } = await import('../scripts/sync.mjs');
    // A naive `${skill} ${project}` key would collide these two distinct pairs.
    const merged = mergeSkillFacts([
      { data: { skill_usage: [{ skill_name: 'code', project: 'review x', count: 1 }] } },
      { data: { skill_usage: [{ skill_name: 'code review', project: 'x', count: 1 }] } },
    ]);
    assert.equal(merged.length, 2); // kept separate, not collapsed into one
  });

  it('mergeSkillFacts keeps same-basename repos distinct via repo_origin', async () => {
    const { mergeSkillFacts } = await import('../scripts/sync.mjs');
    const merged = mergeSkillFacts([
      { data: { skill_usage: [{ skill_name: 'code-review', project: 'my-app', repo_origin: 'github.com/alice/my-app', count: 5 }] } },
      { data: { skill_usage: [{ skill_name: 'code-review', project: 'my-app', repo_origin: 'github.com/bob/my-app', count: 3 }] } },
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged.find(r => r.repo_origin === 'github.com/alice/my-app').count, 5);
    assert.equal(merged.find(r => r.repo_origin === 'github.com/bob/my-app').count, 3);
  });

  it('mergeModelFacts aggregates per-model billable tokens across devices', async () => {
    const { mergeModelFacts } = await import('../scripts/sync.mjs');
    const merged = mergeModelFacts([
      { data: { model_facts: [
        { model: 'opus', requests: 2, input: 100, output: 50, cache_creation: 10, cache_read: 999, cost: 1 },
      ] } },
      { data: { model_facts: [
        { model: 'opus', requests: 3, input: 200, output: 0, cache_creation: 0, cache_read: 0, cost: 2 },
      ] } },
      { data: {} }, // older snapshot predating model_facts — ignored
    ]);
    const opus = merged.find(r => r.model === 'opus');
    assert.equal(opus.calls, 5);            // 2 + 3 requests
    assert.equal(opus.tokens, 360);         // (100+50+10) + (200+0+0); cache_read excluded
    assert.equal(opus.cost, 3);             // 1 + 2
  });

  it('should import data from another device without corrupting local', async () => {
    const { importDailyData } = await import('../scripts/sync.mjs');
    const foreignData = {
      version: 1,
      date: '2026-06-09',
      device: 'linxu-mac',
      generated_at: '2026-06-09T23:00:00Z',
      daily_summary: [
        { project: 'my-project', repo_origin: 'github.com/user/my-project', session_count: 2, prompt_count: 8, total_tokens: 30000, total_cost: 0.12, top_model: 'claude-opus-4' },
        { project: 'other-project', repo_origin: 'github.com/other/other-project', session_count: 1, prompt_count: 3, total_tokens: 10000, total_cost: 0.04, top_model: 'claude-sonnet-4' },
      ],
      sessions: [
        { id: 'sess-m1', project: 'my-project', repo_origin: 'github.com/user/my-project', branch: 'feat/x', started_at: '2026-06-09T14:00:00Z', ended_at: '2026-06-09T15:00:00Z', prompt_count: 4, total_tokens: 15000, total_cost: 0.06 },
        { id: 'sess-m2', project: 'other-project', repo_origin: 'github.com/other/other-project', branch: 'main', started_at: '2026-06-09T16:00:00Z', ended_at: '2026-06-09T17:00:00Z', prompt_count: 3, total_tokens: 10000, total_cost: 0.04 },
      ],
      tool_usage: [{ tool_name: 'Edit', count: 3 }, { tool_name: 'Grep', count: 2 }],
      skill_usage: [{ skill_name: 'code-review', count: 1 }],
    };

    const before = JSON.stringify(queryDailySummary('2026-06-09'));
    const sessBefore = openDb().prepare("SELECT count(*) c FROM sessions WHERE date(started_at)='2026-06-09'").get().c;

    importDailyData(foreignData);

    const db = openDb();
    // Foreign data must NOT be written into local SQLite — local holds this
    // device only; cross-device numbers are merged in memory from .enc files.
    assert.equal(JSON.stringify(queryDailySummary('2026-06-09')), before);

    const allSessions = db.prepare("SELECT count(*) c FROM sessions WHERE date(started_at)='2026-06-09'").get().c;
    assert.equal(allSessions, sessBefore);

    // Original local session intact
    const localSess = db.prepare('SELECT * FROM sessions WHERE id=?').get('sess-s1');
    assert.equal(localSess.total_tokens, 25000);
  });

  it('should be idempotent — repeated import never mutates local totals', async () => {
    const { importDailyData } = await import('../scripts/sync.mjs');
    const sameData = {
      version: 1, date: '2026-06-09', device: 'linxu-mac',
      daily_summary: [{ project: 'other-project', repo_origin: 'github.com/other/other-project', session_count: 1, prompt_count: 3, total_tokens: 10000, total_cost: 0.04, top_model: 'claude-sonnet-4' }],
      sessions: [{ id: 'sess-m1', project: 'my-project', repo_origin: 'github.com/user/my-project', branch: 'feat/x', started_at: '2026-06-09T14:00:00Z', prompt_count: 4, total_tokens: 15000, total_cost: 0.06 }],
      tool_usage: [],
      skill_usage: [],
    };
    const before = JSON.stringify(queryDailySummary('2026-06-09'));
    importDailyData(sameData);
    importDailyData(sameData);
    importDailyData(sameData);
    // Three pulls of the same snapshot — local totals are unchanged.
    assert.equal(JSON.stringify(queryDailySummary('2026-06-09')), before);
  });

  it('should return empty dump for date with no data', async () => {
    const { dumpDailyData } = await import('../scripts/sync.mjs');
    const data = dumpDailyData('2025-01-01');
    assert.equal(data.daily_summary.length, 0);
    assert.equal(data.sessions.length, 0);
  });

  describe('readMergedSnapshot / verifyConsistency without sync configured', () => {
    before(() => {
      // Unset remote so getRemote() returns null, making isSyncSetup() false
      process.env.TRACEME_SYNC_REMOTE = '';
    });

    after(() => {
      delete process.env.TRACEME_SYNC_REMOTE;
    });

    it('readMergedSnapshot returns null when sync is not set up', async () => {
      const { readMergedSnapshot } = await import('../scripts/sync.mjs');
      assert.equal(readMergedSnapshot('2026-06-09'), null);
    });

    it('verifyConsistency reports null merged data when sync is not set up', async () => {
      const { verifyConsistency } = await import('../scripts/sync.mjs');
      const result = verifyConsistency('2026-06-09');
      assert.equal(result.merged, null);
      assert.equal(result.consistent, null);
      assert.ok(result.local.tokens >= 0);
    });

    it('readDeviceFacts returns empty when sync is not set up', async () => {
      const { readDeviceFacts } = await import('../scripts/sync.mjs');
      const r = readDeviceFacts('2026-06-01', '2026-06-09');
      assert.deepEqual(r, { facts: [], modelFacts: [], devices: [] });
    });
  });
});
