import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  openDb, closeDb,
  replaceSession,
  upsertFabricTokens,
  queryDailySummary, queryToolUsage, queryModelBreakdown,
  querySkillUsage, querySessionStats, queryDbStats, deleteSession, allSessionIds,
  queryCategoryBreakdown, queryModelFacts, querySessionFacts,
} from '../scripts/db.mjs';
import { categorizeTool } from '../scripts/lib.mjs';
import { calcCost } from '../scripts/pricing.mjs';

const TEST_DB = join(tmpdir(), `traceme-test-${randomUUID()}.db`);

function sampleSession(id, over = {}) {
  return {
    id,
    date: '2026-06-09',
    project: 'test-project',
    project_path: '/home/user/test-project',
    repo_origin: 'github.com/user/test-project',
    branch: 'main',
    started_at: '2026-06-09T10:00:00Z',
    ended_at: '2026-06-09T11:00:00Z',
    prompt_count: 2,
    input_tokens: 1300, output_tokens: 600, cache_read_tokens: 300, cache_creation_tokens: 50,
    total_tokens: 2250, total_cost: 0.13, top_model: 'claude-sonnet-4-6',
    models: [
      { model: 'claude-sonnet-4-6', requests: 1, input: 500, output: 200, cache_read: 100, cache_creation: 0, cost: 0.05 },
      { model: 'claude-opus-4-8', requests: 1, input: 800, output: 400, cache_read: 200, cache_creation: 50, cost: 0.08 },
    ],
    tools: [{ tool_name: 'Edit', count: 2 }, { tool_name: 'Bash', count: 1 }],
    skills: [{ skill_name: 'rem:rem', count: 1 }],
    categories: [
      { category: 'subagent', calls: 1, tokens: 1200, bytes_est: 0 },
      { category: 'mcp', calls: 2, tokens: 0, bytes_est: 300 },
      { category: 'plugin', calls: 1, tokens: 0, bytes_est: 10 },
    ],
    ...over,
  };
}

describe('DB Layer', { concurrency: 1 }, () => {
  before(() => openDb({ path: TEST_DB }));
  after(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) { try { unlinkSync(TEST_DB + ext); } catch {} }
  });

  it('replaceSession inserts a session with models/tools/skills', () => {
    replaceSession(sampleSession('sess-001'));
    const stats = queryDbStats();
    assert.equal(stats.sessions, 1);
    assert.equal(stats.prompts, 2);
    assert.equal(stats.tool_calls, 3);
  });

  it('replaceSession is idempotent (replaces, never duplicates)', () => {
    replaceSession(sampleSession('sess-001'));
    replaceSession(sampleSession('sess-001'));
    assert.equal(queryDbStats().sessions, 1);
    assert.equal(queryDbStats().tool_calls, 3);
  });

  it('queryDailySummary aggregates per repo_origin', () => {
    const rows = queryDailySummary('2026-06-09');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, 'test-project');
    assert.equal(rows[0].total_tokens, 2250);
    assert.equal(rows[0].top_model, 'claude-sonnet-4-6');
  });

  it('queryToolUsage / queryModelBreakdown / querySkillUsage', () => {
    assert.equal(queryToolUsage('2026-06-09').length, 2);
    const mb = queryModelBreakdown('2026-06-09');
    assert.equal(mb.length, 2);
    // cost is recomputed query-time from current pricing, NOT the stored fixture cost (0.05/0.08)
    const sonnet = mb.find(m => m.model === 'claude-sonnet-4-6');
    assert.equal(sonnet.cost, calcCost({ input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }, 'claude-sonnet-4-6'));
    assert.notEqual(sonnet.cost, 0.05);
    assert.equal(querySkillUsage('2026-06-09', '2026-06-09')[0].skill_name, 'rem:rem');
  });

  it('querySessionStats groups by repo', () => {
    const rows = querySessionStats('2026-06-09');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, 'test-project');
    assert.equal(rows[0].tokens, 1950); // billable = input(1300)+output(600)+cache_creation(50), excludes cache_read
    assert.equal(rows[0].cache_read, 300);
  });

  it('queryCategoryBreakdown keeps subagent tokens apart from byte-proxy', () => {
    const cats = queryCategoryBreakdown('2026-06-09', '2026-06-09');
    const byCat = Object.fromEntries(cats.map(c => [c.category, c]));
    assert.equal(byCat.subagent.tokens, 1200);
    assert.equal(byCat.subagent.bytes_est, 0);
    assert.equal(byCat.mcp.calls, 2);
    assert.equal(byCat.mcp.tokens, 0, 'proxy categories carry no real tokens');
    assert.equal(byCat.mcp.bytes_est, 300, 'proxy lives in bytes_est, never summed with tokens');
  });

  it('queryModelFacts / querySessionFacts', () => {

    // flat fact table: per date×project×model with separate token components
    const mf = queryModelFacts('2026-06-09', '2026-06-09');
    assert.equal(mf.length, 2);
    assert.ok(mf.every(r => r.date === '2026-06-09' && r.project));
    assert.ok(mf.every(r => 'input' in r && 'cache_read' in r && 'cache_creation' in r));
    assert.equal(mf.reduce((s, r) => s + r.tokens, 0), 2250);

    const sf = querySessionFacts('2026-06-09', '2026-06-09');
    assert.equal(sf.length, 1);
    assert.equal(sf[0].project, 'test-project');
    assert.ok('started_at' in sf[0]);
  });

  it('categorizeTool buckets by tool name', () => {
    assert.equal(categorizeTool('mcp__x__y'), 'mcp');
    assert.equal(categorizeTool('Task'), 'subagent');
    assert.equal(categorizeTool('Agent'), 'subagent');
    assert.equal(categorizeTool('Skill', 'rem:rem'), 'plugin');
    assert.equal(categorizeTool('Skill', 'verify'), 'builtin');
    assert.equal(categorizeTool('Edit'), 'builtin');
  });

  it('upsertFabricTokens folds into daily summary total', () => {
    upsertFabricTokens('2026-06-09', 'test-project', 1000, 'github.com/user/test-project');
    const rows = queryDailySummary('2026-06-09');
    assert.equal(rows[0].total_tokens, 3250);
  });

  it('deleteSession / allSessionIds', () => {
    replaceSession(sampleSession('sess-002', { repo_origin: 'github.com/user/other' }));
    assert.equal(allSessionIds().length, 2);
    deleteSession('sess-002');
    assert.deepEqual(allSessionIds(), ['sess-001']);
  });
});

describe('Pre-0.3 schema self-heal', { concurrency: 1 }, () => {
  const OLD_DB = join(tmpdir(), `traceme-old-${randomUUID()}.db`);
  after(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) { try { unlinkSync(OLD_DB + ext); } catch {} }
  });

  it('openDb backfills missing sessions columns so replaceSession works', () => {
    // Simulate a legacy on-disk DB whose `sessions` table predates date/token-breakdown
    // columns — the schema that produced "no such column: date".
    const seed = new DatabaseSync(OLD_DB);
    seed.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project TEXT, project_path TEXT, branch TEXT,
      started_at TEXT, ended_at TEXT, prompt_count INTEGER,
      total_tokens INTEGER, total_cost REAL, repo_origin TEXT)`);
    seed.prepare('INSERT INTO sessions (id, project, started_at) VALUES (?,?,?)')
      .run('legacy-1', 'old-proj', '2026-01-01T00:00:00Z');
    seed.close();

    openDb({ path: OLD_DB });
    // Should no longer throw "no such column: date".
    replaceSession(sampleSession('sess-new'));
    assert.deepEqual(allSessionIds().sort(), ['legacy-1', 'sess-new']);
  });
});
