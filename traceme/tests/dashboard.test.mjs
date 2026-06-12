import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardHtml } from '../scripts/commands/dashboard.mjs';

function sampleData() {
  return {
    from: '2026-06-03', to: '2026-06-09', numDays: 7, project: null,
    generatedAt: '2026-06-09 12:00', version: 'v1.2.3',
    days: ['2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09'],
    quick: { tokens: 125000, cost: 0.45, sessions: 5, prompts: 42, totalMin: 150 },
    dailyTokens: [
      { date: '2026-06-08', tokens: 50000, cost: 0.2 },
      { date: '2026-06-09', tokens: 75000, cost: 0.25 },
    ],
    modelByDay: [
      { date: '2026-06-08', model: 'claude-sonnet-4-6', tokens: 50000 },
      { date: '2026-06-09', model: 'claude-opus-4-8', tokens: 75000 },
    ],
    categories: [
      { category: 'subagent', calls: 3, tokens: 40000 },
      { category: 'mcp', calls: 5, tokens: 12000 },
      { category: 'plugin', calls: 2, tokens: 3000 },
    ],
    models: [{ model: 'claude-opus-4-8', calls: 10, tokens: 75000, cost: 0.3 }],
    skills: [{ name: 'rem:rem', total: 4 }, { name: 'verify', total: 1 }],
    projects: [{ project: 'my-app', sessions: 5, tokens: 125000, cost: 0.45, totalMin: 150 }],
  };
}

describe('Dashboard HTML builder', () => {
  const html = buildDashboardHtml(sampleData());

  it('produces a single self-contained document', () => {
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('</html>'));
  });

  it('has no external network references', () => {
    assert.ok(!/<script\s+src=/i.test(html), 'no external scripts');
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')), 'no external URLs');
  });

  it('renders the three signature chart sections', () => {
    assert.ok(html.includes('Model Usage Calendar'));
    assert.ok(html.includes('Tokens per Day by Model'));
    assert.ok(html.includes('Token Usage by Category'));
    assert.ok(html.includes('<svg'), 'inline SVG charts present');
  });

  it('embeds the data payload and a refresh control', () => {
    assert.ok(html.includes('window.__TRACEME__'));
    assert.ok(html.includes('location.reload()'));
    assert.ok(html.includes('Subagents') && html.includes('MCPs') && html.includes('Plugins'));
  });

  it('escapes embedded JSON so it cannot break out of the script tag', () => {
    const hostile = sampleData();
    hostile.projects = [{ project: '</script><x>', sessions: 1, tokens: 1, cost: 0, totalMin: 1 }];
    const out = buildDashboardHtml(hostile);
    const payload = out.slice(out.indexOf('window.__TRACEME__'));
    assert.ok(!payload.includes('</script><x>'), 'raw </script> must not survive in the JSON payload');
    assert.ok(payload.includes('\\u003c/script'), 'angle brackets are unicode-escaped');
  });
});
