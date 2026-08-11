// Tests for web/public/render.js — the keyed vnode diff. A minimal DOM shim stands in
// for the browser; these guard the crash class that hit the live console twice
// (text leaves / attrs-mismatch producing "Cannot read properties of undefined").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, t, mount, patch } from '../web/public/render.js';

// ── minimal DOM shim (only what render.js touches) ──
class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null; }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    n.parentNode = this; return n;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i !== -1) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}
class FakeText extends FakeNode {
  constructor(text) { super(); this.nodeType = 3; this.nodeValue = String(text); }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
  setAttribute() {}
  removeAttribute() {}
}
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.className = ""; this.attributes = {}; this.value = undefined; }
  get textContent() { return this.childNodes.map((c) => c.textContent ?? c.nodeValue ?? "").join(""); }
  set textContent(v) { this.childNodes = []; this.appendChild(new FakeText(String(v))); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
  replaceChildren(...nodes) { this.childNodes = []; for (const n of nodes) this.appendChild(n); }
  addEventListener() {}
  removeEventListener() {}
}
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
};

test('patch updates a text leaf without crashing (the live-console regression)', () => {
  const root = document.createElement('div');
  mount(root, h('span', {}, [t('one')]));
  assert.equal(root.textContent, 'one');
  patch(root, h('span', {}, [t('two')]));
  assert.equal(root.textContent, 'two');
  patch(root, h('span', { class: 'dim' }, [t('three')]));
  assert.equal(root.textContent, 'three');
  assert.equal(root.childNodes[0].className, 'dim');
});

test('text leaves interleave with elements and stay aligned (childNodes, not children)', () => {
  const root = document.createElement('div');
  mount(root, h('div', {}, [h('b', {}, [t('name')]), t(' · details')]));
  assert.equal(root.textContent, 'name · details');
  patch(root, h('div', {}, [h('b', {}, [t('name')]), t(' · more')]));
  assert.equal(root.textContent, 'name · more');
  assert.equal(root.childNodes[0].childNodes[1].nodeValue, ' · more');
});

test('keyed children: append, remove, reorder reconcile by key', () => {
  const root = document.createElement('div');
  mount(root, h('div', {}, [h('b', { key: 1 }, [t('a')]), h('b', { key: 2 }, [t('b')])]));
  patch(root, h('div', {}, [h('b', { key: 3 }, [t('c')]), h('b', { key: 1 }, [t('a2')])]));
  // container holds the single div; its children reconcile by key (3 new, 1 kept, 2 removed).
  const div = root.childNodes[0];
  assert.equal(div.textContent, 'ca2');
  assert.equal(div.childNodes[0].textContent, 'c');
  assert.equal(div.childNodes[1].textContent, 'a2');
  assert.equal(div.childNodes.length, 2, 'key 2 removed');
});

test('class merges from the tag DSL plus the attr; a change updates className', () => {
  const root = document.createElement('div');
  mount(root, h('div.card', { class: 'sel' }, [t('x')]));
  assert.equal(root.childNodes[0].className, 'card sel');
  patch(root, h('div.card', {}, [t('y')]));
  assert.equal(root.childNodes[0].className, 'card', 'attr class removed, tag class kept');
  assert.equal(root.textContent, 'y');
  patch(root, h('div.card click', {}, [t('z')]));
  assert.equal(root.childNodes[0].className, 'card click');
});

test('generic attributes (name, type, style) are set, synced and removed', () => {
  const root = document.createElement('div');
  mount(root, h('input', { name: 'provider', type: 'text', placeholder: 'p' }, []));
  const el = root.childNodes[0];
  assert.equal(el.attributes.name, 'provider');
  assert.equal(el.attributes.type, 'text');
  patch(root, h('input', { name: 'model' }, []));
  assert.equal(el.attributes.name, 'model');
  assert.equal(el.attributes.type, undefined, 'absent attrs are removed');
});

test('full replace of a container root (e.g. chatEmpty → messages) does not crash', () => {
  const root = document.createElement('div');
  mount(root, h('div.chatEmpty', {}, [t('pick a session')]));
  patch(root, h('div', {}, [h('div.msg user', { key: 0 }, [h('div.who', {}, [t('user')]), t('hello')])]));
  assert.equal(root.childNodes[0].textContent, 'userhello'); // who row + message text
  // second patch (the 2.5s poll) must also survive and update the leaf text
  patch(root, h('div', {}, [h('div.msg user', { key: 0 }, [h('div.who', {}, [t('user')]), t('hello again')])]));
  assert.equal(root.textContent, 'userhello again');
});
