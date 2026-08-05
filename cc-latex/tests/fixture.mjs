// Pinned texcount 3.1.1 output, captured from a real fixture project
// (main.tex with \section{Abstract} + \section{Aim}, intro.tex \input'd).
// Run with: texcount -inc -sum -sub=section main.tex

export const FIXTURE = `File: main.tex
Encoding: ascii
Sum count: 17
Words in text: 15
Words in headers: 2
Words outside text (captions, etc.): 0
Number of headers: 2
Number of floats/tables/figures: 0
Number of math inlines: 0
Number of math displayed: 0
Subcounts:
  text+headers+captions (#headers/#floats/#inlines/#displayed)
  7+1+0 (1/0/0/0) Section: Abstract
  8+1+0 (1/0/0/0) Section: Aim

Included file: ./intro.tex
Encoding: ascii
Sum count: 14
Words in text: 9
Words in headers: 1
Words outside text (captions, etc.): 4
Number of headers: 1
Number of floats/tables/figures: 0
Number of math inlines: 0
Number of math displayed: 0

Sum of files: main.tex
File(s) total: main.tex
Sum count: 31
Words in text: 24
Words in headers: 3
Words outside text (captions, etc.): 4
Number of headers: 3
Number of floats/tables/figures: 0
Number of math inlines: 0
Number of math displayed: 0
Files: 2
Subcounts:
  text+headers+captions (#headers/#floats/#inlines/#displayed)
  15+2+0 (2/0/0/0) File: main.tex
  9+1+4 (1/0/0/0) Included file: ./intro.tex
`;

// Expected parse of FIXTURE: per-section sum = text + headers + captions;
// grand total = last "Sum count" line (the "Sum of files" block).
export const EXPECTED_SECTIONS = [
  { name: 'Abstract', text: 7, headers: 1, captions: 0, sum: 8 },
  { name: 'Aim', text: 8, headers: 1, captions: 0, sum: 9 },
];
export const EXPECTED_TOTAL = 31;

// Chapter-style document (report class, \input'd sections): texcount emits NO
// "Section:" subcounts; the breakdown comes from the trailing per-file summary.
// Trimmed from real texcount 3.1.1 output on the year_1 report (12 files, 7733 words).
export const CHAPTER_FIXTURE = `File: main.tex
Encoding: ascii
Sum count: 0
Words in text: 0
Words in headers: 0
Words outside text (captions, etc.): 0
Number of headers: 0
Number of floats/tables/figures: 0
Number of math inlines: 0
Number of math displayed: 0

Included file: ./Sections/1-abstract.tex
Encoding: ascii
Sum count: 198
Words in text: 197
Words in headers: 1
Words outside text (captions, etc.): 0
Number of headers: 1
Number of floats/tables/figures: 0
Number of math inlines: 0
Number of math displayed: 0

Sum of files: main.tex
File(s) total: main.tex
Sum count: 7733
Words in text: 7013
Words in headers: 181
Words outside text (captions, etc.): 271
Number of headers: 42
Number of floats/tables/figures: 18
Number of math inlines: 242
Number of math displayed: 26
Files: 12
Subcounts:
  text+headers+captions (#headers/#floats/#inlines/#displayed)
  197+1+0 (1/0/0/0) Included file: ./Sections/1-abstract.tex
  317+3+0 (1/0/0/0) Included file: ./Sections/2-aim_objectives.tex
  90+1+0 (1/0/1/0) Included file: ./Sections/4-methodology.tex
`;

// Per-file sum mirrors texcount's "Sum count" = text + headers + captions + math
// (inlines + displayed) — the rows then add up to the grand total exactly.
export const EXPECTED_CHAPTER_SECTIONS = [
  { name: 'Sections/1-abstract.tex', text: 197, headers: 1, captions: 0, sum: 198 },
  { name: 'Sections/2-aim_objectives.tex', text: 317, headers: 3, captions: 0, sum: 320 },
  { name: 'Sections/4-methodology.tex', text: 90, headers: 1, captions: 0, sum: 92 },
];
export const EXPECTED_CHAPTER_TOTAL = 7733;
