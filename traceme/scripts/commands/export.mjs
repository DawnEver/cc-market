import { openDb, queryDailySummary } from '../db.mjs';
import { readMergedSnapshot } from '../sync.mjs';

export function cmdExport(args, parseRange, getFlag, parseDate) {
  openDb();
  const asCsv = args.includes('--csv');
  const local = args.includes('--local');
  const project = getFlag(args, '--project');
  const range = parseRange(args);

  let rows;
  if (range) {
    rows = [];
    const from = new Date(range.from + 'T00:00:00');
    const to = new Date(range.to + 'T00:00:00');
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      if (local) {
        rows.push(...queryDailySummary(dateStr));
      } else {
        const merged = readMergedSnapshot(dateStr);
        if (merged) {
          rows.push(...merged.daily_summary.map(r => ({ date: dateStr, project: r.project, repo_origin: r.repo_origin, session_count: r.session_count, prompt_count: r.prompt_count, total_tokens: r.total_tokens, total_cost: r.total_cost })));
        } else {
          rows.push(...queryDailySummary(dateStr));
        }
      }
    }
  } else {
    const date = parseDate(args[1]);
    if (local) {
      rows = queryDailySummary(date);
    } else {
      const merged = readMergedSnapshot(date);
      rows = merged
        ? merged.daily_summary.map(r => ({ date, project: r.project, repo_origin: r.repo_origin, session_count: r.session_count, prompt_count: r.prompt_count, total_tokens: r.total_tokens, total_cost: r.total_cost }))
        : queryDailySummary(date);
    }
  }

  if (project) {
    const lower = project.toLowerCase();
    rows = rows.filter(r => r.project.toLowerCase().includes(lower));
  }

  if (asCsv) {
    console.log('date,project,repo_origin,sessions,prompts,tokens,cost');
    for (const r of rows) {
      console.log(`${r.date},${r.project},${r.repo_origin || ''},${r.session_count},${r.prompt_count},${r.total_tokens},${r.total_cost}`);
    }
  } else {
    console.log(JSON.stringify(rows, null, 2));
  }
}
