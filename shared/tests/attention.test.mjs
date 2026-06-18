// shared/tests/attention.test.mjs — tests for shared/attention.mjs (the attention gate)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(join(__dirname, '..', 'attention.mjs')).href;
const { compress, classify, route, detectConsumer } = await import(url);

// Sample escalation items a skill might produce.
const reversibleWithDefault = {
  id: 'SR-1', title: 'Rename helper', detail: 'local rename', kind: 'wont-fix',
  stakes: 'LOW', reversible: true, default: 'fix',
  options: [{ label: 'Fix', value: 'fix' }, { label: 'Skip', value: 'skip' }],
};
const irreversibleArch = {
  id: 'SR-2', title: 'Change public API', detail: 'breaks callers', kind: 'arch',
  stakes: 'HIGH', reversible: false, default: null,
  options: [{ label: 'Apply', value: 'apply' }, { label: 'Reject', value: 'reject' }],
};
const highStakesWithDefault = {
  id: 'SR-3', title: 'Drop migration', detail: 'data loss risk', kind: 'arch',
  stakes: 'HIGH', reversible: true, default: 'keep',
  options: [{ label: 'Keep', value: 'keep' }, { label: 'Drop', value: 'drop' }],
};

// ── detectConsumer ──
describe('detectConsumer', () => {
  it('override wins over everything', () => {
    assert.equal(detectConsumer({ override: 'ai', interactive: true }), 'ai');
    assert.equal(detectConsumer({ override: 'human', headless: true }), 'human');
  });
  it('headless ⇒ ai', () => {
    assert.equal(detectConsumer({ headless: true }), 'ai');
  });
  it('interactive default ⇒ human', () => {
    assert.equal(detectConsumer({}), 'human');
    assert.equal(detectConsumer({ interactive: true }), 'human');
  });
});

// ── compress ──
describe('compress', () => {
  it('produces the standard attention payload', () => {
    const c = compress(irreversibleArch);
    assert.equal(c.id, 'SR-2');
    assert.ok(c.headline.length > 0);
    assert.equal(c.reversible, false);
    assert.equal(c.stakes, 'HIGH');
    assert.deepEqual(c.options, irreversibleArch.options);
    assert.ok('consequenceIfIgnored' in c);
    assert.ok('defaultIfIgnored' in c);
  });
  it('marks defaultIfIgnored when a default exists', () => {
    assert.equal(compress(reversibleWithDefault).defaultIfIgnored, 'fix');
    assert.equal(compress(irreversibleArch).defaultIfIgnored, null);
  });
});

// ── classify ──
describe('classify', () => {
  it('reversible + default + non-HIGH ⇒ autoDefault', () => {
    const { mustDecide, autoDefault } = classify([reversibleWithDefault]);
    assert.equal(autoDefault.length, 1);
    assert.equal(mustDecide.length, 0);
  });
  it('irreversible ⇒ mustDecide', () => {
    const { mustDecide, autoDefault } = classify([irreversibleArch]);
    assert.equal(mustDecide.length, 1);
    assert.equal(autoDefault.length, 0);
  });
  it('HIGH stakes ⇒ mustDecide even if reversible+default', () => {
    const { mustDecide } = classify([highStakesWithDefault]);
    assert.equal(mustDecide.length, 1);
  });
});

// ── route: human ──
describe('route — human', () => {
  it('applies autoDefaults silently and prompts only for mustDecide', () => {
    const r = route([reversibleWithDefault, irreversibleArch], { consumer: 'human' });
    assert.equal(r.consumer, 'human');
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].id, 'SR-1');
    assert.equal(r.applied[0].via, 'default');
    assert.ok(r.prompt, 'expected an AskUserQuestion payload');
    assert.equal(r.prompt.questions.length, 1);
    assert.equal(r.prompt.questions[0].header.length <= 12, true);
  });
  it('no mustDecide ⇒ no prompt', () => {
    const r = route([reversibleWithDefault], { consumer: 'human' });
    assert.equal(r.prompt, null);
  });
  it('caps coalesced questions at 4 and overflows the rest', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...irreversibleArch, id: `SR-${i}`, stakes: i < 4 ? 'HIGH' : 'MEDIUM',
    }));
    const r = route(many, { consumer: 'human' });
    assert.equal(r.prompt.questions.length, 4);
    assert.equal(r.overflow.length, 2);
  });
});

// ── route: ai ──
describe('route — ai', () => {
  it('never prompts; applies defaults by policy', () => {
    const r = route([reversibleWithDefault, highStakesWithDefault], { consumer: 'ai' });
    assert.equal(r.prompt, null);
    const ids = r.applied.map(a => a.id).sort();
    assert.deepEqual(ids, ['SR-1', 'SR-3']);
  });
  it('defers irreversible+no-default items instead of blocking', () => {
    const r = route([irreversibleArch], { consumer: 'ai' });
    assert.equal(r.prompt, null);
    assert.equal(r.applied.length, 0);
    assert.equal(r.deferred.length, 1);
    assert.equal(r.deferred[0].id, 'SR-2');
    assert.ok(r.deferred[0].reason);
  });
});
