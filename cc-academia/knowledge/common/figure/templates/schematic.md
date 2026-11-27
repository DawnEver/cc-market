# Schematic template (circuit, control block diagram, model structure, flow chart)

Source: common (figure.no-notes).

1. Show structure, not a case: every quantity as its symbol ($V_\mathrm{dc}$, $f_c$, $\omega_r$); a numeric angle
   only when it is the defining property.
2. No case values, gains, step sizes, file names or tool internals; values go in the table or text.
3. The paper's terms ("winding set"), never a tool's names.
4. Only symbols, signal names and component labels; every explanatory note goes in the caption (figure.no-notes).
5. Same colours and styles per quantity as the data figures (figure.one-style-per-quantity); text at the figure
   font size (TikZ: the size matching dimension figure.font-size-pt, e.g. \scriptsize in an 11 pt document).
6. A figure supplied by a partner and declared in the project's figures.tsv is used as supplied and is exempt.
