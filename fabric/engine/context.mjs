// engine/context.mjs — context-window facts: the LIMIT per model id.
//
// The limit is a property of the MODEL. Fabric derives it from the model id when the id
// encodes the window ([1m], 256k) or names a known family (claude → 200k standard);
// anything else reports null — the UI then shows raw tokens WITHOUT a percentage, because
// a fabricated percentage is a lie. Unknown models can be added here; the console never
// invents a number it cannot justify.
//
// Occupancy "used" is the LATEST turn's full-prompt tokens (input + cache creation +
// cache read) — NOT the cumulative sum. In a multi-turn child, each turn re-sends the
// whole context, so the latest turn's input tokens ARE the current window usage; after
// a native compact the next turn's input drops, so the percentage reflects compaction
// exactly when it should. The frontend derives the % from listSessions' context_limit +
// usage.context_tokens (state.js contextStatus); this module is the single source for
// the limit table, resolved server-side and carried on every session row.

const KNOWN = [
  [/1m\]?$/i, 1_000_000], // deepseek-v4-flash[1m], deepseek-v4-pro[1m], k3[1m], *-1m
  [/256k$/i, 256_000],
  [/128k$/i, 128_000],
  [/200k$/i, 200_000],
  [/^claude-/, 200_000],  // claude 4.5/5 family standard context
  // The native claude aliases the console/CLI select from (haiku/sonnet/opus/fable).
  [/^(haiku|sonnet|opus|fable)$/i, 200_000],
];

/** The context-window size (tokens) for a model id, or null when unknown. */
export function contextLimitFor(model) {
  if (!model) return null;
  for (const [re, limit] of KNOWN) if (re.test(String(model))) return limit;
  return null;
}
