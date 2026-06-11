import { generateReport, generateRangeReport, generateStats } from '../report.mjs';

export function cmdReport(args, VERSION, parseRange, getFlag, parseDate) {
  const range = parseRange(args);
  const local = args.includes('--local');
  const asJson = args.includes('--json');
  const brief = args.includes('--brief');
  const project = getFlag(args, '--project');
  const date = parseDate(args[1]);

  if (range) {
    const rpt = generateRangeReport({ from: range.from, to: range.to, local, brief, project, json: asJson });
    console.log(rpt + (asJson ? '' : '\n' + `TraceMe ${VERSION}`));
  } else {
    console.log(generateReport(date, { local, json: asJson, brief, project }) + (asJson ? '' : `\nTraceMe ${VERSION}`));
  }
}

export function cmdStats(args, VERSION, getFlag) {
  const local = args.includes('--local');
  const project = getFlag(args, '--project');
  console.log(generateStats({ local, project }) + `\nTraceMe ${VERSION}`);
}
