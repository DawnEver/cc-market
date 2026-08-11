// scripts/lib/format.mjs — fleet display formatting (L1 presentation helpers). Used by
// scripts/ping.mjs and scripts/mcp-server.mjs (list_nodes). The web console keeps its own
// tiny inline copies in web/public/app.js (browser, cannot import this).

/** 90061 → "1d 1h 1m", 3661 → "1h 1m", 45 → "45s". */
export function fmtUptime(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${sec}s`);
  return parts.join(" ");
}

/** 2048 → "2.0GB", 512 → "512MB". */
export function fmtMem(mb) {
  if (!Number.isFinite(mb)) return "?";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`;
}

/** Epoch-ms → "2m ago" / "3h ago" / "just now". */
export function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
