# Reading the forecast

Each build packages one model run's map tiles, point samples, and metadata. Tiles
and point queries evaluate the same grids and interpolation rules.

## Layers and missing values

- `usable-lift-msl`: estimated usable thermal top in metres above mean sea
  level.
- `usable-lift-agl`: usable depth in metres above ground. The descriptor names
  `model-AGL` for native model ground or `terrain-AGL` for the prepared surface
  elevation. Current fine grids use Copernicus GLO-90, a digital surface model
  that includes vegetation and buildings.
- `precip-rate`: liquid-water-equivalent interval mean in mm/h. GFS and RRFS
  recover accumulated `APCP`; ICON-EU recovers accumulated `TOT_PREC`; av-wrf
  publishes the producer window rate `precip_mm_hr`.
- `cloud-cover-total` and `cloud-cover-low`: cloud cover in percent. Finite
  values from 0 through 100 are valid, including a boundary tolerance of
  0.0001. The stored sample keeps the original number. A value farther outside
  that range is unavailable.
- `cape-jkg`: CAPE in J/kg. Zero and every larger finite value are valid. A
  negative value beyond the same boundary tolerance is unavailable.

Missing cells stay unavailable and the sample value is null. An unavailable
cloud field leaves precipitation and CAPE on their own statuses. These four
fields remain available on night frames. Each model's layer descriptor carries
a `definition` for the source parameter, level, parcel, or producer contract.
Samples carry the value and status.

Each build's manifest descriptors list its available layers and delivery.
[Native fields](../packages/contracts/src/layers.ts) add lift, flux,
surface, cloud, stability and wind samples. Map layers carry palettes; native
scalar channels use point queries.

GFS and RRFS use surface CAPE and valid-time `GUST`. ICON-EU uses mixed-layer
`CAPE_ML` and the 10 m interval maximum `VMAX_10M`. RRFS mean sea-level pressure
uses the Eta reduction (`MSLET`). See the [model registry](../packages/contracts/config/models.json)
for the source fields and levels behind each layer.

Every sample carries a status:

- `valid`: finite numeric value.
- `no-usable-lift`: daytime column solved to no usable lift, or the cell is in
  darkness across the frame's interval and valid time
  (`solarElevation <= minimumSolarElevationDeg`, support `0`). Public MSL value
  is `null`; AGL value is `0`.
- `unavailable`: required inputs are missing or invalid, or the selected surface
  lacks the frame. Value is `null`.
- `outside-domain`: coordinate falls outside the product's coverage mask. Value
  is `null`.

Each layer tracks its own input masks independently, so missing thermal inputs
leave `precip-rate` valid and vice versa. Sample responses also report
`interpolated` and bitmask `support` flags from the contributing grid cells.

## Coverage and resolution

The [configured models](reference.md#configured-models) define coverage,
subdivision factors and tile zooms. Coverage intersects cell footprints with
pinned Natural Earth polygons and includes a separate 1-cell interpolation halo.
Source receipts are emitted by the [native coverage generator](../scripts/masks/build_masks.py)
and [fine coverage generator](../scripts/masks/build_fine_masks.py).

Version-5 manifests assign each layer to one surface. Lift uses the fine
terrain-column surface; weather scalars use the native surface. Each surface
pins its grid, coverage and sample shards. A sample value's `surfaceId` identifies
its grid and ground reference. Output masks select coverage; halo cells supply
boundary contributors. No-lift and unavailable values retain their selected
surface's status. Missing advertised assets fail the request.

ICON-EU's native surface uses the configured regular output grid. Its
[source adapter](../apps/batch/src/split-grib/README.md) selects one triangular-mesh
column for each output cell before terrain refinement and point interpolation.

## Time and retention

- `cycle`: upstream model initialization time (UTC).
- `validTime`: forecast valid time (UTC).
- `intervalStart` / `intervalEnd`: trailing flux and precipitation window (UTC).
- `createdAt` / `ageSeconds`: build creation timestamp and elapsed seconds since
  the build started.

[Model settings](../packages/contracts/config/models.json) own forecast windows
and source intervals.
Current products emit native weather and profiles through the complete
selected horizon, including night. Precipitation retains its trailing interval
at night. GFS and RRFS hour 27 covers f026–f027: the precipitation rate is the
one-hour mean recovered from the reset-bucket accumulation, and an amount for
that frame is the rate multiplied by one hour. From hour 123 the GFS source
interval is three hours, and the amount uses that duration. `mapFrameCount` selects the tiles and fine-lift prefix; native samples and
profiles cover the complete frame axis.
`regional-daylight` builds follow the [daylight selection rule](science.md#input-fields).

`/profile` echoes the requested `lat` and `lon` and identifies the nearest
covered native grid cell in `cell`. Each frame's `layers` and `profile` come
from that cell, and `derived` uses those same scalars and levels. `/sample`
and `/samples` evaluate the requested coordinates. The windgram uses these
point samples for map lift. [Point products](../packages/contracts/src/point-products.ts)
owns the wire contract and page budgets.

API freshness and the map notice use the last rendered frame's `validTime`.
The full point forecast uses the complete frame axis. Historical frames remain
viewable until the build's `expiresAt` deadline. See [operations](operations.md)
for publication and expiry rules.

## On-disk format

Each published build writes immutable objects under `builds/{model}/{buildId}/`
and updates `catalog/{model}/latest.json`. Format and descriptor changes follow
the 7-day `N` / `N-1` retention policy in
[extensions](extensions.md#change-an-on-disk-format-or-descriptor).

| Object family | R2 key pattern | Version / format | Layout & schema owner |
| --- | --- | --- | --- |
| Model pointer | `catalog/{model}/latest.json` | `version: 1` | `latestBuildId` and `retained[]` (`RETENTION_DAYS = 7`); [publication.ts](../packages/contracts/src/publication.ts) |
| Build manifest | `builds/{model}/{buildId}/manifest.json` | `version: 5` | `frames`, `mapFrameCount`, `surfaces` (`fine`, `native`), `artifacts`, optional `mapData`, `descriptors`; [publication.ts](../packages/contracts/src/publication.ts) |
| Provenance index & frames | `builds/{model}/{buildId}/provenance.json`, `provenance/{frame}.json` | `version: 2`, frame `version: 1` | Frame index with per-frame `sha256` and `bytes` referencing upstream GRIB2/Zarr receipts; [publication.ts](../packages/contracts/src/publication.ts) |
| Sparse coverage | `coverage/{coverageHash}/{manifest.json,sparse.bin,tiles.bin}` | `version: 2`, `SCV1` (`0x31564353`) | `16 × 16` block index (`blockIds`, `offsets`) with 32-byte `output` and `halo` bitsets per block, plus packed zoom tile bitsets; [sparse-coverage.ts](../packages/contracts/src/sparse-coverage.ts) |
| Prepared sparse terrain | `terrain/prepared/{hash}/{manifest.json,elevation-{i}.f32,valid-{i}.u8}` | `version: 2`, `layoutVersion: 1` | Active-cell `Float32` EGM2008 elevations and `Uint8` validity masks in `SparseCoverage` offset order; [sparse.ts](../apps/batch/src/terrain/sparse.ts) |
| Scalar sample shards | `builds/{model}/{buildId}/surfaces/{surfaceId}/samples/g{group}-b{shard}.bin` | `frame-group-block-shards-v1` | `16 × 16` blocks with `+1` right/bottom seam (`17 × 17` interior cells), 5-byte cell records (`f32 value`, `u8 flags`) across `group.frameCount × surface.layers.length` channels; [sample-pack.ts](../packages/forecast/src/sample-pack.ts) |
| Native profile shards | `builds/{model}/{buildId}/surfaces/{surfaceId}/profiles/g{group}-b{shard}.bin` | `native-column-profile-v1` | Same `16 × 16` block/seam geometry; `8 + 14 × levelCount` bytes per cell-frame (`i16 terrainM`, `u16 count`, `u8 status`, `u8 version = 1`, `u16 sfcPressureDecaPa`, and `levelCount` ascending 14-byte levels); [profile-pack.ts](../packages/forecast/src/profile-pack.ts) |
| Map raster archives | `builds/{model}/{buildId}/{layer}/{frame}.pmtiles` | PMTiles v3 (`256 × 256` lossless WebP) | Rendered for `renderedLayers(manifest.layers)` across the `mapFrameCount` prefix; [render.ts](../apps/batch/src/render.ts) |
| Numeric wind map data | `builds/{model}/{buildId}/map-data.json`, `map-data/{frame}.json`, `map-data/{frame}/{kind}-{page}.{bin,idx}` | Root `version: 1`, frame `version: 3` | Equal-sized `wind` (`WND2`), `fine`, and `overview-{2,4,8,16}` chunks with 32-byte SHA-256 index entries; [wind-data.ts](../packages/contracts/src/wind-data.ts) |

## Numeric wind map data

Scheduled and `repository_dispatch` forecast builds (and local builds with
`AV_NUMERIC_WIND=true`) publish verified binary wind fields
alongside map rasters (`mapData` on the manifest and retained pointer). Non-numeric
builds omit `mapData` and return HTTP `409 product-unavailable` on `/data/...`.
[wind-data.ts](../packages/contracts/src/wind-data.ts) owns the wire contract:

- `GET /v1/models/{model}/runs/{buildId}/data/{frame}` returns a JSON
  `WindFrameDescriptor` (`version: 3`, `tileSize: 16`, `fineTileSize: 64`,
  `levels`, `wind`, `fine`, optional `overview`, and optional canonical base64
  bitsets `windMask` / `fineMask`). When a mask is present, bit `i` (`bytes[i >> 3] & (1 << (i & 7))`)
  marks whether logical row-major tile `i` intersects active coverage; all-outside
  tiles are omitted and compact slot `s` maps to the `s`-th set bit.
- `GET /v1/models/{model}/runs/{buildId}/data/{frame}/{kind}/{tile}` returns raw
  `application/octet-stream` bytes for `kind` in `wind`, `fine`, or
  `overview-{stride}` (`2`, `4`, `8`, `16`). `{tile}` is either a single compact
  slot (`0`) or a contiguous single-page inclusive span (`start-end`, up to `1 MiB`).
  Each page stores up to `512` equal-sized chunks in `{kind}-{page}.bin` paired
  with `512 × 32`-byte SHA-256 digests in `{kind}-{page}.idx`.

Little-endian binary chunk layouts:

- `wind` (`WND2`): 12-byte header (`u32 magic = 0x32444e57`, `u16 version = 1`,
  `u16 levels`, `u32 columns = tileSize²`), followed for each column by a 9-byte
  10 m surface vector (`f32 u`, `f32 v`, `u8 status`) and `levels` ascending
  13-byte upper-air records (`f32 heightMsl`, `f32 u`, `f32 v`, `u8 status`).
- `fine`: `fineTileSize²` 10-byte cells (`f32 terrainM`, `f32 liftMslM`,
  `u8 packedFlags = terrainStatus | (liftStatus << 2) | (outputBit << 4)`,
  `u8 support`).
- `overview-{stride}`: `32 × 32` coarse cells × `12` vertical modes (`surface`,
  fixed AGL heights `20, 100, 300, 600, 1000, 1500, 2000, 3000, 4000, 5000 m`,
  and `lift`) × 9-byte vector (`f32 u`, `f32 v`, `u8 status`, `108` bytes/cell).

## Colour and interpolation

[layers.ts](../packages/contracts/src/layers.ts) defines palette thresholds,
colours, and legend labels, which are snapshotted into each build manifest.
MSL maps colour known no-lift cells at their stored ground elevation, including
at night. AGL maps leave no-lift cells and nonpositive values clear. Unavailable
and outside-domain cells remain clear in both views. Point status distinguishes
these cases; high terrain colours alone do not imply usable height above ground.

When all four surrounding grid cells are valid (or `no-usable-lift` on lift
layers), the sampler interpolates bilinearly; if any contributor is missing, it
returns the nearest cell's value and status. Above-ground wind interpolation
renormalizes across valid above-ground native donors when adjacent steep terrain
places a neighbouring donor's lowest level above the target MSL height. See
[science and sampling](science.md) for exact rules.
