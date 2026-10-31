import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { atomicWriteFile, writeIfChanged } from '../atomic-write.mjs';

const MODULE = pathToFileURL(fileURLToPath(new URL('../atomic-write.mjs', import.meta.url))).href;

describe('atomicWriteFile', () => {
  it('writes the payload, creating the directory, and leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-'));
    const file = join(dir, 'sub', 'x.md');
    atomicWriteFile(file, 'hello');
    assert.equal(readFileSync(file, 'utf8'), 'hello');
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['x.md']);
  });

  // 300 rounds: the former fixed '<file>.tmp' writer fails this within ~1.4 s (measured).
  it('concurrent writers never tear the file and never collide on a temp name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-'));
    const file = join(dir, 'x.txt');
    const chars = ['A', 'B', 'C', 'D'];
    const script = `import { atomicWriteFile } from ${JSON.stringify(MODULE)};
      const body = process.argv[2].repeat(200000);
      for (let i = 0; i < 300; i++) atomicWriteFile(process.argv[1], body);`;
    const codes = await Promise.all(chars.map(c => new Promise(done => {
      spawn(process.execPath, ['--input-type=module', '-e', script, file, c], { stdio: 'ignore' }).on('exit', done);
    })));
    assert.deepEqual(codes, [0, 0, 0, 0]);
    assert.ok(chars.map(c => c.repeat(200000)).includes(readFileSync(file, 'utf8')));
    assert.deepEqual(readdirSync(dir), ['x.txt']);
  });
});

describe('writeIfChanged', () => {
  it('skips identical bytes and writes different ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-'));
    const file = join(dir, 'i.md');
    assert.equal(writeIfChanged(file, 'a'), true);
    const before = statSync(file).mtimeMs;
    assert.equal(writeIfChanged(file, 'a'), false);
    assert.equal(statSync(file).mtimeMs, before);
    assert.equal(writeIfChanged(file, 'b'), true);
    assert.equal(readFileSync(file, 'utf8'), 'b');
  });
});
