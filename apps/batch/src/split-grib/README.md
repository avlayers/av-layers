# Split GRIB2 input

Fetches configured single-field GRIB2 objects and normalizes model-level or
isobaric columns.

```sh
pnpm input:proof
pnpm test apps/batch/src/split-grib
```

[models.json](../../../../packages/contracts/config/models.json) owns URLs,
parameter identities, field roles, flux signs, selected levels and cycles.
[source.ts](source.ts) validates each instance and derives half-level interfaces
or isobaric level lists.
[acquire.ts](acquire.ts) owns static geometry, companion reuse and cancellation;
[fields.ts](fields.ts) checks source parameters, levels and statistical windows.
Optional `auxSurface` and `auxLevels` descriptors select instantaneous diagnostics;
their [normalized fields](../../../../packages/forecast/src/inputs.ts) retain
per-cell missingness and sentinel masking. Layer descriptors bind both fixed
surfaces. Configured precipitation accumulations use same-run companions to
recover trailing rates with the shared interval kernel and GRIB packing
tolerances.

ICON-EU reads DWD's native triangular mesh through the v1 URLs in the source
configuration ([announcement](https://www.dwd.de/DE/leistungen/opendata/neuigkeiten/opendata_september2026_1.html)).
[grib.ts](grib.ts) accepts uncompressed grid template 3.101 objects that match
the configured `nativeGrid` number, UUID and point count, and decodes simple or
CCSDS packing; [codec/ccsds.ts](codec/ccsds.ts) is a bounded pure-TypeScript
decoder. Reference tests cover libaec and ecCodes data.

HRDPS reads ECCC MSC Datamart split GRIB2 objects on the Continental 2.5 km
rotated lat-lon grid (template 3.1) using sampled JPEG 2000 (DRT 5.40) decoding
and rotates grid-relative winds to Earth-relative east/north components.

[native-grid.ts](native-grid.ts) maps active output cells to the nearest native
cell on the sphere. A session reads `CLAT` and `CLON` once, validates the configured
mesh identity, then reuses one donor per output column across terrain, half-level
heights, weather and statistical companions. Unmapped cells fail acquisition.
Frame receipts retain coordinate object hashes, mesh identity and the donor-map
hash. [Capacity admission](../whole-domain/capacity.ts) includes the retained map.

The regular output grid, coverage and terrain subdivision remain configured in
`models.json`. Nearest-cell columns preserve native values; they differ from
DWD's former field-specific regular-grid interpolation
([DWD interpolation guide](https://www.dwd.de/DE/leistungen/opendata/help/modelle/Opendata_cdo_EN.pdf?__blob=publicationFile&v=3)).
Native U/V are Earth-relative east/north components.

See [science](../../../../docs/science.md#input-fields) for midpoint heights and
flux recovery, and [third-party notices](../../../../THIRD_PARTY_NOTICES.txt).
