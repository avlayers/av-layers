# 0001. AGPL-3.0-only with a contributor licence agreement

**Status:** accepted, 2026-11-24

## Context

The repository was public with no licence, so nobody could legally reuse or
contribute to it. The owner wants to open source it as a courtesy and may sell
parts of it later. av-layers is a hosted service (batch pipeline, API, map), so
the licence choice decides whether someone can run a modified copy as a closed
competing service.

## Decision

License everything under AGPL-3.0-only (`LICENSE`, `"license"` in every
`package.json`). Accept contributions under the [CLA](../../CLA.md), which grants
the maintainer the right to relicense them.

## Consequences

- Anyone may read, run, modify and fork the code. Anyone who serves a modified
  version to users over a network must offer those users the source (section 13).
- The maintainer, holding all copyright through the CLA, can also sell
  commercial licences or ship future parts under other terms.
- Some companies avoid AGPL code, so corporate contributions and embedding are
  less likely.
- Runtime dependencies are MIT, ISC, BSD or Apache-2.0, all compatible.
  Forecast data licences (DWD CC BY 4.0, Copernicus, OpenStreetMap ODbL) apply
  to data and stay as attribution in `THIRD_PARTY_NOTICES.txt`.

## Revisit when

Before the first commercial licence is sold (have counsel review this record and
the CLA), or if the science packages (`@av/thermodynamics`, `@av/soaring`,
`@av/solar`) should be relicensed permissively for wider reuse.
