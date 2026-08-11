// web/public/render.js — a tiny keyed DOM builder: h()/t() make vnodes, mount/patch
// diff them into a container by key. No innerHTML anywhere — text is set via
// textContent, so user/session text can never be injected as markup (the old console
// interpolated some fields into innerHTML; selection, scroll and a mid-click card are
// preserved because the container is patched, not replaced).
//
// Events are NOT attached per-node: elements carry data-action attributes and one
// delegated listener in main.js dispatches them. That keeps handlers stable across
// patches (patch() never touches listeners) and the diff purely structural.
//
// vnode shapes:
//   { tag, attrs, children: [] }   element; children are vnodes
//   { tag: null, text: "..." }      text leaf
// Keys: an element's attrs.key (default: its index). Text leaves key by index only —
// separate namespace from element keys so they never collide.

export function h(tag, attrs = {}, ...children) {
  // tag may carry classes: "div.card click" → <div class="card click">.
  const dot = tag.indexOf(".");
  const cls = dot === -1 ? "" : tag.slice(dot + 1).split(".").join(" ");
  return { tag: dot === -1 ? tag : tag.slice(0, dot), classes: cls, attrs, children: children.flat(Infinity) };
}
export function t(text) { return { tag: null, text: String(text ?? "") }; }

function effectiveClass(v) {
  // Defensive against a non-vnode / text vnode reaching here (attrs undefined): the
  // old bug was a caller passing attrs as the vnode — v?.attrs?.class never crashes.
  const fromAttr = v?.attrs?.class ?? "";
  return [v?.classes, fromAttr].filter(Boolean).join(" ");
}

function setAttr(el, k, v) {
  if (k === "value") el.value = v;
  else if (k === "disabled") { if (v) el.setAttribute("disabled", ""); else el.removeAttribute("disabled"); }
  else if (k === "class") el.className = v;
  // Generic fallback: name, type, style, for, data-*, title, placeholder, id, … Forms
  // are built as vnodes (the view skeletons), so attribute setting must not be a
  // whitelist — values land via setAttribute, never as markup.
  else el.setAttribute(k, v);
}

function createElement(v) {
  if (v.tag == null) return document.createTextNode(v.text);
  const el = document.createElement(v.tag);
  el.className = effectiveClass(v);
  for (const [k, val] of Object.entries(v.attrs)) if (k !== "key" && k !== "class") setAttr(el, k, val);
  for (const c of v.children) el.appendChild(createElement(c));
  return el;
}

function syncAttrs(el, oldV, newV) {
  if (el.className !== effectiveClass(newV)) el.className = effectiveClass(newV);
  const oldA = oldV.attrs, newA = newV.attrs;
  for (const [k, v] of Object.entries(newA || {})) {
    if (k === "key" || k === "class") continue;
    if (oldA?.[k] !== v) setAttr(el, k, v);
  }
  for (const k of Object.keys(oldA || {})) {
    if (k === "key" || k === "class" || k in (newA || {})) continue;
    if (k === "disabled") el.removeAttribute("disabled");
    else el.removeAttribute(k);
  }
}

function childKey(v, i) { return v.tag == null ? `__${i}` : (v.key ?? `k${i}`); }

function reconcileElement(el, oldV, newV) {
  if (oldV.tag == null) {
    if (oldV.text !== newV.text) el.nodeValue = newV.text;
    return;
  }
  syncAttrs(el, oldV, newV);
  const oldKids = oldV.children || [];
  const newKids = newV.children || [];
  // Map old children by key. DOM nodes must come from childNodes, NOT children: a text
  // leaf renders as a text node, which children (element nodes only) never includes —
  // indexing children here produced undefined for every vnode whose child was text
  // (e.g. a span.dim wrapping t(...)), and the reconcile then crashed on undefined.el.
  // createElement appends in vnode order, so childNodes[i] aligns with oldKids[i].
  const oldByKey = new Map(oldKids.map((c, i) => [childKey(c, i), { v: c, el: el.childNodes[i] }]));
  const used = new Set();
  const kept = [];
  for (let i = 0; i < newKids.length; i++) {
    const nk = newKids[i];
    const key = childKey(nk, i);
    const match = oldByKey.get(key);
    let dom;
    if (match) { dom = match.el; reconcileElement(dom, match.v, nk); }
    else dom = createElement(nk);
    kept.push(dom);
    used.add(key);
  }
  for (const [key, { el: dom }] of oldByKey) if (!used.has(key)) dom.remove();
  // Reorder so kept children sit in newKids order (childNodes again — text included).
  kept.forEach((dom, i) => { if (el.childNodes[i] !== dom) el.insertBefore(dom, el.childNodes[i]); });
}

// root is a CONTAINER: the vnode's element is its single child (childNodes[0]), not
// root itself. mount replaces that child; patch reconciles it in place. This keeps the
// DOM element the vnode maps to consistent across patch cycles (the old code reconciled
// the container element against a vnode that mounted as its CHILD — attribute/class
// updates landed on the wrong element).
export function mount(root, v) {
  root.replaceChildren(createElement(v));
  root._v = v;
}
export function patch(root, v) {
  if (!root._v) return mount(root, v);
  reconcileElement(root.childNodes[0], root._v, v);
  root._v = v;
}
