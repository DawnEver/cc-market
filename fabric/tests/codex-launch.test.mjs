// Controlled Windows executables/shims only: no installed Codex, model or account calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { prepareCodexLaunch } from '../engine/codex/launch.mjs';
import { CodexAppServerClient } from '../engine/codex/app-server.mjs';
import { checkCodexStatus, checkCodexStatusAsync, findCodexBinary, findCodexBinaryAsync } from '../engine/codex/discovery.mjs';

const sentinel = 'FABRIC_CODEX_INJECTION';

test('unresolved Windows batch-looking names never become shell command source', { skip: process.platform !== 'win32' }, () => {
  const launch = prepareCodexLaunch(`missing" & echo ${sentinel} & rem.cmd`, ['--version']);
  const result = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8', windowsHide: true });
  assert.doesNotMatch(result.stdout || '', new RegExp(sentinel));
  assert.notEqual(result.status, 0);
});

test('native and non-Windows launches preserve argv without a shell', () => {
  const args = ['spaces & %VARIABLE% are argv data'];
  const result = prepareCodexLaunch(process.execPath, args, { env: {}, platform: 'linux' });
  assert.equal(result.command, process.execPath);
  assert.deepEqual(result.args, args);
  assert.equal(result.options.shell, false);
});

test('batch preparation isolates its path in child env and rejects non-bootstrap arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-batch-prepare-'));
  try {
    const shim = path.join(root, 'literal%VARIABLE%&shim.cmd');
    fs.writeFileSync(shim, '@exit /b 0\r\n');
    const env = { PATH: '', ComSpec: 'cmd.exe' };
    const launch = prepareCodexLaunch(shim, ['doctor', '--json'], { env, platform: 'win32' });
    assert.equal(launch.options.shell, false);
    assert.ok(launch.args.includes('/v:off'));
    assert.equal(Object.values(launch.options.env).filter(value => value === shim).length, 1);
    assert.ok(!launch.args.join(' ').includes(shim));
    assert.deepEqual(env, { PATH: '', ComSpec: 'cmd.exe' });
    assert.throws(() => prepareCodexLaunch(shim, ['--flag&echo unexpected'], { env, platform: 'win32' }), /Unsafe Codex batch/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('Windows PATH resolution prefers an executable shim over its extensionless shell companion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-path-shim-'));
  try {
    fs.writeFileSync(path.join(root, 'codex'), '#!/bin/sh\nexit 99\n');
    const shim = path.join(root, 'codex.cmd');
    fs.writeFileSync(shim, '@exit /b 0\r\n');
    const launch = prepareCodexLaunch('codex', ['--version'], { env: { PATH: root, PATHEXT: '.exe;.cmd' }, platform: 'win32' });
    assert.ok(Object.values(launch.options.env).includes(shim));
    assert.equal(launch.options.windowsVerbatimArguments, true);
  } finally { fs.rmSync(root, { recursive: true }); }
});
const fixtureScript = `
const method=process.argv[2];
if(method==='--version') console.log('fixture-codex');
else if(method==='doctor') console.log(JSON.stringify({checks:{'auth.credentials':{status:'ok'}}}));
else {
  require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const q=JSON.parse(line);
    if(q.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{fixture:true}})+'\\n',()=>{
      if(q.method==='shutdown') process.exit(0);
    });
  });
  process.stdin.on('end',()=>process.exit(0));
}`;

test('Windows native paths and batch shims remain literal across startup and both discovery paths',
  { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const base = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(base, 'fabric-codex-launch-'));
    const originalCwd = process.cwd();
    const originalExpand = process.env.FABRIC_CODEX_EXPAND_TEST;
    const originalPath = process.env.PATH;
    const originalOverride = process.env.TAKEOVER_CODEX_BINARY;
    const children = [];
    try {
      process.chdir(root);
      process.env.FABRIC_CODEX_EXPAND_TEST = 'wrong-expanded-location';
      const nodeCopy = path.join(root, 'control-node.exe');
      fs.copyFileSync(process.execPath, nodeCopy);
      fs.writeFileSync(path.join(root, 'app-server'), fixtureScript);
      fs.writeFileSync(path.join(root, 'doctor'), "console.log(JSON.stringify({checks:{'auth.credentials':{status:'ok'}}}));");
      for (const kind of ['exe', 'cmd']) for (const directory of ['plain', 'with space', `with&echo ${sentinel}&rem`, 'with%FABRIC_CODEX_EXPAND_TEST%', 'with!FABRIC_CODEX_EXPAND_TEST!^(literal)']) {
        await t.test(`${kind}: ${directory}`, async () => {
          const dir = path.join(root, kind, directory);
          fs.mkdirSync(dir, { recursive: true });
          const binary = path.join(dir, `codex.${kind}`);
          fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\nexit 99\n');
          if (kind === 'exe') fs.linkSync(nodeCopy, binary);
          else {
            fs.writeFileSync(path.join(dir, 'cli.cjs'), fixtureScript);
            fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "%~dp0cli.cjs" %*\r\n`);
          }
          for (const status of [checkCodexStatus(binary), await checkCodexStatusAsync(binary)]) {
            assert.equal(status.installed, true, JSON.stringify(status));
            assert.equal(status.version, kind === 'exe' ? process.version : 'fixture-codex');
            assert.equal(status.authenticated, true, JSON.stringify(status));
          }
          const client = new CodexAppServerClient({ codexPath: binary, timeout: 3000, _killTree: () => {} });
          let output = '';
          try {
            const starting = client.start();
            children.push(client.child);
            client.child.stdin.on('error', () => {});
            client.child.stdout.on('data', chunk => { output += chunk; });
            assert.deepEqual(await starting, { fixture: true });
            assert.doesNotMatch(output, new RegExp(sentinel));
          } finally {
            await client.stop();
            if (client.child.exitCode === null) await once(client.child, 'close');
          }
          // Exercise bare-name discovery through a PATH entry containing the same characters.
          process.env.PATH = `${dir};${originalPath}`;
          delete process.env.TAKEOVER_CODEX_BINARY;
          assert.equal(findCodexBinary().toLowerCase(), binary.toLowerCase());
          assert.equal((await findCodexBinaryAsync()).toLowerCase(), binary.toLowerCase());
          process.env.PATH = originalPath;
        });
      }
    } finally {
      process.chdir(originalCwd);
      for (const [key, value] of Object.entries({ FABRIC_CODEX_EXPAND_TEST: originalExpand, PATH: originalPath, TAKEOVER_CODEX_BINARY: originalOverride })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      const relative = path.relative(base, fs.realpathSync(root));
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
      assert.ok(path.basename(root).startsWith('fabric-codex-launch-'));
      assert.ok(children.every(child => child.exitCode !== null), 'do not remove live child files');
      fs.rmSync(root, { recursive: true });
    }
  });
