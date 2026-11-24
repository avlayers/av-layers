# Map themes

A theme is a data record (`ThemeRecord` in `theme.ts`): basemap paint tokens,
lift and rain colour ramps and encodings, cloud style, isobar and rain-edge
colours, legend swatches, picker glyph, and `remap` (false draws the published
server palette unchanged).

- One file per theme: `stone.ts`, `slate.ts`, `chart.ts`, `classic.ts`.
- `registry.ts` lists them in picker order (the first is the default) and maps
  retired ids from old links (`alabaster`, `convergence`, `blueprint`,
  `cockpit`) to kept ones.
- `palette.ts` derives colour ramps and legends from a record.

To add a theme, add a file and one entry in `registry.ts`. Code outside this
folder reads record fields and never compares theme ids.
`features/map/theme-golden.test.ts` fingerprints every theme; regenerate it with
`UPDATE_THEME_GOLDEN=1` only for an intended visual change.
