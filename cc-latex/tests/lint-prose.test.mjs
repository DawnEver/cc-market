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
