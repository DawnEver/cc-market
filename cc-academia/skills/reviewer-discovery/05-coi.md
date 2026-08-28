# 05 — Conflict of interest

```bash
uv run --project "${CLAUDE_PLUGIN_ROOT}" rev-disc coi --slug <slug> \
  --exclude "Name One,Name Two" --json
```

`--exclude` is for names the editor already knows to keep out: an author's
declared non-preferred reviewers, or someone the editor has private reason to
exclude.

## No model participates in this step

The engine is deterministic. Every verdict carries the rule that produced it and
the evidence behind it, because an editor may have to justify a rejection and
"the model thought so" is not a justification.

## The three tiers

**BLOCK** — disqualifying.

| Rule | Meaning |
|------|---------|
| `manuscript_author` | the candidate is an author of the submission |
| `exclusion_list` | explicitly excluded |
| `recent_coauthor` | co-authored within the journal's window |
| `same_department` | same department as an author, currently |
| `same_phd_institution_overlap` | same doctoral institution in overlapping years |
| `advisor_advisee` | supervisor relationship, with direct evidence |

**REVIEW** — the editor's call.

| Rule | Meaning |
|------|---------|
| `same_institution` | same university, different department |
| `previous_institution_overlap` | shared a past institution |
| `dense_historic_collaboration` | many joint papers, all outside the window |
| `heavily_cited_by_manuscript` | the submission leans heavily on their work |

**CLEAR** — *no detected conflict*.

## Two things worth explaining if asked

A BLOCK removes the candidate; it does not deduct points. Blending "expertise 95,
conflict −20" into 75 is precisely how a disqualified reviewer ends up on a
shortlist.

Every rule runs even after the first BLOCK fires, so the audit trail is complete
rather than stopping at the first tripwire.

## Heavy citation is not disqualifying

It is flagged, not blocked. Being a field's reference point is often exactly what
makes someone the right reviewer. Show it and let the editor decide.

## Journal differences

The co-authorship window and the seniority floor come from the journal config.
The command prints which policy files were applied — quote them, so the basis of
each verdict is visible.
