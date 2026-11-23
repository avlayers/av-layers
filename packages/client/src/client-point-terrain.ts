import { locateSampleCell, nearerContributor, normalizeLon, prepareGridGeometry, withinGeographicBounds, type Grid, type GridGeometry } from '@av/contracts/geometry';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from '@av/contracts/layers';
import { WIND_FINE_CELL_BYTES, WIND_FRAME_LIMIT, assertWindFrameLayout, decodeTileMask, parseWindFrame, windLayout } from '@av/contracts/wind-data';
import type { GeoPoint, PinnedBuild, PointTerrain } from './client-types.ts';

interface Contributor {
  readonly row: number;
  readonly column: number;
  readonly weight: number;
}

function planFineContributors(grid: Grid, geometry: GridGeometry, lat: number, lon: number): Contributor[] | null {
  const located = locateSampleCell(grid, lat, lon, geometry);
  if (!located) return null;
  const { column: x0, row: y0, fractionX: fx, fractionY: fy } = located;
  const contributors: Contributor[] = [];
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      if ((dx && fx === 0) || (dy && fy === 0)) continue;
      contributors.push({
        row: y0 + dy,
        column: (x0 + dx) % grid.width,
        weight: (dy ? fy : 1 - fy) * (dx ? fx : 1 - fx),
      });
    }
  }
  return contributors.length ? contributors : null;
}

function createFineCompanionView(bytes: Uint8Array, expectedBytes: number): DataView {
  if (bytes.byteLength !== expectedBytes) throw new Error('Fine terrain chunk length mismatch');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function validateFineCompanionCell(view: DataView, pos: number, packed: number, elevation: number): void {
  const support = view.getUint8(pos + 9);
  const terrain = packed & STATUS_MASK;
  const lift = (packed >> 2) & STATUS_MASK;
  if (
    (packed & 0xe0) !== 0 ||
    (support & ~SUPPORT_MASK) !== 0 ||
    terrain === STATUS_NO_LIFT ||
    (terrain === STATUS_VALID && !Number.isFinite(elevation)) ||
    (lift <= STATUS_NO_LIFT && !Number.isFinite(view.getFloat32(pos + 4, true)))
  ) {
    throw new Error('Invalid fine terrain companion chunk');
  }
}

async function readBoundedBytes(
  fetchImpl: typeof fetch,
  url: string,
  expectedContentType: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array | 'unavailable'> {
  signal?.throwIfAborted();
  const res = await fetchImpl(url, { method: 'GET', redirect: 'error', signal });
  if (res.status === 404 || res.status === 409) {
    await res.body?.cancel().catch(() => {});
    return 'unavailable';
  }
  if (!res.ok || res.headers.get('content-type')?.split(';')[0] !== expectedContentType) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Invalid fine terrain response (${res.status})`);
  }
  const declared = res.headers.get('content-length');
  const identity = (res.headers.get('content-encoding') ?? 'identity') === 'identity';
  if (declared !== null && identity && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await res.body?.cancel().catch(() => {});
    throw new Error('Fine terrain response exceeds byte budget');
  }
  if (!res.body) throw new Error('Fine terrain response body is empty');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancellation: Promise<void> | undefined;
  const onAbort = () => { cancellation ??= reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    for (;;) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      if (total + next.value.byteLength > maxBytes) throw new Error('Fine terrain response exceeds byte budget');
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await (cancellation ?? reader.cancel().catch(() => {}));
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Evaluates fine-grid terrain elevation from 1..4 fine companion tiles, independent of weather status. */
export function evaluateFineTerrainContributors(args: {
  contributors: readonly Contributor[];
  fineGridWidth: number;
  fineTileSize: number;
  resolveSlot: (logicalTile: number) => number;
  tiles: ReadonlyMap<number, DataView>;
  surfaceId: string;
  surface: string | null;
  verticalDatum: string | null;
}): PointTerrain {
  const { contributors, fineGridWidth, fineTileSize, resolveSlot, tiles, surfaceId, surface, verticalDatum } = args;
  const meta = { surfaceId, surface, verticalDatum };
  const tilesAcross = Math.ceil(fineGridWidth / fineTileSize);
  const elevations = new Float64Array(contributors.length);
  const terrainStatuses = new Uint8Array(contributors.length);
  let nearest = 0;
  let nearestOutput = 0;

  for (let i = 0; i < contributors.length; i++) {
    const item = contributors[i]!;
    const best = contributors[nearest]!;
    const logical = Math.floor(item.row / fineTileSize) * tilesAcross + Math.floor(item.column / fineTileSize);
    const slot = resolveSlot(logical);
    let packed = STATUS_OUTSIDE;
    let elevation = 0;
    if (slot >= 0) {
      const view = tiles.get(slot);
      if (!view) return { elevationM: null, status: 'unavailable', interpolated: false, ...meta };
      const pos = ((item.row % fineTileSize) * fineTileSize + (item.column % fineTileSize)) * WIND_FINE_CELL_BYTES;
      packed = view.getUint8(pos + 8);
      elevation = view.getFloat32(pos, true);
      validateFineCompanionCell(view, pos, packed, elevation);
    }
    elevations[i] = elevation;
    terrainStatuses[i] = packed & STATUS_MASK;
    if (i === 0 || nearerContributor(item.weight, item.row, item.column, best.weight, best.row, best.column)) {
      nearest = i;
      nearestOutput = (packed >> 4) & 1;
    }
  }

  if (!nearestOutput) {
    return { elevationM: null, status: 'outside-domain', interpolated: false, ...meta };
  }

  let anyMissingTerrain = false;
  for (let i = 0; i < contributors.length; i++) {
    if (terrainStatuses[i]! >= STATUS_UNAVAILABLE) anyMissingTerrain = true;
  }

  if (anyMissingTerrain || contributors.length === 1) {
    const idx = anyMissingTerrain ? nearest : 0;
    const status = terrainStatuses[idx]!;
    return status === STATUS_VALID
      ? { elevationM: elevations[idx]!, status: 'valid', interpolated: false, ...meta }
      : { elevationM: null, status: status === STATUS_OUTSIDE ? 'outside-domain' : 'unavailable', interpolated: false, ...meta };
  }

  let blended = 0;
  for (let i = 0; i < contributors.length; i++) {
    blended += elevations[i]! * contributors[i]!.weight;
  }
  return { elevationM: blended, status: 'valid', interpolated: true, ...meta };
}

interface CachedDescriptor {
  readonly fineTileSize: number;
  readonly chunkBytes: number;
  readonly resolveSlot: (logical: number) => number;
}

const MAX_POINT_TERRAIN_ENTRIES = 64;
const MAX_CACHED_DESCRIPTORS = 16;
const MAX_CACHED_FINE_TILES = 16;

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number): V {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.delete(key);
  map.set(key, value);
  return value;
}

interface InFlightTask<T> {
  promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
}

function coalescedFetch<T>(
  inFlight: Map<string, InFlightTask<T>>,
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  waiterSignal?: AbortSignal,
): Promise<T> {
  waiterSignal?.throwIfAborted();
  let task = inFlight.get(key);
  if (!task) {
    const controller = new AbortController();
    const created: InFlightTask<T> = {
      promise: undefined as unknown as Promise<T>,
      controller,
      waiters: 0,
    };
    created.promise = run(controller.signal).finally(() => {
      if (inFlight.get(key) === created) inFlight.delete(key);
    });
    inFlight.set(key, created);
    task = created;
  }
  task.waiters += 1;
  const activeTask = task;
  if (!waiterSignal) {
    return activeTask.promise.finally(() => {
      activeTask.waiters = Math.max(0, activeTask.waiters - 1);
    });
  }
  return new Promise<T>((resolve, reject) => {
    let released = false;
    const release = (aborted: boolean) => {
      if (released) return;
      released = true;
      activeTask.waiters = Math.max(0, activeTask.waiters - 1);
      if (aborted && activeTask.waiters === 0) {
        activeTask.controller.abort(waiterSignal.reason);
      }
    };
    const onAbort = () => {
      release(true);
      reject(waiterSignal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (waiterSignal.aborted) {
      onAbort();
      return;
    }
    waiterSignal.addEventListener('abort', onAbort, { once: true });
    activeTask.promise.then(
      value => {
        waiterSignal.removeEventListener('abort', onAbort);
        if (!released) {
          release(false);
          resolve(value);
        }
      },
      error => {
        waiterSignal.removeEventListener('abort', onAbort);
        if (!released) {
          release(false);
          reject(error);
        }
      },
    );
  });
}

/** Bounded cache for static fine-surface point terrain lookups across a client lifetime. */
export class PointTerrainCache {
  private readonly points = new Map<string, PointTerrain>();
  private readonly descriptors = new Map<string, CachedDescriptor | 'unavailable'>();
  private readonly tiles = new Map<string, DataView>();
  private readonly inFlightDescriptors = new Map<string, InFlightTask<CachedDescriptor | 'unavailable'>>();
  private readonly inFlightTiles = new Map<string, InFlightTask<DataView | 'unavailable'>>();

  async read(
    baseUrl: string,
    fetchImpl: typeof fetch,
    build: PinnedBuild,
    point: GeoPoint,
    signal?: AbortSignal,
  ): Promise<PointTerrain | null> {
    signal?.throwIfAborted();
    const fine = build.manifest.surfaces.find(s => s.kind === 'fine');
    const native = build.manifest.surfaces.find(s => s.kind === 'native');
    const firstFrame = build.manifest.frames[0]?.id;
    if (!fine || !native || !firstFrame) return null;

    const surface = fine.terrain?.surface ?? null;
    const verticalDatum = fine.terrain?.verticalDatum ?? null;
    const wrappedLon = fine.grid.wrapLongitude ? normalizeLon(point.lon) : point.lon;
    const pointKey = `${build.manifest.buildId}:${fine.id}:${point.lat}:${wrappedLon}`;
    const cachedPoint = this.points.get(pointKey);
    if (cachedPoint) return lruSet(this.points, pointKey, cachedPoint, MAX_POINT_TERRAIN_ENTRIES);

    const outside: PointTerrain = {
      elevationM: null,
      status: 'outside-domain',
      interpolated: false,
      surfaceId: fine.id,
      surface,
      verticalDatum,
    };
    if (!withinGeographicBounds(point.lat, point.lon, build.manifest.descriptors.bounds)) {
      return lruSet(this.points, pointKey, outside, MAX_POINT_TERRAIN_ENTRIES);
    }

    const contributors = planFineContributors(fine.grid, prepareGridGeometry(fine.grid), point.lat, point.lon);
    if (!contributors) return lruSet(this.points, pointKey, outside, MAX_POINT_TERRAIN_ENTRIES);

    const root = `${baseUrl.replace(/\/+$/, '')}/v1/models/${encodeURIComponent(build.manifest.model)}/runs/${encodeURIComponent(build.manifest.buildId)}/data/${encodeURIComponent(firstFrame)}`;
    let descriptor = this.descriptors.get(build.manifest.buildId);
    if (!descriptor) {
      descriptor = await coalescedFetch(
        this.inFlightDescriptors,
        build.manifest.buildId,
        async sharedSignal => {
          const rawDesc = await readBoundedBytes(fetchImpl, root, 'application/json', WIND_FRAME_LIMIT, sharedSignal);
          if (rawDesc === 'unavailable') {
            return lruSet(this.descriptors, build.manifest.buildId, 'unavailable', MAX_CACHED_DESCRIPTORS);
          }
          const parsed = parseWindFrame(rawDesc);
          if (parsed.frame !== firstFrame) throw new Error('Fine terrain frame descriptor mismatch');
          assertWindFrameLayout(parsed, { native: native.grid, fine: fine.grid });
          const fineTotal = windLayout(fine.grid.width, fine.grid.height, parsed.fineTileSize);
          const mask = decodeTileMask(parsed.fineMask, fineTotal.count);
          return lruSet(
            this.descriptors,
            build.manifest.buildId,
            {
              fineTileSize: parsed.fineTileSize,
              chunkBytes: fineTotal.chunkBytes,
              resolveSlot: mask ? logical => mask.slot(logical) : logical => logical,
            },
            MAX_CACHED_DESCRIPTORS,
          );
        },
        signal,
      );
    }
    if (descriptor === 'unavailable') return null;

    const { fineTileSize, chunkBytes, resolveSlot } = descriptor;
    const tilesAcross = Math.ceil(fine.grid.width / fineTileSize);
    const neededSlots = new Set<number>();
    for (const item of contributors) {
      const logical = Math.floor(item.row / fineTileSize) * tilesAcross + Math.floor(item.column / fineTileSize);
      const slot = resolveSlot(logical);
      if (slot >= 0) neededSlots.add(slot);
    }

    const tileMap = new Map<number, DataView>();
    await Promise.all(
      [...neededSlots].map(async slot => {
        const tileKey = `${build.manifest.buildId}:${slot}`;
        let view: DataView | 'unavailable' | undefined = this.tiles.get(tileKey);
        if (!view) {
          view = await coalescedFetch(
            this.inFlightTiles,
            tileKey,
            async sharedSignal => {
              const bytes = await readBoundedBytes(fetchImpl, `${root}/fine/${slot}`, 'application/octet-stream', chunkBytes, sharedSignal);
              if (bytes === 'unavailable') return 'unavailable';
              return lruSet(this.tiles, tileKey, createFineCompanionView(bytes, chunkBytes), MAX_CACHED_FINE_TILES);
            },
            signal,
          );
        }
        if (view !== 'unavailable') tileMap.set(slot, view);
      }),
    );
    signal?.throwIfAborted();

    return lruSet(
      this.points,
      pointKey,
      evaluateFineTerrainContributors({
        contributors,
        fineGridWidth: fine.grid.width,
        fineTileSize,
        resolveSlot,
        tiles: tileMap,
        surfaceId: fine.id,
        surface,
        verticalDatum,
      }),
      MAX_POINT_TERRAIN_ENTRIES,
    );
  }
}
