import test from 'node:test';
import assert from 'node:assert/strict';
import { lint, sentences } from '../scripts/lint-prose.mjs';

const ids = (src) => lint(src, 't.tex').map(h => h.rule);

test('sentences skip floats and tokenise cites and maths', () => {
  const s = sentences('A loss $P_s$ rises~\\cite{a}.\nIt falls.\n\\begin{figure}\nNot prose.\n\\end{figure}\n');
  assert.deepEqual(s.map(x => x.text), ['A loss M rises~X.', 'It falls.']);
});

test('flags whereas, relative clauses and personified verbs', () => {
  const r = ids('The stator loss rises with the current amplitude, whereas the magnet loss falls slightly.\n'
    + 'The machine sees a much larger inductance in the torque plane than elsewhere.\n'
    + 'Machines that stay efficient over the drive cycle are increasingly required.\n');
  for (const id of ['33-whereas', '26-verb', '31-relative']) assert.ok(r.includes(id), id);
});

test('flags two phrase-plus-comma openings in a row, not one', () => {
  const one = 'Under PWM, the total loss rises by a clear margin.\nThe DC copper loss changes little at this point.\n';
  assert.ok(!ids(one).includes('33-openers'));
  const two = 'Under PWM, the total loss rises by a clear margin.\nIn contrast, the DC copper loss changes little.\n';
  assert.ok(ids(two).includes('33-openers'));
});

test('flags bare and long sentences', () => {
  const r = ids('These changes reverse.\n' + 'Long ' + 'word '.repeat(45).trim() + '.\n');
  assert.ok(r.includes('bare') && r.includes('length'));
});

// Rule 40: English variant.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spelling, findVariant, findOff } from '../scripts/lint-prose.mjs';

const words = (src, v) => spelling(src, v).map(h => `${h.word}>${h.suggest}`);

test('no variant declared: no spelling hits', () => {
  assert.ok(!lint('We analyze the color of the modeled fiber at the center of the rotor core.\n', 't.tex',
    {}).some(h => h.rule === '40-english'));
});

test('British variant flags American spellings with line and suggestion', () => {
  const h = spelling('First line here.\nWe analyze the color of the modeled fiber at the center.\n', 'british');
  assert.deepEqual(h.map(x => `${x.line}:${x.word}>${x.suggest}`),
    ['2:analyze>analyse', '2:color>colour', '2:modeled>modelled', '2:fiber>fibre', '2:center>centre']);
  const r = words('Normalization and optimized behavior. Gray analog toward the millimeters, '
    + 'labeled and traveled, canceled.\n', 'british');
  for (const w of ['Normalization>Normalisation', 'optimized>optimised', 'behavior>behaviour', 'Gray>Grey',
    'analog>analogue', 'toward>towards', 'millimeters>millimetres', 'labeled>labelled', 'traveled>travelled',
    'canceled>cancelled']) assert.ok(r.includes(w), w);
});

test('American variant flags British spellings', () => {
  const r = words('We analyse the colour of the modelled fibre at the centre, normalised towards '
    + 'the grey analogue programme of 3 metres.\n', 'american');
  for (const w of ['analyse>analyze', 'colour>color', 'modelled>modeled', 'fibre>fiber', 'centre>center',
    'normalised>normalized', 'towards>toward', 'grey>gray', 'analogue>analog', 'programme>program',
    'metres>meters']) assert.ok(r.includes(w), w);
});

test('exception words are never flagged', () => {
  assert.deepEqual(words('The size and prize seize the capsized maize; resized meshes.\n', 'british'), []);
  assert.deepEqual(words('We advise, exercise and comprise; a surprise revised the premise, '
    + 'otherwise precise noise rises and the analyses compromise.\n', 'american'), []);
});

test('LaTeX code, citations, comments and quotations are not prose', () => {
  const src = String.raw`\begin{center}\color{gray}\scriptsize
\usepackage[usenames]{xcolor}\definecolor{mygray}{gray}{0.5}
\includegraphics[width=\linewidth]{fig/color_center.pdf}
\draw[gray, fill=gray!20] (0,0) -- (1,1); \textcolor{gray}{Text}
  loss/.style={align=center, draw=gray}]
As shown~\cite{optimization_center} in Fig.~\ref{fig:color}\label{sec:behavior}. % the color center
The title reads ${'``'}Color Fiber Optimization''.
\end{center}
\[ x_{center} \] and $c_{color}$ hold.
\begin{equation}
  P_{behavior} = 0
\end{equation}`;
  assert.deepEqual(words(src, 'british'), []);
  assert.deepEqual(words(String.raw`\begin{thebibliography}{9}
\bibitem{a} A. B, Optimization of color.
\end{thebibliography}`, 'british'), []);
  assert.deepEqual(words(String.raw`\caption{The gray center line.}`, 'british'), ['gray>grey', 'center>centre']);
});

test('findVariant reads the project writing rules; lint reports 40-english', () => {
  const root = mkdtempSync(join(tmpdir(), 'lint-en-'));
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, 'Sections'));
  assert.equal(findVariant(join(root, 'Sections')), null);
  writeFileSync(join(root, '.claude', 'rules', 'writing.md'), '# Rules\n- English variant: British\n');
  assert.equal(findVariant(join(root, 'Sections')), 'british');
  const h = lint('The rotor color changes with the current amplitude at this point.\n', 't.tex',
    { english: 'british' }).filter(x => x.rule === '40-english');
  assert.equal(h.length, 1);
  assert.match(h[0].message, /color -> colour/);
});

test('off ids from the project rules or the caller suppress hits', () => {
  const root = mkdtempSync(join(tmpdir(), 'lint-off-'));
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  assert.deepEqual(findOff(root), []);
  writeFileSync(join(root, '.claude', 'rules', 'writing.md'), '- Tails allowed.\n    lint-prose off: 29-tail, 26-verb\n');
  assert.deepEqual(findOff(root), ['29-tail', '26-verb']);
  const src = 'The loss rises with the current amplitude, which heats the rotor core.\n';
  assert.ok(ids(src).includes('29-tail'));
  const r = lint(src, 't.tex', { off: ['29-tail'] }).map(h => h.rule);
  assert.ok(!r.includes('29-tail') && !r.includes('31-relative'));
});

test('--off and project off line work from the CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'lint-cli-'));
  const tex = join(root, 'a.tex');
  writeFileSync(tex, 'The loss rises with the current amplitude, which heats the rotor core.\n');
  const cli = fileURLToPath(new URL('../scripts/lint-prose.mjs', import.meta.url));
  const run = (...a) => spawnSync(process.execPath, [cli, tex, ...a], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout;
  assert.match(run(), /29-tail/);
  assert.doesNotMatch(run('--off', '29-tail,31-relative'), /29-tail|31-relative/);
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(root, '.claude', 'rules', 'writing.md'), 'lint-prose off: 29-tail\n');
  const out = run();
  assert.doesNotMatch(out, /29-tail/);
  assert.doesNotMatch(out, /31-relative/);
});

test('29-tail off: 31-relative skips ", which" but keeps that/who', () => {
  const rel = (src, off) => lint(src, 't.tex', { off }).filter(h => h.rule === '31-relative').length;
  const which = 'The loss rises with the current amplitude, which heats the rotor core.\n';
  assert.equal(rel(which, []), 1);
  assert.equal(rel(which, ['29-tail']), 0);
  assert.equal(rel('Machines that stay efficient over the drive cycle are increasingly required.\n', ['29-tail']), 1);
  assert.equal(rel('The loss rises with the current, which heats the core that carries the flux.\n', ['29-tail']), 1);
});

test('44-allocation flags split, share, portion and divide ... between in prose only', () => {
  const has = (src) => ids(src).includes('44-allocation');
  assert.ok(has('The loss is split between the two subspaces of the machine.\n'));
  assert.ok(has('The xy subspace takes a large share of the sideband voltage here.\n'));
  assert.ok(has('A small portion of the ripple current reaches the rotor magnets.\n'));
  assert.ok(has('The inverter divides the carrier harmonics between the two winding sets.\n'));
  assert.ok(has('Both winding sets share the second carrier group in the xy plane.\n'));
  assert.ok(!has('The sideband voltage is allocated to the alpha-beta and xy subspaces.\n'));
  assert.ok(!has('The loss distribution over the winding sets changes with the modulation index.\n'));
  assert.ok(!has('The figure \\label{fig:split-share} shows the loss distribution of the rotor magnets.\n'));
  assert.ok(!has('The loss rises with speed as \\cref{sec:portion} shows for the rotor magnets.\n'));
});

test('46-tense flags past tense for the paper inside the conclusion only', () => {
  const body = 'This paper analysed the PWM-induced loss of the dual three-phase machine.\n';
  assert.ok(!ids(`\\section{Results}\n${body}`).includes('46-tense'));
  assert.ok(ids(`\\section{Conclusion}\n${body}`).includes('46-tense'));
  assert.ok(ids(`\\section*{Conclusions}\n\\label{sec:c}\nThis study showed the magnet loss rises with the carrier frequency.\n`).includes('46-tense'));
  assert.ok(!ids(`\\section{Conclusion}\nThis paper has analysed the PWM-induced loss of the dual three-phase machine.\n`).includes('46-tense'));
  assert.ok(!ids(`\\section{Conclusion}\nBody.\n\\section{Future work}\n${body}`).includes('46-tense'));
});
