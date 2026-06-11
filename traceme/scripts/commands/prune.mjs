import { openDb, countOldPrompts, countOldToolCalls, countOldPromptsDate, countOldPromptsWithTextDate, countOldToolCallsDate, nullifyOldPrompts, nullifyOldToolCalls, deleteOldToolCalls, nullifyOldPromptsDate, nullifyOldToolCallsDate, deleteOldToolCallsDate } from '../db.mjs';

export function cmdPrune(args) {
  const keepStats = args.includes('--keep-stats');
  const dryRun = args.includes('--dry-run');
  const toolCalls = args.includes('--tool-calls');
  const dayArg = args.slice(1).find(a => /^\d+$/.test(a) || /^\d{4}-\d{2}-\d{2}$/.test(a));
  let cutoffDate;
  let isDateString = false;
  if (dayArg && /^\d{4}-\d{2}-\d{2}$/.test(dayArg)) {
    cutoffDate = new Date(dayArg + 'T00:00:00');
    isDateString = true;
  } else {
    const days = parseInt(dayArg) || 90;
    cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
  }
  const days = Math.ceil((new Date() - cutoffDate) / (1000 * 60 * 60 * 24));
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);
  const db = openDb();

  const promptTextCount = isDateString ? countOldPromptsWithTextDate(cutoffStr) : countOldPrompts(days, true);
  const promptAllCount = isDateString ? countOldPromptsDate(cutoffStr) : countOldPrompts(days, false);
  const toolCount = toolCalls ? (isDateString ? countOldToolCallsDate(cutoffStr) : countOldToolCalls(days)) : 0;

  if (dryRun) {
    if (keepStats) {
      if (isDateString) {
        console.log(`Would clear prompt text for ${promptTextCount} prompts before ${cutoffStr}`);
      } else {
        console.log(`Would clear prompt text for ${promptTextCount} prompts older than ${days} days (before ${cutoffStr})`);
      }
      console.log('Token, cost, and duration data would be retained.');
    } else {
      if (isDateString) {
        console.log(`Would delete ${promptAllCount} prompts before ${cutoffStr}`);
      } else {
        console.log(`Would delete ${promptAllCount} prompts older than ${days} days (before ${cutoffStr})`);
      }
    }
    if (toolCalls) {
      if (isDateString) {
        console.log(`Would also affect ${toolCount} tool calls before ${cutoffStr}`);
      } else {
        console.log(`Would also affect ${toolCount} tool calls older than ${days} days`);
      }
    }
    console.log('(dry run — no changes made)');
  } else {
    if (keepStats) {
      const result = isDateString ? nullifyOldPromptsDate(cutoffStr) : nullifyOldPrompts(days);
      if (isDateString) {
        console.log(`Cleared prompt text for ${result} prompts before ${cutoffStr}`);
      } else {
        console.log(`Cleared prompt text for ${result} prompts older than ${days} days (before ${cutoffStr})`);
      }
      console.log('Token, cost, and duration data retained.');
    } else {
      const pResult = db.prepare('DELETE FROM prompts WHERE date(timestamp) < ?').run(cutoffStr);
      if (isDateString) {
        console.log(`Pruned ${pResult.changes} prompts before ${cutoffStr}`);
      } else {
        console.log(`Pruned ${pResult.changes} prompts older than ${days} days (before ${cutoffStr})`);
      }
    }
    if (toolCalls) {
      if (keepStats) {
        const tcResult = isDateString ? nullifyOldToolCallsDate(cutoffStr) : nullifyOldToolCalls(days);
        if (isDateString) {
          console.log(`Cleared summary for ${tcResult} tool calls before ${cutoffStr} (stats retained)`);
        } else {
          console.log(`Cleared summary for ${tcResult} tool calls (stats retained)`);
        }
      } else {
        const tcResult = isDateString ? deleteOldToolCallsDate(cutoffStr) : deleteOldToolCalls(days);
        if (isDateString) {
          console.log(`Pruned ${tcResult} tool calls before ${cutoffStr}`);
        } else {
          console.log(`Pruned ${tcResult} tool calls`);
        }
      }
    }
    if (!toolCalls) {
      console.log('Tool calls unaffected. Use --tool-calls to also prune tool call data.');
    }
    console.log('Sessions and daily_summary retained for historical stats.');
  }
}
