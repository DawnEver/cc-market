<!-- Field source "music-information-retrieval" (knowledge/fields/music-information-retrieval). Migrated from skills/latex/reference/fields/music-information-retrieval.md; old rule numbers replaced by rule ids. -->

# Moves per section

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
