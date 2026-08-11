---
name: design-console-v4-funnel-views
created: 2026-08-11
---

# Design: console v4 — funnel views (Fleet / Sessions / Chat) + attention model

Session 2026-08-11. Re-anchored the console layout from first principles, replacing the
v3 three-column split (machines | sessions | chat, `280px 360px 1fr`).

## First-principles derivation

The operator's three scenarios are NOT three regions of one screen — they are three
attention modes of one sequential funnel:

1. "全部机器有无预警?" — global scan, seconds, wants SPARSE output (only anomalies).
2. "按 project/machine 梳理 session 现状" — single-point compare, minutes, wants DENSE
   columns (facts comparable across sessions).
3. "跟这个 session 工作" — converged focus, tens of minutes, wants everything else gone.

Attention narrows monotonically, so each stage gets the full screen; a static 3-column
layout kept charging screen-tax for stages already passed. Scale constraint from the
user: design for **dozens of machines / ~100 sessions**, not the current 3/<10.

## What v4 does

- **Three hash-routed views** (`#/fleet` `#/sessions` `#/chat`), tabs in the header;
  filters (`selMachine`/`selProject`) survive view switches; browser Back works.
- **Fleet** = needs-attention list + compact machine grid. Attention items are derived
  PURELY from facts the probe already carries (state.js `attentionItems`,
  `machineWarnings`, `compareMachines`, `fleetHealth`; exported thresholds
  `CTX_WARN_PCT=85`, `CPU_WARN_PCT=90`, `MEM_WARN_FREE_PCT=10`): dead machines, cpu/mem
  over threshold, `sessions_count >= maxSessions` capacity, session `alive:false`,
  ctx% ≥ 85, orphans grouped per machine. Sorted worst-first; each item jumps to the
  filtered Sessions view or straight into the chat. **No backend change was needed.**
- **Sessions** = full-width browse: collapsible machine groups (per-machine collapsed
  state kept in memory), project rows as filters (v2's filter-not-navigation kept
  WITHIN the view), and sessions as **one dense grid row each** (dot · id ·
  provider/model/effort · turns · ctx bar+pct · cost · last-active · actions) — column
  alignment is what makes ~100 sessions comparable. Spawn drawer lives here and names
  its machine explicitly (a select), so spawning no longer requires pre-filtering.
- **Chat** = full-width focus: breadcrumb + live facts top bar (`← Sessions` back with
  filters kept), transcript-as-truth unchanged, OBSERVE mode unchanged. Ambient fleet
  awareness collapses to the header **health dot** (worst severity anywhere), still fed
  by the 6s poll — you lose the noise, not the alarm. Chat poll (2.5s) only runs in the
  Chat view now.

## Implementation invariants (cost of the change)

- **View skeletons mount once per entry** (`mountView` nulls `root._v` → render.js
  mount path); polls then patch sub-containers by id. Patching a container holding form
  controls would yank an open dropdown / half-typed prompt — the composer, spawn form
  and selects all live in skeletons, never in poll-patched regions. Selects refill only
  when their option-set signature changed.
- **render.js `setAttr` is now a generic setAttribute fallback** (was a whitelist that
  silently dropped `name`/`type`/`style`) — view skeletons build real forms as vnodes.
  Still no innerHTML anywhere (text via textContent only); select OPTION lists remain
  the one sanctioned innerHTML exception (static markup from the catalogue).
- All clicks/changes/Enter go through the ONE delegated dispatcher (document-level,
  `data-action`) — skeleton re-mounts never re-wire listeners.
- render.js `childKey` reads `v.key` but `h()` never hoists `attrs.key` — keys have
  always been positional in effect; reconcile is content-correct under reordering
  regardless (verified while adding attention-first sorting). Left as-is; noted so a
  future reader doesn't "fix" sorting by relying on keys.
- ctx attention buttons mirror sessRow's id/chattable derivation exactly — a
  shared-but-unattached session must go through openSession's attach path (peer id is
  never a console id).

## Theme: PAPER (user-picked from a rendered 4-candidate gallery)

Style round (same session): the structural system is theme-agnostic — mono data font
(ids/turns/cost/ctx), warn/human semantics split, ctx display tiers (≥85 amber, ≥95
red), transitions + focus rings, pulsing bad health dot, h2 live counts, all-clear
positive style, auto-FIT machine grid (small fleets stretch, full grids identical).
Palette goes through CSS variables, so the four rendered candidates (Console Dark /
Paper / Solar warm-paper / Mission deep-indigo) were a variable swap each; the gallery
(screenshot per candidate on one composite page) is how the user picked — render
options, don't describe them. **User picked Paper** (light neutral): the "黑乎乎" dark
was explicitly rejected. A second theme later = one variable block, no restyle.

Known honesty wrinkle: attaching the SAME native session twice (attach → reload →
attach again) creates two console handles; header/chips count unique CONVERSATIONS
(`uniqueSessions`) while the tree shows HANDLES — a 2-handles-1-conversation fleet
reads "1 session(s)" with 2 rows. Convention: counts are conversations, rows are
resources. Closing the stale handle cleans it.

## Deferred / NOT done

No websockets (polling fine at this scale), no multi-chat tabs, no collapse-all button
for machine groups (YAGNI until a real fleet complains), no auth (loopback stands).
Peers on old code still report without `context_tokens`/`maxSessions` — the attention
model degrades silently (no ctx items, no capacity badges), same honesty rule as v3.

## Visual verification loop (same session, after the first commit)

Unit tests + curl smoke were NOT enough: the first live render showed an EMPTY Fleet
view. Root cause: skeletons passed `h('div', { key, attrs: { id } })` — h's second
parameter IS the attrs bag, so the object stringified to `attrs="[object Object]"` and
the ids never landed; `$('#attention')` was null and the renderers early-returned.
Found via Edge headless `--dump-dom` (the bogus attribute was literally visible in the
serialized DOM — the generic setAttr fallback turned a silent drop into a visible one).
Fix + permanent guard: `h()` now THROWS on a nested attrs bag (web-render.test).

Working loop for UI verification on this box (no puppeteer needed):

- Edge headless one-shot: `msedge --headless --disable-gpu --window-size=1600,900
  --virtual-time-budget=9000 --screenshot=out.png URL` (screenshot must be a WINDOWS
  absolute path; Git-Bash /tmp is not writable by Edge).
- Interactive funnel E2E: `--remote-debugging-port` + Node's built-in WebSocket (CDP):
  Runtime.evaluate to click, Page.captureScreenshot per stage. Verified fleet →
  machine card → sessions (filter chip) → session row → attach-on-click → chat with
  live transcript → back button (filters kept).
- Scale mock: static HTML against the live `/style.css` with 24 machines / ~100 dense
  session rows — grid and row density validated without a fake fleet.

Caught & fixed this way: the attrs foot-gun (above), machine-card stats wrapping
mid-item ("0\nsess" → one nowrap span per stat), and **cross-machine session
duplication** — an ATTACHED session appears on two machines (the console's drivable
handle + the peer's native entry), so it double-counted in the header and warned twice
in the attention list. New `uniqueSessions(fleet)` (keyed `nativeId ?? id`, first copy
wins — fleet order puts the drivable handle first) backs both `aggregateFleet` and the
per-session attention loop. First dogfood: G flagged itself "mem 0% free" (94 MB of
32 GB) — the attention model works.
