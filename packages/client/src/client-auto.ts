import { locateSampleCell, withinGeographicBounds } from '@av/contracts/geometry';
import type { LayerId } from '@av/contracts/layers';
import { DEFAULT_MODEL, MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type CatalogModelEntry } from '@av/contracts/publication';
import type { ApiClient } from './client-api.js';
import { selectHostFrame, type FrameLike } from './client-time.js';
import type { GeoPoint, PinnedBuild } from './client-types.js';

export const AUTO_MODEL_ID = 'auto';
/** The unset preview camera is zoom 2. A longitude span of 180° is at least half the world. */
const GLOBE_MAX_ZOOM = 2;
const GLOBE_MIN_LONGITUDE_SPAN = 180;
export interface AutoForecastSelection { build: PinnedBuild; frame: FrameLike }
export interface GlobeView { zoom?: number; west?: number; east?: number }

interface CatalogSelection {
  models: readonly CatalogModelEntry[];
  lat?: number;
  lon?: number;
  validTimeMs?: number;
  nowMs?: number;
  globe?: boolean;
}

function finitePoint(lat: number | undefined, lon: number | undefined): GeoPoint | null {
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/** Whole-world cameras report a raw longitude span of at least 360°. A negative span crosses the dateline. */
function longitudeSpan(west: number, east: number): number {
  const span = east - west;
  if (span >= 360) return 360;
  return span < 0 ? span + 360 : span;
}

export function isGlobeView(view?: GlobeView | null): boolean {
  if (!view) return false;
  if (view.zoom !== undefined && Number.isFinite(view.zoom) && view.zoom <= GLOBE_MAX_ZOOM) return true;
  const { west, east } = view;
  if (west === undefined || east === undefined || !Number.isFinite(west) || !Number.isFinite(east)) return false;
  return longitudeSpan(west, east) >= GLOBE_MIN_LONGITUDE_SPAN;
}

function rankCatalogModels({ models, lat, lon, validTimeMs, nowMs = Date.now(), globe = false }: CatalogSelection): CatalogModelEntry[] {
  const point = finitePoint(lat, lon);
  const candidates = models.flatMap(model => {
    if (!point && model.model !== DEFAULT_MODEL) return [];
    const published = MODEL_OPTIONS.find(option => option.modelId === model.model);
    const bounds = model.bounds ?? published?.bounds, spacing = model.nominalDxMeters ?? published?.nominalDxMeters;
    const expiresAt = model.expiresAt ?? model.freshness?.expiresAt;
    if (!model.available || model.model === AUTO_MODEL_ID || !bounds || spacing === undefined || !(spacing > 0) ||
      !Number.isFinite(spacing) || (point !== null && !withinGeographicBounds(point.lat, point.lon, bounds)) ||
      (expiresAt !== undefined && !(Date.parse(expiresAt) > nowMs))) return [];
    const earliest = model.freshness?.earliestValidTime, latest = model.freshness?.latestValidTime;
    if (validTimeMs !== undefined && ((earliest !== undefined && !(validTimeMs >= Date.parse(earliest))) ||
      (latest !== undefined && !(validTimeMs <= Date.parse(latest))))) return [];
    if (validTimeMs === undefined && model.freshness?.horizonExhausted) return [];
    return [{ model, spacing, cycle: Date.parse(model.cycle ?? '') || 0 }];
  });
  candidates.sort((a, b) => {
    const preferGfs = (globe || point === null) && (a.model.model === DEFAULT_MODEL) !== (b.model.model === DEFAULT_MODEL);
    if (preferGfs) return a.model.model === DEFAULT_MODEL ? -1 : 1;
    return a.spacing - b.spacing || b.cycle - a.cycle || (a.model.model < b.model.model ? -1 : Number(a.model.model > b.model.model));
  });
  return candidates.map(candidate => candidate.model);
}

export function selectBestCatalogModel(options: CatalogSelection): string | null {
  return rankCatalogModels(options)[0]?.model ?? null;
}

/** Match a rendered frame inside the run. An interior gap keeps the latest valid time at or before the clock. */
export function selectAutoFrame<T extends FrameLike>(frames: readonly T[], validTimeMs: number): T | null {
  const valid = frames.map(frame => Date.parse(frame.validTime));
  const earliest = Math.min(...valid), latest = Math.max(...valid);
  if (!valid.length || !(validTimeMs >= earliest && validTimeMs <= latest)) return null;
  const exact = frames.find((_, index) => valid[index] === validTimeMs);
  if (exact) return exact;
  const covering = frames.find(frame => Date.parse(frame.intervalStart) <= validTimeMs && validTimeMs <= Date.parse(frame.intervalEnd));
  if (covering) return covering;
  let chosen: T | null = null;
  for (let index = 0; index < frames.length; index += 1) {
    if (valid[index]! <= validTimeMs && (chosen === null || valid[index]! >= Date.parse(chosen.validTime))) chosen = frames[index]!;
  }
  return chosen;
}

export async function resolveAutoBuild(api: Pick<ApiClient, 'catalog' | 'latest' | 'sample'>, options: {
  lat?: number;
  lon?: number;
  globe?: boolean;
  validTimeMs?: number;
  layers: readonly LayerId[];
  signal: AbortSignal;
}): Promise<AutoForecastSelection | null> {
  const { lat, lon, globe = false, validTimeMs, layers, signal } = options;
  const point = finitePoint(lat, lon);
  let models: CatalogModelEntry[];
  try { models = await api.catalog({ signal }); }
  catch {
    signal.throwIfAborted();
    models = MODEL_OPTIONS.map(({ modelId }) => ({ model: modelId, available: true }));
  }
  const tried = new Set<string>();
  for (const { model } of rankCatalogModels({ models, lat, lon, validTimeMs, globe })) {
    signal.throwIfAborted();
    if (tried.has(model)) continue;
    tried.add(model);
    try {
      const build = await api.latest(model, { signal });
      if (build.expiresAtMs <= Date.now() || (point !== null && !withinGeographicBounds(point.lat, point.lon, build.manifest.descriptors.bounds))) continue;
      const layer = layers.find(id => build.templates[id]);
      const frames = renderedFrames(build.manifest);
      if (validTimeMs === undefined && frames.every(frame => Date.parse(frame.validTime) < Date.now())) continue;
      const frame = validTimeMs === undefined ? selectHostFrame(frames, Date.now()) : selectAutoFrame(frames, validTimeMs);
      if (!layer || !frame) continue;
      if (point === null) return { build, frame };
      const surface = build.manifest.surfaces.find(item => item.layers.includes(layer));
      if (!surface || locateSampleCell(surface.grid, point.lat, point.lon) === null) continue;
      const sample = await api.sample(build, { lat: point.lat, lon: point.lon, layers: [layer], frames: [frame.id], signal });
      signal.throwIfAborted();
      const status = sample.frames[0]?.layers[layer]?.status;
      if (build.expiresAtMs > Date.now() && (status === 'valid' || status === 'no-usable-lift')) return { build, frame };
    } catch { signal.throwIfAborted(); }
  }
  signal.throwIfAborted();
  return null;
}
