// gen-agy.test.mjs — Antigravity artifacts: mapping units, committed-output drift, and (when the
// `agy` CLI is on PATH) `agy plugin validate` with only the known Claude-layout warnings.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  generate, translateMatcher, translateCommand, transpileHooks, transpileMcp, transpileManifest,
  transpileAgent, commandSkill, GENERATED_MARK,
} from '../scripts/gen-agy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));

describe('gen-agy mapping', () => {
  it('translates Claude tool matchers to agy tool names', () => {
    assert.equal(translateMatcher('Write|Edit|MultiEdit|NotebookEdit'), 'write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content');
    assert.equal(translateMatcher('Bash|PowerShell'), 'run_command');
    assert.equal(translateMatcher('Read|Grep|Glob'), 'read_file|view_file|grep_search|find_by_name');
    assert.equal(translateMatcher('NotebookEdit'), null);
    assert.throws(() => translateMatcher('WebFetch'), /no agy tool mapping/);
  });

  it('relativizes hook commands and tags the host', () => {
    assert.equal(translateCommand('node "${CLAUDE_PLUGIN_ROOT}/hooks/task-guard.js"'), 'node ./hooks/task-guard.js --host agy');
    assert.equal(translateCommand('node ${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt.js'), 'node ./hooks/user-prompt.js --host agy');
  });

  it('maps events: UserPromptSubmit→PreInvocation, PostCompact dropped, flat non-tool events', () => {
    const h = { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/x.js"', timeout: 5 };
    const out = transpileHooks('p', { hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [h] }],
      UserPromptSubmit: [{ hooks: [h] }], PostCompact: [{ hooks: [h] }], Stop: [{ hooks: [h] }],
    } });
    const cmd = { type: 'command', command: 'node ./x.js --host agy', timeout: 5 };
    assert.deepEqual(out, { p: { PreToolUse: [{ matcher: 'run_command', hooks: [cmd] }], PreInvocation: [cmd], Stop: [cmd] } });
    assert.throws(() => transpileHooks('p', { hooks: { Notification: [] } }), /no agy mapping/);
  });

  it('relativizes MCP paths and marks dormant plugins disabled', () => {
    const mcp = transpileMcp({ mcpServers: { s: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/m.mjs', '${CLAUDE_PLUGIN_ROOT}'] } } });
    assert.deepEqual(mcp.mcpServers.s, { command: 'node', args: ['./m.mjs', '.'], cwd: '.' });
    assert.equal(transpileManifest({ name: 'watch', version: '1.0.0' }).disabled, true);
    assert.equal(transpileManifest({ name: 'rem', version: '1.0.0' }).disabled, undefined);
  });

  it('transpiles Claude agent model tiers (haiku→flash, sonnet→inherit, opus→pro) and enforces manifest agents list', () => {
    const sonnetOut = transpileAgent('---\nname: rev\ndescription: r\nmodel: sonnet\n---\n\n# Body\n');
    assert.match(sonnetOut, /\nmodel: inherit\n/);
    assert.ok(sonnetOut.includes(GENERATED_MARK));
    assert.ok(sonnetOut.endsWith('# Body\n'));

    assert.match(transpileAgent('---\nname: a\ndescription: d\nmodel: haiku\n---\nbody\n'), /\nmodel: flash\n/);
    assert.match(transpileAgent('---\nname: a\ndescription: d\nmodel: opus\n---\nbody\n'), /\nmodel: pro\n/);
    assert.throws(() => transpileAgent('---\nname: a\ndescription: d\nmodel: bogus\n---\nbody\n', 'test/a.md'), /no agy tier mapping/);

    // Verify cc-academia keeps model: sonnet in claude-agents/ while generated agents/ uses model: inherit
    const claudePolisher = readFileSync(join(ROOT, 'cc-academia', 'claude-agents', 'polisher.md'), 'utf8');
    const agyPolisher = readFileSync(join(ROOT, 'cc-academia', 'agents', 'polisher.md'), 'utf8');
    assert.match(claudePolisher, /^model:\s*sonnet$/m);
    assert.match(agyPolisher, /^model:\s*inherit$/m);

    // Guard: if claude-agents/ exists without matching .claude-plugin/plugin.json "agents" array, generate() fails closed
    const tmp = mkdtempSync(join(tmpdir(), 'gen-agy-agents-'));
    try {
      mkdirSync(join(tmp, '.claude-plugin'), { recursive: true });
      writeFileSync(join(tmp, '.claude-plugin', 'marketplace.json'), JSON.stringify({
        name: 'm', plugins: [{ name: 'p' }],
      }));
      mkdirSync(join(tmp, 'p', '.claude-plugin'), { recursive: true });
      mkdirSync(join(tmp, 'p', 'claude-agents'), { recursive: true });
      writeFileSync(join(tmp, 'p', 'claude-agents', 'x.md'), '---\nname: x\ndescription: d\nmodel: sonnet\n---\nb\n');
      writeFileSync(join(tmp, 'p', '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: 'p', version: '1.0.0', description: 'd', author: { name: 'a' },
      }));
      assert.throws(() => generate(tmp, { write: false }), /"agents" must list every file in claude-agents/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('wraps a command as a skill keeping its body', () => {
    const s = commandSkill('rem', 'task', ['task'], '---\ndescription: Open a task\ndisable-model-invocation: true\n---\n\nBODY $ARGUMENTS\n');
    assert.match(s, /^---\nname: task\ndescription: "Open a task \(Antigravity port/);
    assert.ok(s.includes(GENERATED_MARK));
    assert.match(s, /User-only/);
    assert.ok(s.trimEnd().endsWith('BODY $ARGUMENTS'));
  });
});

describe('gen-agy committed artifacts', () => {
  const { files, remove } = generate(ROOT, { write: false });
  it('every generated file is committed and current (run: node scripts/gen-agy.mjs)', () => {
    for (const [p, content] of files) {
      assert.ok(existsSync(p), `${p} missing`);
      assert.equal(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), content, `${p} is stale`);
    }
    assert.deepEqual(remove, [], 'stale agy artifacts present');
  });
  it('covers every marketplace plugin', () => {
    for (const { name } of market.plugins) assert.ok(files.has(join(ROOT, name, '.antigravity-plugin', 'plugin.json')), name);
  });
});

// Warnings inherent to the shared Claude-Code layout, accepted on agy: the per-plugin dev
// AGENTS.md, Claude's hooks/hooks.json and .mcp.json (agy reads the generated root files).
const ALLOWED_WARNINGS = [/^AGENTS\.md$/, /^hooks\/hooks\.json$/, /^\.mcp\.json$/];
const agy = spawnSync('agy', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
describe('agy plugin validate', { skip: agy.status !== 0 && 'agy CLI not on PATH' }, () => {
  for (const { name } of market.plugins) {
    it(`${name}: no errors, only Claude-layout warnings`, () => {
      const r = spawnSync('agy', ['plugin', 'validate', join(ROOT, name), '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
      const report = JSON.parse(r.stdout);
      const bad = report.findings.filter(f => f.severity === 'error' ||
        (f.severity === 'warning' && !ALLOWED_WARNINGS.some(re => re.test(String(f.file).replaceAll('\\', '/')))));
      assert.deepEqual(bad, []);
    });
  }
});
