# 0003. Four map themes as data records

**Status:** accepted, 2026-11-24

## Context

The preview had eight map themes, three cloud styles and four rain styles that
combined freely. Each theme was a set of `theme === '…'` branches across the
map, raster, sky, legend and control modules, so a new theme or style touched a
dozen files and multiplied the combinations to test.

## Decision

Keep stone, slate, chart and classic. Each theme is one record in
`apps/preview/src/themes/` holding its basemap, lift and rain ramps, cloud style,
isobar, cloud-contour and rain-edge colours, legends and picker glyph. Code
outside that folder reads record fields and `DEFAULT_THEME`. Retired ids in
links and saved preferences map to the nearest kept theme; the cloud and rain
style pickers and their URL parameters are gone.

## Consequences

- A new theme is one file plus one registry entry and a regenerated theme
  golden (`UPDATE_THEME_GOLDEN=1`).
- Kept themes render as before: `theme-golden.json` predates the change and
  `pnpm visual-check` compares 48 screenshots against the previous build.
- Users of the retired themes and styles see the nearest kept look.

## Revisit when

A theme needs behaviour a record field cannot express.
