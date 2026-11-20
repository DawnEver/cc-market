# Published writing guidance: sources and proposed stricter rules

Rules P1-P24 extend `writing-style.md` (rule 39 makes them binding). The rule set may only become
stricter (user ruling 2026-11-18): each rule below adds a constraint or tightens an existing rule, and
where a P-rule tightens rule N, the P-rule wins. Guidance that would relax a rule is listed in section 3
and does not apply.

## 1. Sources (accessed 2026-11-18)

| # | Guide | Author / publisher | URL | Access note |
|---|-------|--------------------|-----|-------------|
| S1 | Preparation of Papers for IEEE Transactions and Journals (Feb. 2017 template) | IEEE | https://www.itm.iit.edu/data/IEEE-Transactions-instructions-only.pdf | Full text read (mirror of the IEEE template) |
| S2 | Ten simple rules for structuring papers | B. Mensh, K. Kording, PLoS Comput. Biol. 13(9):e1005619, 2017 | https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1005619 | Full text read |
| S3 | The Science of Scientific Writing | G. Gopen, J. Swan, American Scientist 78(6), 1990 | https://wstomv.win.tue.nl/quotes/science-of-scientific-writing.html (quote compilation by T. Verhoeff) | Original at americanscientist.org returned HTTP 503; only the quote compilation (with original section headings) was read |
| S5 | IEEE Editorial Style Manual for Authors, V 08.19.2020 | IEEE | https://lib.hmu.gr/wp-content/uploads/2021/03/IEEE-.pdf (mirror; official page: https://journals.ieeeauthorcenter.ieee.org/your-role-in-article-production/ieee-editorial-style-manual/) | Full text read |
| S4 | Writing Technical Articles | H. Schulzrinne, Columbia University | https://www.cs.columbia.edu/~hgs/etc/writing-style.html | Full page read |

Not accessed: IEEE Author Center "Improve your writing" page (HTTP 404); the original Gopen and Swan
article (S3 rests on a quote compilation); Whitesides, Schimel, Strunk & White, Nature/Springer guidance (not reached
in this pass). No point below relies on them.

## 2. Proposed rules

**P1. Subject meets its verb at once.** Place the verb directly after the grammatical subject; move any
modifier longer than a few words out of the gap or into its own sentence.
Source: S3, "Subject-Verb Separation" and structural principle 1. TIGHTENS rule 36(b) (which bans
wedged phrases and appositives; P1 also bans long pre-verb modifiers and long subjects).
Bad: "The loss in the magnets of the rotor under switching excitation rises." Good: "Switching
excitation raises the rotor magnet loss."

**P2. New information goes in the stress position.** End each sentence on the fact the reader should
remember; do not end on a citation-free qualifier, a condition or an operating detail.
Source: S3, "The Stress Position", principle 2. NEW.
Bad: "The xy current doubles, at least for the cases studied here." Good: "In the studied cases, the
xy current doubles."

**P3. Old information in the topic position.** Open each sentence with the concept the previous
sentence ended on (or the actor whose story it continues); new terms never appear in the first words.
Source: S3, "The Topic Position", "Perceiving Logical Gaps", principles 3-4. TIGHTENS rules 10 and 32
(position of the link fixed at the sentence opening, not anywhere in the sentence).
Bad: "... raises the xy current. Copper loss rises with the xy current." Good: "... raises the xy
current. This current adds copper loss."

**P4. Action in the verb.** Express each clause's action as its main verb, never as a noun with "is
done", "occurs", "takes place", "results in".
Source: S3, "Locating the Action", principle 5. TIGHTENS rule 36(e) (covers objects and predicates, not
only subjects).
Bad: "A reduction of the ripple occurs with the shift." Good: "The shift reduces the ripple."

**P5. Context before the new.** Introduce the frame (quantity, plane, condition) before the item it
frames, within a sentence and within a paragraph.
Source: S3, principle 6; S2, rule 3 (context-content-conclusion). TIGHTENS rule 18 (applied to every
paragraph, not only abstract, introduction and conclusion).

**P6. Every paragraph runs context-content-conclusion.** The first sentence sets the question the
paragraph answers; the last sentence states the answer. A results paragraph without a closing answer is
incomplete.
Source: S2, rules 3 and 7. TIGHTENS rule 25 (causal close moves from section to paragraph level).
Bad: paragraph ends on "Fig. 5 shows the spectra." Good: ends on "Hence the second carrier group
carries most of the magnet loss."

**P7. One subject, one place.** Treat each topic in a single contiguous passage; do not return to it
later in the section (no zig-zag). Parallel points take parallel grammatical form.
Source: S2, rule 4. NEW (rule 36(d) bans template-mirrored pairs; P7 requires parallel form only for
genuinely parallel items in one list, and bans scattering one topic).

**P8. One central message, stated in the title.** Fix the single message before drafting; the title
states it, and every section is checked against it.
Source: S2, rule 1. NEW.
Bad: "Analysis of losses in a fan motor." Good: "Bearing currents set the insulation life of
inverter-fed fan motors."

**P9. Declarative results headings and figure titles.** Results subsection headings and the first
sentence of each data-figure caption state the finding; method details follow in the caption.
Source: S2, rule 7; S1, Fig. 1 caption note (state the figure's significance in the caption). NEW.
Bad: "Fig. 6. Magnet loss versus M." Good: "Fig. 6. Magnet loss peaks near M = 0.6."

**P10. Abstract format limits.** One paragraph, 150-250 words, no displayed equations, no tables, no
footnotes, no citations, no abbreviations except IEEE, SI, ac, dc. Do not repeat the same keyword phrase
excessively.
Source: S1, abstract text; S5, "Abstract" and II (one paragraph, 150-250 words); S4, "Abstract". NEW (rule 18 governs order, not format).

**P11. Abstract order: gap before results.** No result appears before the gap sentence; the closing
sentence returns to broad relevance (broad-narrow-broad).
Source: S2, rule 5. TIGHTENS rule 18.

**P12. Abbreviations: define at first use in the body even if defined in the abstract; none in the
title unless unavoidable; minimise their number.**
Source: S1, II-A "Abbreviations and Acronyms"; S2, rule 2 (avoid abbreviations). NEW.
Bad: body first uses "VSD" relying on the abstract. Good: "vector space decomposition (VSD) [x]" at
first body use.

**P13. Symbols defined at the equation.** Define every symbol in an equation before it or immediately
after it ("where ..."); italicise variables, set descriptive subscripts upright ($P_\mathrm{mag}$).
Punctuate equations as parts of the sentence.
Source: S1, III-A "Equations"; S4, "LaTeX". TIGHTENS rule 12.

**P14. Equation and figure references in IEEE form.** Write "(1)", not "Eq. (1)" or "equation (1)",
except "Equation (1)" at a sentence start; write "Fig. 3" even at a sentence start; never abbreviate
"Table"; refer to "[3]" not "Ref. [3]" except at a sentence start.
Source: S1, III-A, VI-K, "References"; S5, "Text Citation of Figures and Tables", "References", Math
item 13. NEW.

**P15. Numbers and units.** Leading zero before decimals ("0.25"); ranges "7 to 9" or "7-9"; SI
primary units, never mixed within one equation; "data" takes a plural verb.
Source: S1, II-B and IV-V; S5, "Grammar" (data always plural) and en-dash rules. A range opened by
"from" uses "to", never a dash ("from 5 to 50"). NEW.

**P16. Word choice from the IEEE common-mistakes list.** "alternatively" not "alternately"; never
"essentially" for "approximately"; never "issue" for "problem"; distinguish "imply"/"infer",
"affect"/"effect"; no period after "et"; no contractions; serial comma.
Source: S1, II-B and V "Some Common Mistakes". NEW.

**P17. No dangling modifiers.** An opening participle phrase must have the sentence subject as its
actor.
Source: S1, II-B. TIGHTENS rule 33.
Bad: "Using (1), the loss was computed." Good: "Equation (1) gives the loss."

**P18. Axis labels use words plus units in parentheses.** Label axes with the quantity name and symbol
("Magnet loss $P_\mathrm{m}$ (W)"); never a unit alone, a ratio "P/W", or a "x 1000" multiplier;
figure text 8-10 pt.
Source: S1, VI-I-1 "Figure axis labels". TIGHTENS rule 30. Note: rule 14's square brackets apply to
tables; IEEE asks for parentheses on axes.

**P19. Footnotes avoided.** Integrate footnote content into the text.
Source: S1, footnote 1 in "References and Footnotes". NEW.

**P20. Conclusion does not replicate the abstract.** The conclusion may restate main points but never
repeats abstract sentences; the introduction likewise does not repeat the abstract.
Source: S1, VII "Conclusion"; S4, "Introduction". NEW.

**P21. No generic title words.** Do not put "novel", "analysis of", "study on" in a title; use specific
descriptors.
Source: S4, "Title". NEW (consistent with rule 23).

**P22. Graphs explain their features.** Every unusual feature in a plotted curve (a kink, a peak, an
outlier) is explained in the text or caption; describe the relationship behind a trend, not only its
direction.
Source: S4, "Numerical Results and Simulations". NEW.

**P23. Reproducible results.** State every parameter needed to repeat a simulation (inputs, step,
solver settings, sample count) in the method or a table.
Source: S1, X "Publication Principles" item 4; S4, "Numerical Results". NEW.

**P24. Citation and caption forms.** Cite a part of a source as "[1, Fig. 2]", "[1, eq. (8)]", "[1, Sec.
IV]", never "Fig. 2 of [1]". Do not put an author's name before a citation number ("Smith [1]") unless
the name is needed for the sentence, and never a year as an identifier. Do not open a figure or table
caption with "A", "An" or "The"; capitalise its first word.
Source: S5, "References", "Text Citation of Figures and Tables". NEW.
Bad: "Fig. 3. The measured loss." Good: "Fig. 3. Measured loss versus switching frequency."

## 3. Considered and rejected (would relax a rule)

- First person "I/we" allowed (S1, II-B) - relaxes the impersonal "this paper" practice of rule 17.
- "Use whereas instead of while" (S1, V) - conflicts with the "no whereas" part of rule 33.
- "However" as contrast marker (implied in S3 examples) - project bans it; rule 36(a)'s "however" is not widened.
- Contribution lists in the introduction (S4, "Introduction") - relaxes rules 7 and 23.
- "Vary how you refer to sections" (S4) - conflicts with rule 4 (one canonical term).
- Abstract "avoid in this paper" (S4) - conflicts with rule 17.
- Explicit motivation "three reasons is enough" (S4) - would license enumerated reasons (rule 7).
- Writing order "results first, abstract last" (S4) - process advice, adds no constraint.
