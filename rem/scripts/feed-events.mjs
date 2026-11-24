// feed-events.mjs — the forge events dev-lab's forgefeed KEPT for a task while no session was bound to it
// (TASK-HEARS-ITS-FORGE-EVENTS, dev_lab.dev.forgefeed.task_pending). rem cannot import Python, so it reads the
// queue forgefeed writes: `<machine home>/forgefeed/tasks/<slug>.jsonl`, one JSON object per line whose `line` is
// the event as forgefeed would say it. Read, never consumed: the first session bound to the task consumes them
// (forgefeed's inbox hook). The machine home is session-binding's (LAB_COMMONS_HOME); unset, the reader names
// its door in one line instead of failing `task status`.

import { readFileSync } from 'fs';
import { join } from 'path';
import { machineHome } from './session-binding.mjs';

export const FEED_DIR = 'forgefeed';

// {lines: [...], note: string|null}: the kept events, or why they could not be read (never a throw).
export function keptEvents(slug, env = process.env) {
  let home;
  try {
    home = machineHome(env);
  } catch (unset) {
    return { lines: [], note: `forge events not read: ${unset.message}` };
  }
  let raw;
  try {
    raw = readFileSync(join(home, FEED_DIR, 'tasks', `${slug}.jsonl`), 'utf8');
  } catch {
    return { lines: [], note: null }; // no queue: nothing kept
  }
  const lines = [];
  for (const text of raw.split(/\r?\n/)) {
    if (!text.trim()) continue;
    try {
      const line = JSON.parse(text).line;
      if (typeof line === 'string') lines.push(line);
    } catch { /* a torn line is skipped, as forgefeed's own reader does */ }
  }
  return { lines, note: null };
}

// The status block: nothing when nothing is kept and nothing went wrong.
export function keptEventsText(slug, env = process.env) {
  const { lines, note } = keptEvents(slug, env);
  if (note) return note;
  if (!lines.length) return '';
  return [`forge events kept for ${slug} (${lines.length}; heard by the next bound session):`, ...lines.map(l => `  ${l}`)]
    .join('\n');
}
