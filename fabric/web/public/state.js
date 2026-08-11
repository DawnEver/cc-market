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
 * Header aggregate: how many machines are up, total sessions, cumulative spend across
 * listed sessions. Cost is cumulative across the shown sessions (the data fabric has),
 * not a daily bucket — the label must say "spend", never "$ today".
 */
export function aggregateFleet(fleet) {
  const alive = fleet.filter((m) => m.alive);
  let sessions = 0, cost = 0;
  for (const m of fleet) {
    for (const s of sessionsOf(m)) { sessions++; cost += s.usage?.cost_usd ?? 0; }
  }
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
 * A session's context-window occupancy. used = the LATEST turn's full-prompt tokens
 * (usage.context_tokens; falls back to the cumulative total for peers on older code);
 * limit = the model's window (context_limit, resolved server-side from the id). pct is
 * null when either is unknown — a percentage would be fabricated. After a native compact
 * the next turn's context_tokens drop, so the percentage falls with the window.
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
