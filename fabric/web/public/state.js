// web/public/state.js — PURE frontend state derivations (no DOM, no fetch). These are
// the only functions with "logic" in the console; main.js and render.js stay dumb.
// Tested in tests/web-state.test.mjs, which is why this module has zero browser deps.
//
// The truth about a session's conversation lives in its transcript (from /view). The
// console's per-session log (from /log) is only the fallback for backends with no
// content viewer (codex reports content:null honestly). parseTranscript turns the
// always-recorded transcript text into messages; viewMessages picks the honest source.

/** A transcript header line: [user], [human], [goal], [assistant · turn N], [system], [error]. */
const HEADER = /^\[(user|human|goal|assistant · turn \d+|system|error)\]$/;

/**
 * Parse the always-recorded transcript (tee output) into messages. Each message is
 * { role: 'user'|'assistant'|'system', text, turn?, human? }. Text runs until the next
 * header line; leading/trailing blank lines are trimmed. Empty transcripts parse to [].
 */
export function parseTranscript(content) {
  const msgs = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      cur.text = cur.text.replace(/^\n+|\n+$/g, "");
      if (cur.text) msgs.push(cur);
      cur = null;
    }
  };
  for (const line of String(content ?? "").split("\n")) {
    const m = line.match(HEADER);
    if (m) {
      flush();
      const tag = m[1];
      cur = {
        role: (tag === "user" || tag === "human" || tag === "goal") ? "user"
            : tag.startsWith("assistant") ? "assistant" : "system",
        text: "",
      };
      if (tag.startsWith("assistant")) cur.turn = +tag.match(/\d+/)[0];
      if (tag === "human") cur.human = true;
    } else if (cur) {
      cur.text += "\n" + line;
    }
  }
  flush();
  return msgs;
}

/**
 * The messages a session's chat view should show. A real transcript is the truth; the
 * console log is a fallback for backends with no content viewer, labelled honestly.
 * Returns { messages, source: 'transcript'|'log', reason }.
 */
export function viewMessages(view, consoleLog = []) {
  if (view && view.content != null) return { messages: parseTranscript(view.content), source: "transcript" };
  const reason = view && view.reason ? view.reason
    : "this backend has no content viewer — showing this console's local message log";
  return { messages: consoleLog, source: "log", reason };
}

/**
 * Cross-machine session dedup. An ATTACHED session lives twice in the fleet: as a
 * console-owned handle on this machine (drivable) AND as the peer's own native session
 * — but it is ONE conversation. (sessionsOf dedups only WITHIN a machine.) Keyed by
 * nativeId ?? id; the first occurrence wins, and fleet order puts this machine (with
 * the drivable handle) first, so counts and warnings prefer the drivable copy.
 */
export function uniqueSessions(fleet) {
  const seen = new Set();
  const out = [];
  for (const m of fleet) {
    for (const s of sessionsOf(m)) {
      const k = s.nativeId ?? s.id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ machine: m, session: s });
    }
  }
  return out;
}

/**
 * Header aggregate: how many machines are up, total sessions, cumulative spend across
 * listed sessions. Cost is cumulative across the shown sessions (the data fabric has),
 * not a daily bucket — the label must say "spend", never "$ today".
 */
export function aggregateFleet(fleet) {
  const alive = fleet.filter((m) => m.alive);
  let sessions = 0, cost = 0;
  for (const { session: s } of uniqueSessions(fleet)) { sessions++; cost += s.usage?.cost_usd ?? 0; }
  return { alive: alive.length, total: fleet.length, sessions, cost };
}

/**
 * A machine's unified session list: its console-owned sessions plus its peer sessions
 * that are not already counted as console-owned (dedup by nativeId), so each session
 * appears exactly once.
 */
export function sessionsOf(machine) {
  const own = machine.console_sessions || [];
  const ownIds = new Set(own.map((s) => s.nativeId ?? s.id));
  const remote = (machine.sessions || []).filter((s) => !ownIds.has(s.nativeId ?? s.id));
  return [...own, ...remote];
}

/** The machine a session came from — sessions are always rendered under their machine. */
export function sessionMachine(machine) { return machine.name; }

/**
 * The projects a machine shows: its registered aliases plus any project its sessions
 * carry (a session outside every alias appears under an "(no project)" bucket).
 */
export function projectsOf(machine) {
  const all = sessionsOf(machine);
  return [...new Set([...(machine.projects || []), ...all.map((s) => s.project).filter(Boolean)])];
}

/** True when this console may drive the session: it owns it, attached it, or it is shared. */
export function canDrive(session, attachedKeys) {
  return !!session.chattable || attachedKeys.has(session.key) || !!session.shared;
}

/** A stable chat key for a session: machine + remote/console id. */
export function sessionKey(machineName, session) {
  return `${machineName}:${session.nativeId ?? session.id}`;
}

/**
 * A session's context-window fill, ESTIMATED. used = usage.context_tokens, which the
 * engine derives as fresh input + content written to cache, EXCLUDING cache-read tokens
 * (the CLI's result usage sums re-reads over the turn's tool sub-requests and would
 * over-count Nx — see engine/open-session.mjs). Falls back to the cumulative total for
 * peers on older code. limit = the model's window (context_limit, resolved server-side
 * from the id). pct is null when either is unknown — a percentage would be fabricated.
 * After a native compact the next turn's context_tokens drop, so the % falls with the
 * window.
 */
export function contextStatus(session) {
  const used = session?.usage?.context_tokens ?? session?.usage?.total_input_tokens ?? null;
  const limit = session?.context_limit ?? null;
  return {
    used,
    limit,
    pct: (used != null && limit) ? Math.min(100, Math.round((used / limit) * 100)) : null,
    compacted: session?.compacted ?? 0,
  };
}

/**
 * Is the session WORKING right now — a reply streaming, or a goal loop running?
 * Uses the backend's `working` liveness fact (true while a turn/loop is in flight),
 * reported honestly as false when the backend says it isn't, and false when the
 * signal is unknown rather than inventing a "busy" for a peer that reports none.
 * The console's own in-flight `send()` is folded in by the caller (`sending`).
 */
export function workingOf(session) {
  return session?.working === true;
}

// ── attention: the Fleet view's needs-attention list, derived from facts the fleet
// probe already carries (dead peers, load, capacity, ctx occupancy, orphans, dead
// sessions). Nothing here invents state; thresholds are exported so the UI badges and
// the tests share one source.

export const CTX_WARN_PCT = 85;      // session context occupancy worth acting on
export const CTX_CRIT_PCT = 95;      // display tier: red fill — the window is effectively full
export const CPU_WARN_PCT = 90;      // machine CPU busy worth acting on
export const MEM_WARN_FREE_PCT = 10; // free memory below this share of total

/**
 * One machine's warning facts — badges on its Fleet card, inputs to attentionItems.
 * A dead machine reports 'DEAD' and nothing else (probe facts are absent for it).
 */
export function machineWarnings(m) {
  if (!m?.alive) return ["DEAD"];
  const w = [];
  if (m.cpu_busy_pct != null && m.cpu_busy_pct >= CPU_WARN_PCT) w.push(`cpu ${m.cpu_busy_pct}%`);
  if (m.mem_total_mb && m.mem_available_mb != null) {
    const freePct = Math.round((m.mem_available_mb / m.mem_total_mb) * 100);
    if (freePct <= MEM_WARN_FREE_PCT) w.push(`mem ${freePct}% free`);
  }
  const count = m.sessions_count ?? sessionsOf(m).filter((s) => s.alive !== false).length;
  if (m.maxSessions != null && count >= m.maxSessions) w.push(`capacity ${count}/${m.maxSessions}`);
  return w;
}

/**
 * The Fleet view's needs-attention list, worst severity first (then machine, then text,
 * so the order is stable across polls). Item: { severity:'bad'|'warn', kind, machine,
 * text, session?, orphans? } — kind: machine-dead | machine-load | session-dead | ctx |
 * orphans. The UI maps kind (+ session drivability) to a jump target.
 */
export function attentionItems(fleet, orphans = [], selfName = null) {
  const items = [];
  for (const m of fleet) {
    if (!m.alive) {
      items.push({ severity: "bad", kind: "machine-dead", machine: m.name,
        text: `${m.name} DEAD — ${m.error || "unreachable"}` });
      continue;
    }
    for (const w of machineWarnings(m))
      items.push({ severity: "warn", kind: "machine-load", machine: m.name, text: `${m.name} ${w}` });
  }
  // Per-session items go through uniqueSessions: an attached session appears on TWO
  // machines (the console's handle + the peer's native entry) but warns ONCE.
  for (const { machine: m, session: s } of uniqueSessions(fleet)) {
    if (!m.alive) continue; // an unreachable peer's sessions warn via machine-dead above
    if (s.alive === false) {
      items.push({ severity: "warn", kind: "session-dead", machine: m.name, session: s,
        text: `${m.name} · ${s.id} process died` });
      continue;
    }
    const { pct } = contextStatus(s);
    if (pct != null && pct >= CTX_WARN_PCT)
      items.push({ severity: "warn", kind: "ctx", machine: m.name, session: s,
        text: `${m.name} · ${s.id} ctx ${pct}% — compact soon` });
  }
  // Orphans group per machine: a machine may carry several unaccounted records.
  const byMachine = new Map();
  for (const o of orphans) {
    const mn = o.node ?? selfName ?? "this machine";
    if (!byMachine.has(mn)) byMachine.set(mn, []);
    byMachine.get(mn).push(o);
  }
  for (const [mn, list] of byMachine) {
    const resumable = list.filter((o) => o.sessionId && o.pidAlive).length;
    items.push({ severity: "warn", kind: "orphans", machine: mn, orphans: list,
      text: `${mn} · ${list.length} unaccounted session(s)${resumable ? ` (${resumable} resumable)` : ""}` });
  }
  const sev = (i) => (i.severity === "bad" ? 0 : 1);
  return items.sort((a, b) => sev(a) - sev(b) || a.machine.localeCompare(b.machine) || a.text.localeCompare(b.text));
}

/** Fleet-card ordering: dead first, then warned, then healthy; this machine leads its tier. */
export function compareMachines(a, b) {
  const rank = (m) => (!m.alive ? 0 : machineWarnings(m).length ? 1 : 2);
  const r = rank(a) - rank(b);
  if (r) return r;
  if (!!a.self !== !!b.self) return a.self ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Header health dot: the worst severity anywhere in the fleet. */
export function fleetHealth(items) {
  if (items.some((i) => i.severity === "bad")) return "bad";
  if (items.length) return "warn";
  return "ok";
}
