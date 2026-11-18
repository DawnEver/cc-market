# Field writing profile: music information retrieval and machine learning for audio

Scope: conference and preprint papers on transcription, datasets and audio models (ISMIR, ICASSP, DAFx, SMC, arXiv ML style).

**Corpus.** 11 distinct documents read (12 full texts, one a duplicate index of a DAFx paper), plus 3 deep-reading notes;
the second review folder (multitrack MIDI / scores) holds notes only. Venues: ISMIR (1), ICASSP-format (4), SMC (1),
DAFx late-breaking (1), IEEE regional conference (1), GI Informatik (1), PhD thesis (1), arXiv preprint (1). Years 2017-2026.
All papers come from one sub-topic (guitar tablature transcription) and are mostly short (4-8 pages). **The corpus is
small and narrow: section-move frequencies and conventions are tentative**, and ML-heavy venues (NeurIPS-style audio
papers, TASLP journal articles) are not represented.

Exemplary papers (models of good writing):
- Cwitkowitz et al. 2023, ICASSP (FretNet) -- tight problem-to-formulation chain; clean ablation narrative.
- Cwitkowitz, Driedger, Duan 2022, SMC -- gap from a concrete observation about the output layer; restrained claims.
- Zang et al. 2024, ICASSP (SynthTab) -- data-scarcity gap built step by step; cross-dataset results tied to the claim.
- Loth et al. 2025, ISMIR (GOAT) -- explicit hypotheses tested in results; ethics statement; dataset statistics.
- Pedroza et al. 2024, DAFx LBR -- compact abstract; hypothesis stated in the introduction; numbered contributions.
- Pedroza et al. 2025, ICASSP-format (Guitar-TECHS) -- two-fold evaluation (in-domain, out-of-domain) stated up front.

## 1. Moves per section

**Abstract** (one paragraph, 120-200 words; always present):
1. Task and its value to a community (education, musicology) -- 10/11.
2. Obstacle: data scarcity, instrument ambiguity, or limits of prior systems -- 10/11.
3. "In this paper/work, we present/propose X" with one-line mechanism -- 11/11.
4. Evaluation set-up in one clause (datasets, baseline) -- 7/11.
5. Result: qualitative direction ("improves", "competitive with") in most; explicit numbers in 3/11.
6. Outlook or value statement ("opens possibilities", "valuable resource") -- 5/11.
Index Terms / keywords follow the abstract in all IEEE-format papers.

**Introduction** (0.75-1.5 columns):
1. Define the umbrella task (AMT, MIR) with a survey citation -- nearly all.
2. Narrow to the instrument-specific task and what makes it special (string/fret ambiguity, techniques) -- all.
3. Motivate with users or applications -- most.
4. Gap: lack of large annotated data, overfitting, missing expressive annotations, quantised pitch -- all.
5. Proposal paragraph: "we propose/present", often naming the system or dataset with an acronym -- all.
6. Contributions: numbered or "(1) ... (2) ..." inline list in about half; hypotheses (H1, H2) in 2/11.
7. Code/dataset release with link or footnote -- about half (dataset papers always).
A roadmap paragraph is rare in short papers (absent in most 4-page ICASSP papers).

**Related work** ("Related Work", "Relation to Prior Work", or folded into the introduction):
organised by sub-problem (datasets; transcription models; technique detection). Each item gets one sentence
naming the authors' system and what it adds, ending with "we build on this by ..." or a limitation. Absent as a
separate section in about half of the short papers.

**Method**: problem formulation (input representation, output targets, notation) -> architecture with a figure ->
loss/objective in display equations -> training details (optimiser, learning rate, iterations) often moved into the
experimental set-up. Dataset papers replace this with "Data collection process" and annotation pipeline.

**Experiments / datasets / metrics**: opens with the evaluation purpose ("To evaluate X, we ..."); datasets each
described by size (hours, tracks), content, annotation source and split; metrics named with citations to standard
toolkits (mir_eval) and precise definitions only for new metrics; baseline named (usually a widely used open model).
Cross-validation scheme stated explicitly; cross-dataset or out-of-domain test as the robustness evidence.

**Results**: Table of precision/recall/F1 per metric family with best values in bold; prose walks the table:
overall comparison first, then the notable gaps, then the ablation ordering, then a qualitative figure
(piano-roll or tablature example). Explanations are hedged ("likely due to", "could be due to").

**Conclusion** (one paragraph, 80-150 words): restate what was proposed (past/present perfect), the key
qualitative finding, and future work; often an ethics statement (ISMIR) and acknowledgments.

## 2. Sentence templates

Every template obeys rules 1-37: one claim each, no relative clauses or tails, contrasts split, "this paper" as the
only self-reference, passive or a concrete subject for procedures.

Abstract
- [Task] is [an important / a widely studied] problem in [field], with uses in [application A] and [application B].
- Progress on [task] is limited by [obstacle], because [cause].
- Existing [systems/datasets] [omit X / hold only [size] of annotated data].
- This paper [proposes / presents] [name], a [type] with [core mechanism].
- [Name] is evaluated on [dataset(s)] against [baseline].
- [Intervention] [raises / matches] [metric family] relative to [baseline].
- [Name] reaches [value] [metric] on [test set], compared with [value] for [baseline].

Introduction
- [Umbrella task] estimates [target] from [input] [cite survey].
- [Specific task] additionally requires [extra output], because [instrument property].
- [User group] apply this extra information to [use of the output].
- Results on [specific task] trail those on [sister task], mainly owing to [obstacle].
- Datasets with [annotation type], such as [D1] and [D2], contain only [size].
- This paper tests the hypothesis of [factor] improving [property] of [model class].
- This paper provides [artefact] and [method] for [task].
- The [dataset/code] is released at [URL] under [licence].

Related work
- [Author] et al. [cite] introduced [system] with [key idea].
- [Approach family] [raises X] on [condition] [cite].
- In contrast, [metric Y] of [approach family] drops on [condition relevant to this paper].
- This paper extends [prior system] by [change].

Method
- For [input representation] of [length], the network outputs [output] for each [frame/string].
- [Component] is reformulated as [new formulation] to enforce [property].
- The [loss] penalises [event], weighted by [quantity estimated from data].
- [Component] follows [prior work] [cite] except for [difference].

Experiments
- To evaluate [claim], [model] is trained on [data] and tested on [held-out data].
- [Dataset] [cite] comprises [size] of [content] with [procedure] annotations.
- Following [cite], the data are split by [player/session] for [k]-fold cross-validation.
- [Metric list] are computed with [toolkit] [cite] at [frame/note] level.
- [Model] is trained with [optimiser] at a learning rate of [value] for [iterations].
- In the ablation, one design choice is changed at a time: [list].

Results
- [Model] scores highest on [metric] in Table [n].
- [Model A] and [Model B] score within [value] points of each other on [in-domain set].
- In contrast, on [out-of-domain set] [Model A] exceeds [Model B] by [value] points.
- Without [component], [metric] falls by [value] points.
- The gain comes mainly from [recall/precision].
- This difference is likely due to [cause].

Conclusion
- This paper [presented / proposed] [name] for [task].
- [Intervention] [improved / did not change] [property], in particular on [condition].
- Future work concerns [extension to X / parameter Y / tests on Z].

## 3. Conventions

Descriptive counts of field practice; a habit marked "(avoid: rule N)" is looser than cc-latex and is not adopted.

- **Self-reference**: first person plural throughout, also by single authors (avoid: rule 17); "this paper" and
  "this work" alternate freely (avoid: rule 17). Passive voice appears in dataset descriptions.
- **Tense**: present for the method and what tables show; past for experiments run; present perfect in conclusions.
- **Contribution bullets**: numbered lists or inline "(1) ... (2) ..." in about half the papers (avoid: rules 7, 24);
  dataset papers list artefacts (dataset, augmentation strategy, baseline results).
- **Hedging**: moderate; "likely", "could be due to", "preliminary results", stated hypotheses. Novelty claims with
  "to the best of our knowledge, the first ..." (3/11) and "first large-scale ..." (avoid: rule 23).
- **Gap statements**: almost always data scarcity or a missing output dimension (techniques, strings, continuous
  pitch), stated as limitation of existing datasets/systems, often opened with "However," (avoid: project ruling,
  rule 36).
- **Metrics and baselines**: precision, recall, F1 at frame and note level; tablature-specific metrics (TDR, abbreviated:
  avoid: rule 14 in tables); baseline is a public reference model; percentages or 0-1 values with bold best;
  mean +/- std over seeds only in the newest papers; significance tests rare.
- **Ablations**: one design choice removed or swapped at a time, reported in the main table and ranked in prose.
- **Dataset description**: hours, number of tracks/players, recording hardware, annotation procedure, split, licence;
  summary table and distribution figures (pitch, tempo, technique counts).
- **Numbers in abstract**: mostly absent in ICASSP/ISMIR abstracts (direction only); present in dataset sizes
  ("5.9 hours") and in the less disciplined papers (long numeric abstracts; avoid: rule 15).
- **Acronyms**: heavy (AMT, MIR, MPE, GTT, AGT); systems and datasets get a capitalised acronym name (avoid acronyms
  for descriptive coinages: rule 16).
- **Reproducibility**: code and data links in footnotes; ISMIR adds an ethics statement.

## 4. Field habits looser than cc-latex (avoid; the rule holds, rule 38)

- Rule 7 / 24: numbered contribution lists in the introduction are a field norm; a separate section roadmap is
  usually absent in short papers.
- Rule 15 vs. abstract numbers: field abstracts state direction only, matching rule 15, but dataset sizes are given
  in the abstract; the project-specific "numbers in abstract" ruling diverges from field habit.
- Rule 17: "this work" and "this paper" alternate; "we" is pervasive.
- Rule 23: announced novelty ("to the best of our knowledge, the first", named acronym systems) is common.
- Rule 31 / 26: "the model learns", "the dataset offers", "the system fails to detect" -- human verbs for models
  and datasets are standard field idiom.
- Rules 29 / 31 / 36: ", which ..." tails, relative clauses on nouns and "while/although" contrasts are frequent.
- Rule 16: coined system and dataset names are expected; rule 16 targets descriptive coinages, not proper names.
- Rule 36(a) and the project's "no However" ruling: "However," is the dominant gap marker.
- Rule 6: trends stated as achievements ("has advanced considerably"), not progressive voice.
- Rule 19: authors define AMT, tablature and MIDI at length because the readership is mixed (ML and music).
- Rule 14: tables abbreviate metric names (P, R, F1, TDR) with a legend; full names would not fit two-column pages.

## 5. Weak patterns to avoid

- Promotional verbs and adjectives ("revolutionize", "meticulously annotated", "comprehensive solution",
  "unprecedented accuracy").
- Novelty claims with no comparison ("surpasses existing approaches" without a table).
- Abstracts packed with every number, seed count and caveat; methodological history (a superseded evaluation)
  told inside the abstract.
- "Our paper employs / utilizes" -- the paper as agent of the method.
- Future-work sections listing speculative applications (AR/VR) unconnected to the results.
- Keyword lists of 10+ terms, including generic ones ("Deep Learning", "Fourier Transform").
- Shuffled frame-level splits reported as generalisation evidence; leakage between adjacent frames inflates scores.
- Conclusions that only promise more results ("work is ongoing") instead of stating a finding.
- Results prose that repeats every table cell instead of ranking and explaining the differences.
