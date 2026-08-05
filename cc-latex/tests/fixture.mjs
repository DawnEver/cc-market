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
