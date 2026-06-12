import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, queryDailySummary, queryToolUsage, queryModelBreakdown, querySkillUsage, queryDbStats } from '../scripts/db.mjs';
import { parseSession, scanAll } from '../scripts/scan.mjs';

const TEST_DB = join(tmpdir(), `traceme-scan-${randomUUID()}.db`);
const PROJECTS = join(tmpdir(), `traceme-projects-${randomUUID()}`);
const ENC_DIR = join(PROJECTS, 'C--test-proj');

function line(obj) { return JSON.stringify(obj); }

function transcript(sessionId, cwd) {
  return [
    line({ type: 'system', subtype: 'init', sessionId }),
    line({ type: 'user', message: { role: 'user', content: 'Write a hello world function' }, isMeta: false, sessionId, cwd, gitBranch: 'main', timestamp: '2026-06-09T10:00:00.000Z' }),
    line({ type: 'assistant', message: { id: 'msg-001', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Edit', input: { file: 'a.js' } }], usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } }, sessionId, cwd, timestamp: '2026-06-09T10:00:05.000Z' }),
    // Duplicate message id (retry) — must be deduped
    line({ type: 'assistant', message: { id: 'msg-001', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } }, sessionId, cwd, timestamp: '2026-06-09T10:00:05.000Z' }),
    line({ type: 'user', message: { role: 'user', content: 'Run the skill' }, isMeta: false, sessionId, cwd, timestamp: '2026-06-09T10:05:00.000Z' }),
    line({ type: 'assistant', message: { id: 'msg-002', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'rem:rem' } }], usage: { input_tokens: 800, output_tokens: 400, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } }, sessionId, cwd, timestamp: '2026-06-09T10:05:10.000Z' }),
  ].join('\n');
}

describe('Transcript Scan', () => {
  before(() => {
    process.env.TRACEME_DB_PATH = TEST_DB;
    process.env.TRACEME_PROJECTS_DIR = PROJECTS;
    mkdirSync(ENC_DIR, { recursive: true });
    openDb();
  });
  after(() => {
    closeDb();
    delete process.env.TRACEME_DB_PATH;
    delete process.env.TRACEME_PROJECTS_DIR;
    try { rmSync(PROJECTS, { recursive: true, force: true }); } catch {}
    for (const ext of ['', '-wal', '-shm']) { try { rmSync(TEST_DB + ext, { force: true }); } catch {} }
  });

  it('parseSession buckets categories: subagent (sidechain true tokens), mcp/plugin (proxy)', () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: 'go' }, cwd: '/x/test-proj', timestamp: '2026-06-09T10:00:00.000Z' },
      // Main-thread turn spawns a subagent, calls an MCP tool and a namespaced Skill.
      { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8',
        content: [
          { type: 'tool_use', id: 'tu_task', name: 'Task', input: {} },
          { type: 'tool_use', id: 'tu_mcp', name: 'mcp__server__do', input: {} },
          { type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'rem:rem' } },
        ], usage: { input_tokens: 100, output_tokens: 50 } }, timestamp: '2026-06-09T10:00:01.000Z' },
      // tool_results carry sizes used for the proxy attribution.
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_mcp', content: 'x'.repeat(400) },
        { type: 'tool_result', tool_use_id: 'tu_skill', content: 'y'.repeat(40) },
      ] }, timestamp: '2026-06-09T10:00:02.000Z' },
      // Sidechain (subagent) assistant turn — true tokens attributed to subagent.
      { type: 'assistant', isSidechain: true, message: { id: 'm2', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'sub' }], usage: { input_tokens: 1000, output_tokens: 200 } }, timestamp: '2026-06-09T10:00:03.000Z' },
    ];
    const p = parseSession(entries);
    const cat = Object.fromEntries(p.categories.map(c => [c.category, c]));
    assert.equal(cat.subagent.calls, 1);
    assert.equal(cat.subagent.tokens, 1200, 'subagent tokens come from sidechain usage, not proxy');
    assert.equal(cat.mcp.calls, 1);
    assert.equal(cat.mcp.tokens, 100, '400 chars / 4 = 100 proxy tokens');
    assert.equal(cat.plugin.calls, 1);
    assert.equal(cat.plugin.tokens, 10);
  });

  it('parseSession aggregates tokens, dedupes by message id, captures tools/skills', () => {
    const entries = transcript('s1', '/x/test-proj').split('\n').map(l => JSON.parse(l));
    const p = parseSession(entries);
    assert.equal(p.promptCount, 2);
    // Two unique assistant messages (msg-001 deduped): input 500+800, output 200+400
    assert.equal(p.input, 1300);
    assert.equal(p.output, 600);
    assert.equal(p.cacheRead, 300);
    assert.equal(p.cacheCreate, 50);
    assert.equal(p.total, 2250);
    assert.ok(p.cost > 0);
    assert.equal(p.branch, 'main');
    assert.deepEqual(p.tools.find(t => t.tool_name === 'Edit'), { tool_name: 'Edit', count: 1 });
    assert.deepEqual(p.skills, [{ skill_name: 'rem:rem', count: 1 }]);
    assert.equal(p.models.length, 2);
  });

  it('scanAll ingests transcripts into derived tables', () => {
    writeFileSync(join(ENC_DIR, 's1.jsonl'), transcript('s1', '/x/test-proj'));
    const stats = scanAll();
    assert.ok(stats.sessions >= 1);

    const summary = queryDailySummary('2026-06-09');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].total_tokens, 2250);
    assert.equal(summary[0].prompt_count, 2);

    const tools = queryToolUsage('2026-06-09');
    assert.ok(tools.find(t => t.tool_name === 'Edit'));
    assert.ok(tools.find(t => t.tool_name === 'Skill'));

    const models = queryModelBreakdown('2026-06-09');
    assert.equal(models.length, 2);

    const skills = querySkillUsage('2026-06-09', '2026-06-09');
    assert.equal(skills.find(s => s.skill_name === 'rem:rem').count, 1);
  });

  it('scanAll skips unchanged files via cursor, and is idempotent', () => {
    const before = queryDbStats();
    const stats = scanAll();
    assert.equal(stats.scanned, 0, 'unchanged file should be skipped');
    const after = queryDbStats();
    assert.deepEqual(after, before);
  });

  it('re-scan after change replaces the session without double-counting', () => {
    const path = join(ENC_DIR, 's1.jsonl');
    // Append nothing meaningful but bump mtime+size so the cursor invalidates
    writeFileSync(path, transcript('s1', '/x/test-proj') + '\n' + line({ type: 'system', subtype: 'noop', sessionId: 's1' }));
    const future = new Date('2027-01-01T00:00:00Z');
    utimesSync(path, future, future);
    scanAll();
    const summary = queryDailySummary('2026-06-09');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].total_tokens, 2250, 'totals must not double on re-scan');
  });
});
