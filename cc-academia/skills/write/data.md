# Result numbers (data.registry)

1. Register each result number once in `<project>/.academia/numbers.tsv`: `id value unit expr source round`.
   `expr` is arithmetic over `run.column` names of the CSV `source` (path relative to the LaTeX project root; `run`
   is the first column), `round` the number of decimals, `unit` as printed (`kW`, `W`, `%`, `deg`).
2. `academia-write check-data` evaluates every expression, compares the rounded result with `value`, and lists hand-typed
   numbers in the prose that equal a registry value. A mismatch means the data or the registry changed: tell the
   author which, do not edit the value silently.
3. `academia-write check-data --write` emits `numbers.tex` defining `\val{id}` (thin space before the unit);
   `\input{numbers}` in the preamble. `\val` does not collide with siunitx (`\num`, `\qty`).
4. Switching an existing manuscript to `\val{}` edits approved text: propose it first.
