// Tests for scripts/gen-codex.mjs — Claude → Codex artifact transpilation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInterface,
  transpileManifest,
  transpileMarketEntry,
  transpileMarketplace,
  generate,
} from '../scripts/gen-codex.mjs';

// Codex validator's accepted manifest keys + required interface fields (CODEX-SUPPORT.md §7.4).
const CODEX_ALLOWED = new Set(['id', 'name', 'version', 'description', 'skills', 'apps', 'mcpServers', 'interface', 'author', 'homepage', 'repository', 'license', 'keywords']);
const REQUIRED_INTERFACE = ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities', 'defaultPrompt'];

test('buildInterface synthesizes all required fields', () => {
  const iface = buildInterface({ name: 'takeover', description: 'Hand off tasks.', author: { name: 'Mingyang Bao' } }, { displayName: 'Takeover', category: 'productivity' });
  for (const f of REQUIRED_INTERFACE) assert.ok(iface[f] !== undefined && iface[f] !== '', `missing ${f}`);
  assert.equal(iface.displayName, 'Takeover');
  assert.equal(iface.developerName, 'Mingyang Bao');
  assert.equal(iface.category, 'Productivity'); // title-cased
  assert.ok(Array.isArray(iface.capabilities));
  assert.ok(Array.isArray(iface.defaultPrompt) && iface.defaultPrompt.length <= 3);
});

test('buildInterface clamps shortDescription and defaultPrompt lengths', () => {
  const longDesc = 'x'.repeat(200);
  const iface = buildInterface({ name: 'p', description: longDesc, codexInterface: { defaultPrompt: ['y'.repeat(200), 'a', 'b', 'c'] } }, {});
  assert.ok(iface.shortDescription.length <= 80);
  assert.ok(iface.defaultPrompt.length <= 3);
  assert.ok(iface.defaultPrompt[0].length <= 128);
});

test('buildInterface honors codexInterface override', () => {
  const iface = buildInterface({ name: 'p', description: 'd', codexInterface: { displayName: 'Override', capabilities: ['Interactive', 'Write'] } }, { displayName: 'FromMarket' });
  assert.equal(iface.displayName, 'Override');
  assert.deepEqual(iface.capabilities, ['Interactive', 'Write']);
});

test('transpileManifest drops Claude-only keys and keeps only accepted ones', () => {
  const src = {
    name: 'takeover', version: '2.3.18', description: 'd', author: { name: 'x' },
    commands: ['./commands/continue.md'], // Claude-only — must drop
    hooks: './hooks/hooks.json', // rejected by Codex validator — must drop
    keywords: ['a'], repository: 'https://github.com/DawnEver/cc-market', license: 'MIT',
  };
  const out = transpileManifest(src, { marketEntry: { displayName: 'Takeover' } });
  assert.ok(!('commands' in out), 'commands must be dropped');
  assert.ok(!('hooks' in out), 'hooks must be dropped');
  for (const k of Object.keys(out)) assert.ok(CODEX_ALLOWED.has(k), `unexpected key ${k}`);
  assert.equal(out.version, '2.3.18');
  assert.ok(out.interface);
});

test('transpileManifest wires mcpServers/skills only when present on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gc-'));
  writeFileSync(join(dir, '.mcp.json'), '{}');
  mkdirSync(join(dir, 'skills'));
  const out = transpileManifest({ name: 'p', version: '1.0.0', description: 'd', author: { name: 'x' } }, { pluginDir: dir });
  assert.equal(out.mcpServers, './.mcp.json');
  assert.equal(out.skills, './skills/');

  const dir2 = mkdtempSync(join(tmpdir(), 'gc-'));
  const out2 = transpileManifest({ name: 'p', version: '1.0.0', description: 'd', author: { name: 'x' } }, { pluginDir: dir2 });
  assert.ok(!('mcpServers' in out2));
  assert.ok(!('skills' in out2));
});

test('transpileMarketEntry produces local source + policy + category', () => {
  const e = transpileMarketEntry({ name: 'takeover', category: 'productivity' });
  assert.deepEqual(e.source, { source: 'local', path: './takeover' });
  assert.equal(e.policy.installation, 'AVAILABLE');
  assert.equal(e.policy.authentication, 'ON_USE');
  assert.equal(e.category, 'Productivity');
});

test('transpileMarketplace maps all plugins and seeds interface.displayName', () => {
  const m = transpileMarketplace({ name: 'cc-market', plugins: [{ name: 'a', category: 'productivity' }, { name: 'b' }] });
  assert.equal(m.plugins.length, 2);
  assert.ok(m.interface.displayName);
  assert.equal(m.plugins[0].source.path, './a');
});

test('generate writes manifests + marketplace and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'gcrepo-'));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'cc-market', plugins: [{ name: 'takeover', displayName: 'Takeover', description: 'd', category: 'productivity' }],
  }));
  mkdirSync(join(root, 'takeover', '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'takeover', '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'takeover', version: '2.3.18', description: 'd', author: { name: 'x' }, commands: ['./c.md'],
  }));
  writeFileSync(join(root, 'takeover', '.mcp.json'), '{}');

  const r1 = generate(root);
  const codexManifest = JSON.parse(readFileSync(join(root, 'takeover', '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.ok(!('commands' in codexManifest));
  assert.equal(codexManifest.mcpServers, './.mcp.json');
  assert.ok(existsSync(join(root, '.agents', 'plugins', 'marketplace.json')));

  const before = readFileSync(join(root, 'takeover', '.codex-plugin', 'plugin.json'), 'utf8');
  generate(root); // re-run
  const after = readFileSync(join(root, 'takeover', '.codex-plugin', 'plugin.json'), 'utf8');
  assert.equal(before, after, 'generate must be idempotent');
  assert.ok(r1.written.length >= 2);
});

test('generated manifest satisfies Codex required fields', () => {
  const out = transpileManifest({ name: 'p', version: '1.0.0', description: 'desc', author: { name: 'Dev' } }, { marketEntry: { displayName: 'P', category: 'productivity' } });
  assert.ok(out.name && out.version && out.description && out.author?.name);
  for (const f of REQUIRED_INTERFACE) assert.ok(out.interface[f] !== undefined, `interface.${f} required`);
});
