// shared/attention.mjs — the attention gate.
//
// A consumer-aware router for skill escalations. Its job is to protect the
// scarce resource on the receiving end:
//   - human consumer → spend the least attention: apply safe defaults silently,
//     compress + coalesce only the decisions that truly need a person into one
//     AskUserQuestion prompt.
//   - ai consumer   → there is no scarce attention to protect, so never prompt:
//     resolve by policy (apply defaults), and defer (leave OPEN + log) anything
//     irreversible/ambiguous with no safe default, instead of blocking.
//
// Dependency-free, pure functions (timestamps passed in, no internal clock) so
// the same module is bundled into every plugin and stays deterministic in tests.

// An escalation item a skill produces:
//   { id, title, detail?, kind?, stakes: 'HIGH'|'MEDIUM'|'LOW',
//     reversible: boolean, default: value|null,
//     options: [{ label, value, consequence? }] }

const MAX_QUESTIONS = 4; // Claude Code AskUserQuestion hard cap
const STAKE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Decide who is on the receiving end. Override always wins. */
export function detectConsumer({ override, headless } = {}) {
  if (override === 'ai' || override === 'human') return override;
  return headless ? 'ai' : 'human';
}

/** Compress one item into the standard human-facing attention payload. */
export function compress(item) {
  const hasDefault = item.default !== null && item.default !== undefined;
  return {
    id: item.id,
    headline: item.title,
    mustKnow: item.detail || item.title,
    decision: item.kind ? `${item.kind}: ${item.title}` : item.title,
    options: item.options || [],
    consequenceIfIgnored: item.reversible
      ? 'Reversible — can be undone later.'
      : 'Irreversible — cannot be cheaply undone.',
    defaultIfIgnored: hasDefault ? item.default : null,
    reversible: !!item.reversible,
    stakes: item.stakes || 'MEDIUM',
  };
}

/**
 * Split items into those a human must decide vs those safe to auto-default.
 * autoDefault = reversible AND has a default AND not HIGH stakes.
 */
export function classify(items = []) {
  const mustDecide = [], autoDefault = [];
  for (const it of items) {
    const hasDefault = it.default !== null && it.default !== undefined;
    const safe = it.reversible && hasDefault && (it.stakes || 'MEDIUM') !== 'HIGH';
    (safe ? autoDefault : mustDecide).push(it);
  }
  return { mustDecide, autoDefault };
}

function byStakesDesc(a, b) {
  return (STAKE_RANK[b.stakes] || 2) - (STAKE_RANK[a.stakes] || 2);
}

/** Build one coalesced AskUserQuestion payload from up to MAX_QUESTIONS items. */
function buildPrompt(items) {
  return {
    questions: items.map((it) => {
      const c = compress(it);
      const tail = c.defaultIfIgnored != null
        ? ` (default if ignored: ${c.defaultIfIgnored})`
        : ` (${c.consequenceIfIgnored})`;
      return {
        question: `${c.mustKnow}${tail}`,
        header: (it.kind || 'Decide').slice(0, 12),
        multiSelect: false,
        options: (it.options || []).map((o) => ({
          label: o.label,
          description: o.consequence || `${c.stakes} stakes — ${c.consequenceIfIgnored}`,
        })),
      };
    }),
  };
}

/**
 * Route escalations to the right place for the consumer.
 *   human → { consumer, applied[], prompt|null, overflow[] }
 *   ai    → { consumer, applied[], deferred[], prompt: null }
 */
export function route(items = [], { consumer = 'human' } = {}) {
  const { mustDecide, autoDefault } = classify(items);
  const applied = autoDefault.map((it) => ({ id: it.id, value: it.default, via: 'default' }));

  if (consumer === 'ai') {
    const deferred = [];
    for (const it of mustDecide) {
      const hasDefault = it.default !== null && it.default !== undefined;
      if (hasDefault) applied.push({ id: it.id, value: it.default, via: 'policy' });
      else deferred.push({ id: it.id, reason: 'irreversible/ambiguous, no safe default — deferred (left OPEN, logged)' });
    }
    return { consumer: 'ai', applied, deferred, prompt: null };
  }

  // human: surface highest-stakes decisions first, overflow the rest.
  const ordered = [...mustDecide].sort(byStakesDesc);
  const shown = ordered.slice(0, MAX_QUESTIONS);
  const overflow = ordered.slice(MAX_QUESTIONS).map((it) => ({ id: it.id, title: it.title }));
  return {
    consumer: 'human',
    applied,
    prompt: shown.length ? buildPrompt(shown) : null,
    overflow,
  };
}
