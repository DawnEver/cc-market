# knowledge/

The public knowledge base of cc-academia: how to write a manuscript, how to judge one, and how a venue handles a
submission. Plain TSV, Markdown and TOML, no code; the folder can move as one unit.

## Using it (read this first)

An agent never reads this folder directly. It loads only what the part it works on needs:

```shell
academia-write resolve --task write --scope <part>                   # rules to judge while writing <part>
academia-write resolve --task review --scope <part|manuscript> --applies self|peer --angle <angle>
academia-write explain <id>                                          # one rule, criterion or dimension in full
academia-write lint-prose | lint-table | check-data | check-figure | page-budget
```

- The index has one line per item an agent must judge (`id — first sentence`) plus the effective dimension values.
  Items checked by lint never enter it: a lint hit names its rule id and a one-line remedy.
- Every write combination stays within 25 items (`tests/check/test_disclosure.py`); a new item is paid for by a
  merge or by a move to lint.
- A paper selects its sources in `<paper>/.academia/profile.tsv` (`venue`, `field`, `preset`, project `dimension`
  values) beside `vocabulary.tsv`, `numbers.tsv`, `figures.tsv` and `decisions.md`.
- Workflow and hard constraints (author-led parts, approved text, figure approval, page budget) live in the
  `write` and `review` skills, not here.

The rest of this file is the model behind the index: read it to add or change knowledge.

## Model: three axes

**Source** (parallel; none overrides another; each fact belongs to exactly one source by its nature):

| Source | Folder | Holds |
|---|---|---|
| common | `common/` | language correctness, writing principles, general conventions and review criteria; every dimension definition; the venue-neutral policy `policy/coi.toml`; `lens-template.toml` |
| venue | `venues/<venue>/` | format requirements of one venue: `must` rules, dimension values, vocabulary; `policy/coi.toml` = the venue's overlay on the common policy |
| field | `fields/<field>/` | terms, section moves, phrasing, figure conventions and criteria of one research field; `lens.toml` = its reading lens |
| preset | `presets/<preset>/` | a named, reusable set of style choices: dimension values with evidence and recommended phrases (`phrase` vocabulary, never flagged); nothing else |
| project | `<paper>/.academia/` (never here) | facts and decisions of one paper |

**Object** (seven): prose, figure, table, data, equation, reference, caption; one folder per object a source speaks
about. **Policy** (`policy/`) is an area beside the objects: how a venue handles a submission (scope, conflicts of
interest, reviewer eligibility), read by the referee task and the review criteria. User overrides:
`ACADEMIA_CONFIG_DIR/coi.toml` and `journals/<slug>.toml`.

**Scope** (a column of rules, criteria and vocabulary): where in the manuscript an item applies. Tokens: `all`; the
parts `title`, `abstract`, `keywords`, `introduction`, `body` (every other section), `conclusion`; `caption`,
`prose` (text outside captions), `table`; the figure kinds `data-plot`, `schematic`, `multi-panel`;
`review-comment` (a referee report); `manuscript` (whole paper, review only). `!<token>` excludes one. `title`,
`keywords` and `review-comment` take only items naming them; other parts also take `all`.

## Five forms

| Form | File | Schema (tab-separated, header row) |
|---|---|---|
| rule | `<object>/rules.tsv` | `id content source kind scope check statement why good bad provenance`; kind = must, principle or process; check = `lint:<check>`, `reviewer` or `human` |
| dimension | `common/<object>/dimensions.tsv` | `id content options unset_default owner why`; options = comma list, `int:a-b`, `num:a-b`, `range` or `words` (a comma word list, or `none`); owner = the one source kind that sets the value |
| dimension value | `<owner source>/<object>/values.tsv` | `id value evidence`; evidence = a dated user ruling or a quoted published sentence |
| criterion | `<object or policy>/criteria.tsv` | `id content source scope angle applies question why provenance`; applies = `self` (`review own`), `peer` (`review submission`) or `both` |
| vocabulary | `<object>/vocabulary/*.tsv` | `term class replace when why source scope` |
| template | `<object>/templates/*.md` | recommended structure with `{dimension}` slots |

A rule says what the text must do; a criterion is a question a reviewer asks; self-review and peer review read
the same criteria. Vocabulary classes: forbidden, caution (with a `when` condition), canonical (term to
replacement), hyphenate, spelling, collocation, phrase (never flagged). A term is a literal phrase
(case-insensitive, word-bounded) or `/regex/flags`; a flagged entry's `why` starts with the rule id it enforces.
Machine-read `when` tokens: `sentence-start`, `before-noun`, `opener`, `opener-run`, `self-verb`, `pair`,
`to-british`, `to-american`, `keep`, `keep-ending`; other text is a condition shown to the writer. Data tables a
check needs sit beside their rules: `common/data/units.tsv`, `common/figure/palettes.tsv`.

## Jurisdiction (enforced by `../src/academia/knowledge/resolve.py`; every error names where the item belongs)

1. A row's `source` equals the kind of folder it sits in; its `content` equals the object folder.
2. A rule id is defined once; no source redefines or relaxes a common rule; correctness rules (`grammar.*`,
   `mech.*`) and spelling vocabulary belong to common.
3. A venue holds only `must` rules, dimension values and vocabulary.
4. A preset holds only dimension values and `phrase` vocabulary.
5. A dimension value sits in its owner's source, uses one of the options and has evidence; two sources of one kind
   disagreeing is an error; an unset dimension uses `unset_default` and reports say "default used".
6. A criterion id is defined once and never reuses a rule id.
7. Every `scope` token is a Scope token; every flagged vocabulary entry names an existing rule.

## Unpublished text

No source quotes an unpublished manuscript. An example drawn from one is a paraphrase in another technical setting
with invented numbers, marked `paraphrase; original withheld until publication`, so the original can be restored.

## Provenance

`MAPPING.tsv` maps every item of the pre-2.0 layout (writing-style rules, self-check lines, P1-P24, field-profile
sections, project writing.md bullets, old lint ids) to its current id or skill file, with the user decision that
placed it. `common/SOURCES.md` lists the published guides behind common and venue rules.
