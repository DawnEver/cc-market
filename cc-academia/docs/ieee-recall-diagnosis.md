# IEEE reviewer-search recall diagnosis

Measured 2026-08-30 against the `tte-2026-08-2905` search artifacts and a
five-request public-endpoint probe using derived keywords only.

The stored run had no IEEE failures, but four of five queries returned zero;
the fifth returned 63. This rules out a missing key or a source-wide throttle.
The failing query `"Axial flux machine"` was then probed in controlled forms:

| IEEE query text | Total |
|---|---:|
| `"Axial flux machine"` | 0 |
| `Axial flux machine` | 70 |
| `Axial AND flux AND machine` | 70 |
| `"axial flux machine"` | 0 |
| `"electromagnetic noise"` | 63 |

The collapse came from forwarding the shared profile's quoted phrase syntax to
an endpoint that applies different query semantics. `IeeeXplore.adapt_expression`
now removes quotes and Boolean operators before search. IEEE remains enabled;
per-source counts in every search summary make future collapses visible.
