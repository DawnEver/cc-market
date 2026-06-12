import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardHtml } from '../scripts/commands/dashboard.mjs';

function sampleData() {
  return {
    meta: {
      from: '2026-03-13', to: '2026-06-11', version: 'v1.2.3',
      generatedAt: '2026-06-11 12:00',
      projects: ['my-app', 'other'], models: ['claude-opus-4-8', 'claude-sonnet-4-6'],
      devices: ['me@laptop', 'me@desktop'], localDevice: 'me@laptop',
    },
    modelFacts: [
      { date: '2026-06-08', project: 'my-app', model: 'claude-sonnet-4-6', requests: 10,
        input: 1000, output: 2000, cache_read: 40000, cache_creation: 500, tokens: 43500, cost: 0.2 },
      { date: '2026-06-09', project: 'my-app', model: 'claude-opus-4-8', requests: 5,
        input: 800, output: 1500, cache_read: 70000, cache_creation: 300, tokens: 72600, cost: 0.25 },
    ],
    categoryFacts: [
      { date: '2026-06-08', project: 'my-app', category: 'subagent', calls: 3, tokens: 40000, bytes_est: 0 },
      { date: '2026-06-08', project: 'my-app', category: 'mcp', calls: 5, tokens: 0, bytes_est: 12000 },
      { date: '2026-06-09', project: 'my-app', category: 'plugin', calls: 2, tokens: 0, bytes_est: 3000 },
    ],
    skillFacts: [
      { date: '2026-06-08', project: 'my-app', skill_name: 'rem:rem', count: 4 },
      { date: '2026-06-09', project: 'my-app', skill_name: 'verify', count: 1 },
    ],
    sessionFacts: [
      { date: '2026-06-08', project: 'my-app', started_at: '2026-06-08T10:00:00Z',
        ended_at: '2026-06-08T12:30:00Z', prompt_count: 20, total_tokens: 43500, total_cost: 0.2 },
    ],
    deviceFacts: [
      { date: '2026-06-09', device: 'me@desktop', project: 'other', sessions: 3,
        prompts: 12, tokens: 90000, cost: 0.3, top_model: 'claude-opus-4-8' },
    ],
  };
}

describe('Dashboard HTML builder', () => {
  const html = buildDashboardHtml(sampleData());

  it('produces a single self-contained document', () => {
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('</html>'));
  });

  it('loads ECharts from a CDN', () => {
    assert.match(html, /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@5[^"]*"><\/script>/);
  });

  it('embeds the flat fact-table payload', () => {
    assert.ok(html.includes('window.__TRACEME__'));
    const payload = html.slice(html.indexOf('window.__TRACEME__'));
    assert.ok(payload.includes('modelFacts'));
    assert.ok(payload.includes('categoryFacts'));
    assert.ok(payload.includes('skillFacts'));
    assert.ok(payload.includes('sessionFacts'));
    // separate token components must survive so the client can pick a billable vs cache_read basis
    assert.ok(payload.includes('cache_creation') && payload.includes('cache_read'));
  });

  it('renders interactive controls (date range, projects, devices, group-by)', () => {
    assert.ok(html.includes('id="from"') && html.includes('id="to"'));
    assert.ok(html.includes('id="projmenu"'));
    assert.ok(html.includes('id="devmenu"'));
    assert.ok(html.includes('id="groupby"'));
    // group-by exposes a Device dimension
    assert.ok(/data-v="device"/.test(html));
  });

  it('carries cross-device data and local-device markers', () => {
    const payload = html.slice(html.indexOf('window.__TRACEME__'));
    assert.ok(payload.includes('deviceFacts'));
    assert.ok(payload.includes('me@desktop') && payload.includes('me@laptop'));
    assert.ok(payload.includes('localDevice'));
    // per-model/skill/category panels are flagged local-device only
    assert.ok(html.includes('local-note-model'));
    assert.ok(html.includes("local device only"));
  });

  it('renders the signature chart sections', () => {
    assert.ok(html.includes('Activity Calendar'));
    assert.ok(html.includes('Tokens per Day'));
    assert.ok(html.includes('Breakdown'));
  });

  it('encodes the data-honesty fixes (billable basis, byte-proxy split, Elapsed)', () => {
    // calendar/trend default to billable, excluding re-read cache
    assert.ok(/billable\s*=\s*input\+output\+cache_creation/.test(html));
    // tool-category section keeps subagent (actual) apart from byte-proxy categories
    assert.ok(html.includes('≈ result bytes') || html.includes('≈ bytes'));
    assert.ok(html.includes('actual tokens'));
    // session time is labeled Elapsed, not "Session time"
    assert.ok(html.includes('Elapsed'));
    assert.ok(!/Session time/.test(html));
  });

  it('escapes embedded JSON so it cannot break out of the script tag', () => {
    const hostile = sampleData();
    hostile.modelFacts = [{ date: '2026-06-09', project: '</script><x>', model: 'm',
      requests: 1, input: 1, output: 1, cache_read: 0, cache_creation: 0, tokens: 2, cost: 0 }];
    const out = buildDashboardHtml(hostile);
    const payload = out.slice(out.indexOf('window.__TRACEME__'));
    assert.ok(!payload.includes('</script><x>'), 'raw </script> must not survive in the JSON payload');
    assert.ok(payload.includes('\\u003c/script'), 'angle brackets are unicode-escaped');
  });
});
