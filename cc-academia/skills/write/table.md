# Make or check a table

1. Template: `knowledge/common/table/templates/parameter-table.md`; bracket style from dimension
   `table.unit-brackets` (resolve output).
2. Full parameter names, one quantity per row, unit after the name, bare numbers in value cells; result values as
   `\val{id}` from the registry.
3. `academia-write lint-table [files]` checks abbreviations (table vocabulary), slash-joined quantities, units in value
   cells and bracket style; fix every hit.
4. Caption: no "A/An/The" opening where the venue rule applies; notes go in the caption.
