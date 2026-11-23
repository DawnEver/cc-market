# Parameter table template

Source: common (table.full-names, table.one-quantity-per-cell, table.unit).

| Name cell | Value cell |
|---|---|
| Full parameter name, unit in {table.unit-brackets} brackets: `Stator outer diameter [mm]` | Bare number: `264.3` |

- One quantity per row; "Slots / poles" becomes two rows.
- No abbreviations in name cells; `academia-write lint-table` lists the ones it knows (table vocabulary).
- Values that are results come from the number registry (`\val{id}`, data.registry).
