---
created: 2026-08-09
accessed: 2026-08-09
description: console v2 information architecture, derived from the user's five questions -- Node→Project→Session drill-down with filter-not-navigation, live-probed capability catalogue (subscription/actual-model identity), local/G unification, owner-scope honesty; for user review before implementation
---

# Design: console v2 — the information architecture, from the user's questions

For review, 2026-08-09. v1 (commit `e026724`+`bab42a3`) proved the plumbing; v2 is the
shape. Derived not from features but from the five questions an operator actually asks.

## The five questions, and what each demands

**Q1 "我的算力在哪、状态如何?"** → A FLEET of MACHINES, not "nodes + local". This
machine IS one of the machines; today it appears twice ("local" spawn target + node G
card). v2 unifies: the console detects which configured node is THIS box (hostname match
against serve.byHost, else a loopback status probe) and renders ONE card badged
`this machine`. Spawn target "local" disappears — you always pick a machine, and the
this-machine pick routes to a local spawn (no TLS hop) transparently.

**Q2 "每台机器上在跑什么?"** → The drill-down is **Node → Project → Session**, and
selection is a FILTER, never a navigation: no selection = everything, clicking a node
narrows to it, clicking a project narrows further, click-again clears. One list, three
zoom levels — the operator never loses the whole-fleet picture to look at one box.
Data gap this exposes: sessions must carry their PROJECT. Today node/status sessions
have no cwd/project field. Fix at the source: the registry records `cwd` at spawn;
node/status reverse-maps cwd → the node's project aliases and returns
`{project, cwd}` per session, plus the node's own `projects` list (so an idle project
still shows, with zero sessions).

**Q3 "我能开什么?"** → The capability CATALOGUE must be probed, never hardcoded, and
must state IDENTITY, not aliases:
- **claude** → probe `claude --version`; auth identity read from the CLI's stored
  credentials/config (subscription type + account email when available). Label:
  `claude 2.x — Max subscription (linxu@…)`, not just "claude".
- **codex** → `checkCodexStatus()` (exists): version + authenticated. VERIFIED live
  today: one-shot CODEX-OK and a persistent session CODEX-SESSION-OK.
- **API providers** → the config already IS the truth: render the alias→actual mapping
  (`haiku → deepseek-v4-flash[1m]`, `fable → k3[1m]`, …) next to each model option, plus
  the base URL. An alias without its real model shown is a declaration that lies.
- **effort** → levels come from ONE exported table (`EFFORT_LEVELS` in spawn-child) via
  the catalogue — the UI never re-spells them. Same rule for any future axis.
- **Freshness mechanism**: catalogue = probe on console start + a manual ⟳ button +
  15-min TTL re-probe. Probes are commands (`claude --version`, codex status, config
  read), each with a `probed_at` timestamp shown in the UI — a stale catalogue must
  look stale.

**Q4 "我要跟它说话"** → chat, unchanged in mechanism (same send chain), but scope made
VISIBLE: console-owned sessions get a chat view; foreign sessions (spawned by other
connections/processes, visible via node/status) render as observe-only cards saying WHY
("owned by another connection — node/send is owner-restricted"). An unexplained
disabled button is a scope-lie.

**Q5 "有没有没人管的?"** → orphans (journal reconcile), unchanged, but moved under the
machine they belong to in the drill-down (a remote orphan shows on its node's card),
with a "clear record" action for dead ones.

## Layout (three panes stay, contents re-anchored)

```
┌ header: fleet totals (machines alive, sessions, $ today) · catalogue age · ⟳ ┐
│ LEFT: machines        │ MIDDLE: Project → Session tree │ RIGHT: chat /       │
│  [G · this machine]   │  (filtered by left selection;  │  observe detail /   │
│  [WS1] [WS2]          │   default = all; orphans       │  spawn drawer       │
│  click = filter       │   inline under their machine)  │                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

Spawn drawer defaults follow the current filter: machine = selected node, project =
selected project — "open one here" instead of re-picking axes.

## API deltas (all additive)

| endpoint | change |
|---|---|
| `node/status` | + `projects: [alias]`, per-session `{project, cwd}` |
| registry | records `cwd`/`project` at spawn (source fix for Q2) |
| `/api/catalogue` | v2: per-provider `{version, identity, probed_at}`, per-model `{alias, actual}`; effort from EFFORT_LEVELS export |
| `/api/fleet` | replaces `/api/nodes`: unified machines (this-machine flag), sessions grouped by project, foreign vs owned marked |
| `/api/orphans/:id/clear` | tombstone a dead orphan record |

## What v2 deliberately does NOT do

No auth (loopback-only stands). No spawning INTO foreign sessions. No task/Issue view
yet — that arrives with swarm's agent-loop and slots into the same drill-down as a
fourth level (Machine → Project → Task → Session). No websockets — polling is fine at
this scale; SSE only if the 2.5 s chat poll ever feels laggy.

## Review questions for the user

1. Node→Project→Session with filter-not-navigation — 符合预期?
2. "this machine" 合并后不再有单独的 local 目标 — 接受?
3. Catalogue 的身份标注(订阅类型/实际模型 ID/探测时间戳)够不够,还缺什么?
4. Foreign session 只可观察(owner 限制如实展示)— 接受,还是需要"接管"能力(那是一个更大的安全设计)?
