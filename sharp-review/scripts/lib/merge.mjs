// merge.mjs — the method's reviewer-status rules and merge/id spec, executed.
// Input is a run record, output the findings JSON (method/findings-output.schema.json);
// method/conformance/merge pins the behaviour for every executor.

// The JSON Schema subset the method uses: object, required, type string | array (of items), enum.
function validValue(v, rule) {
  if (rule.type === 'string' && typeof v !== 'string') return false;
  if (rule.type === 'array' && !(Array.isArray(v) && v.every((x) => validValue(x, rule.items ?? {})))) return false;
  return !rule.enum || rule.enum.includes(v);
}

export function validFinding(f, schema) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  for (const k of schema.required) if (f[k] === undefined || f[k] === null) return false;
  for (const [k, rule] of Object.entries(schema.properties)) {
    if (f[k] !== undefined && !validValue(f[k], rule)) return false;
  }
  return true;
}

// method.reviewer_status.precedence, in order; the first rule that decides wins.
export function resolveStatus(reviewer, result, method) {
  return decide(reviewer, result, method).status;
}

function decide(reviewer, result, method) {
  const rs = method.reviewer_status;
  for (const rule of rs.precedence) {
    const [cond, outcome] = rule.split(':');
    switch (cond) {
      case 'planned_final':
        if (rs.planned_final.includes(reviewer.status)) return { status: reviewer.status, rule: cond };
        break;
      case 'missing_result':
        if (!result) return { status: outcome, rule: cond };
        break;
      case 'error_kind':
        if (result.error_kind) return { status: rs.failure_kinds.includes(result.error_kind) ? result.error_kind : 'unavailable', rule: cond };
        break;
      case 'placeholder_reply':
        if (typeof result.text === 'string' && rs.placeholder_replies.some((p) => new RegExp(p).test(result.text))) return { status: outcome, rule: cond };
        break;
      case 'findings_array':
        if (Array.isArray(result.findings)) return { status: outcome, rule: cond };
        break;
      case 'otherwise':
        return { status: outcome, rule: cond };
      default:
        throw new Error(`reviewer_status.precedence names unknown rule ${rule}`);
    }
  }
  throw new Error('reviewer_status.precedence decided nothing');
}

// method.reviewer_status.error: why a reviewer that is neither ok nor skipped has no findings --
// the recorded error text (copied, never a key), else the deciding rule's reason.
function errorText(status, rule, reviewer, result, method) {
  if (status === 'ok' || status === 'skipped') return undefined;
  const recorded = [result?.error, reviewer.error].find((e) => typeof e === 'string' && e.trim());
  if (recorded) return recorded;
  const reasons = method.reviewer_status.reasons;
  if (rule === 'planned_final') return reasons.planned_final[status];
  return reasons[rule].replace('{error_kind}', result?.error_kind ?? '');
}

// Truncation counts Unicode code points, so every executor cuts at the same character.
function dedupKey(f, spec) {
  return spec.fields.map((field) => {
    let v = f[field] ?? '';
    if (spec.lowercase) v = v.toLowerCase();
    return Array.from(v).slice(0, spec.truncate).join('');
  }).join(spec.join);
}

export function mergeRun(run, method) {
  const m = method.merge;
  const byName = new Map((run.results || []).map((r) => [r.name, r]));
  const reviewers = [];
  const groups = new Map();
  for (const rv of run.reviewers) {
    const result = byName.get(rv.name);
    const { status, rule } = decide(rv, result, method);
    let dropped = 0;
    if (status === 'ok') {
      for (const f of result.findings) {
        if (!validFinding(f, method.findingSchema)) { dropped++; continue; }
        const k = dedupKey(f, m.dedup_key);
        if (!groups.has(k)) groups.set(k, { primary: f, reviewers: [], union: Object.fromEntries(m.union.fields.map((u) => [u, []])) });
        const g = groups.get(k);
        for (const u of m.union.fields) for (const v of f[u] ?? []) if (!g.union[u].includes(v)) g.union[u].push(v);
        if (!g.reviewers.some((r) => r.name === rv.name)) g.reviewers.push({ name: rv.name, provider: rv.provider });
      }
    }
    const error = errorText(status, rule, rv, result, method);
    reviewers.push({ name: rv.name, provider: rv.provider, status, dropped_findings: dropped, ...(error === undefined ? {} : { error }) });
  }
  const date = run.date.replace(/-/g, '');
  let seq = m.id.seq_start;
  const findings = [];
  for (const { primary: p, reviewers: rvs, union } of groups.values()) {
    const value = (k) => p[k] ?? m.defaults[k];
    findings.push({
      id: [m.id.prefix, date, String(seq++).padStart(m.id.seq_width, '0')].join(m.id.separator),
      severity: value('severity'),
      file: value('file'),
      summary: value('summary'),
      category: value('category'),
      status: m.defaults.status,
      suggestion: value('suggestion'),
      detail: value('detail'),
      confidence: m.confidence.find((c) => rvs.length >= c.min_reviewers).label,
      reviewers: rvs,
      // merge.union: the group's values across every reviewer, first-seen; an empty union is omitted.
      ...Object.fromEntries(Object.entries(union).filter(([, vs]) => vs.length)),
    });
  }
  return { schema_version: method.schema_version, range: run.range, profiles: run.profiles, reviewers, findings };
}
