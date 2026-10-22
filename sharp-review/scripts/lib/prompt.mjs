// prompt.mjs — render a reviewer prompt from the method's templates (method.json `template`).
// Pure apart from the method's own template reader.

export function renderTemplate(text, vars, method) {
  const t = method.template;
  const value = (v) => (v === undefined || v === null ? t.missing : Array.isArray(v) ? v.join(t.list_join) : String(v));
  let out = text.replace(/\{\{(\w+)\}\}/g, (_, name) => value(vars[name]));
  if (t.collapse_blank_lines) out = out.replace(/\n{3,}/g, '\n\n');
  return t.trim ? out.trim() : out;
}

// The context entry for a profile on a manifest: the manifest mode's entry, else `any`.
export function contextEntry(profile, manifest, method) {
  const ctx = method.contexts[profile.context];
  if (!ctx) throw new Error(`profile ${profile.key} names unknown context ${profile.context}`);
  const entry = ctx[manifest.mode] ?? ctx.any;
  if (!entry) throw new Error(`context ${profile.context} declares no entry for manifest mode ${manifest.mode}`);
  return entry;
}

// method.json principles.list_item, once per principles.json entry, one per line.
export function principleList(method) {
  return method.principleList.map((p) => renderTemplate(method.principles.list_item, p, method)).join('\n');
}

// -> { status } when the context skips this manifest, else { call_mode, prompt }.
export function renderReviewerPrompt(profile, manifest, method) {
  const entry = contextEntry(profile, manifest, method);
  if (entry.status) return { status: entry.status };
  const partials = {};
  const partialVars = { finding_schema: JSON.stringify(method.promptSchema), principle_list: principleList(method) };
  for (const [name, rel] of Object.entries(method.template.partials)) {
    partials[name] = renderTemplate(method.readTemplate(rel), partialVars, method);
  }
  const vars = {
    ...partials,
    framing: profile.framing,
    scope: profile.scope,
    range: manifest.range,
    excluded_summary: manifest.excludedSummary,
    diff: manifest.diff,
    manifest: manifest.manifestText,
  };
  return { call_mode: entry.call_mode, prompt: renderTemplate(method.readTemplate(entry.template), vars, method) };
}
