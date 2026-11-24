import { boundsOverlap, boundsOverlapFraction, locateSampleCell, withinGeographicBounds, type GeographicBounds } from '@av/contracts/geometry';
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
/** Minimum viewport degree-area fraction for an off-center regional domain to qualify as covering the camera view. */
const VIEWPORT_MIN_OVERLAP_FRACTION = 0.15;
export interface AutoForecastSelection { build: PinnedBuild; frame: FrameLike }
export interface GlobeView { zoom?: number; west?: number; east?: number }

interface CatalogSelection {
  models: readonly CatalogModelEntry[];
  lat?: number;
  lon?: number;
  bounds?: GeographicBounds | null;
  validTimeMs?: number;
  nowMs?: number;
  globe?: boolean;
  clampTime?: boolean;
}

interface RankedCandidate {
  readonly model: CatalogModelEntry;
  readonly spacing: number;
  readonly cycle: number;
  readonly tier: number;
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

function rankCatalogModels({ models, lat, lon, bounds: viewBounds = null, validTimeMs, nowMs = Date.now(), globe = false, clampTime = false }: CatalogSelection): RankedCandidate[] {
  const point = finitePoint(lat, lon);
  const hasViewport = viewBounds !== null && viewBounds !== undefined;
  const candidates = models.flatMap((model): RankedCandidate[] => {
    if (!point && !hasViewport && model.model !== DEFAULT_MODEL) return [];
    const published = MODEL_OPTIONS.find(option => option.modelId === model.model);
    const bounds = model.bounds ?? published?.bounds, spacing = model.nominalDxMeters ?? published?.nominalDxMeters;
    const expiresAt = model.expiresAt ?? model.freshness?.expiresAt;
    if (!model.available || model.model === AUTO_MODEL_ID || !bounds || spacing === undefined || !(spacing > 0) ||
      !Number.isFinite(spacing) || (expiresAt !== undefined && !(Date.parse(expiresAt) > nowMs))) return [];
    const centerMatch = point !== null && withinGeographicBounds(point.lat, point.lon, bounds);
    const overlap = hasViewport ? boundsOverlapFraction(viewBounds, bounds) : 0;
    const viewportMatch = hasViewport && overlap >= VIEWPORT_MIN_OVERLAP_FRACTION;
    const fallbackMatch = model.model === DEFAULT_MODEL && (
      (hasViewport && boundsOverlap(viewBounds, bounds)) ||
      (globe && (point === null || centerMatch || (hasViewport && boundsOverlap(viewBounds, bounds))))
    );
    if (point !== null && !centerMatch && !viewportMatch && !fallbackMatch) return [];
    if (point === null && hasViewport && !viewportMatch && !fallbackMatch) return [];
    const earliest = model.freshness?.earliestValidTime, latest = model.freshness?.latestValidTime;
    if (!clampTime && validTimeMs !== undefined && ((earliest !== undefined && !(validTimeMs >= Date.parse(earliest))) ||
      (latest !== undefined && !(validTimeMs <= Date.parse(latest))))) return [];
    if (validTimeMs === undefined && model.freshness?.horizonExhausted) return [];
    const tier = centerMatch ? 0 : viewportMatch ? 1 : 2;
    return [{ model, spacing, cycle: Date.parse(model.cycle ?? '') || 0, tier }];
  });
  candidates.sort((a, b) => {
    const preferGfs = ((globe && a.tier < 2 && b.tier < 2) || (point === null && !hasViewport)) && (a.model.model === DEFAULT_MODEL) !== (b.model.model === DEFAULT_MODEL);
    if (preferGfs) return a.model.model === DEFAULT_MODEL ? -1 : 1;
    return a.tier - b.tier || a.spacing - b.spacing || b.cycle - a.cycle || (a.model.model < b.model.model ? -1 : Number(a.model.model > b.model.model));
  });
  return candidates;
}

export function selectBestCatalogModel(options: CatalogSelection): string | null {
  return rankCatalogModels(options)[0]?.model.model ?? null;
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
  bounds?: GeographicBounds | null;
  globe?: boolean;
  validTimeMs?: number;
  now?: () => number;
  layers: readonly LayerId[];
  currentBuild?: PinnedBuild | null;
  signal: AbortSignal;
}): Promise<AutoForecastSelection | null> {
  const { lat, lon, bounds: viewBounds = null, globe = false, validTimeMs, now: clock = Date.now, layers, currentBuild = null, signal } = options;
  const point = finitePoint(lat, lon);
  const hasViewport = viewBounds !== null && viewBounds !== undefined;
  let models: CatalogModelEntry[];
  try { models = await api.catalog({ signal }); }
  catch {
    signal.throwIfAborted();
    models = MODEL_OPTIONS.map(({ modelId }) => ({ model: modelId, available: true }));
  }
  const fetchedBuilds = new Map<string, PinnedBuild>();
  if (currentBuild && currentBuild.expiresAtMs > clock()) {
    fetchedBuilds.set(currentBuild.manifest.model, currentBuild);
  }

  const runPass = async (clampTime: boolean): Promise<AutoForecastSelection | null> => {
    const candidates = rankCatalogModels({ models, lat, lon, bounds: viewBounds, validTimeMs, nowMs: clock(), globe, clampTime });
    const tried = new Set<string>();
    let fallbackSelection: AutoForecastSelection | null = null;
    let fallbackTier = Number.POSITIVE_INFINITY;
    let fallbackSpacing = Number.POSITIVE_INFINITY;
    const recordFallback = (build: PinnedBuild, frame: FrameLike, fbTier: number, spacing: number): void => {
      if (!fallbackSelection || fbTier < fallbackTier || (fbTier === fallbackTier && spacing < fallbackSpacing)) {
        fallbackSelection = { build, frame };
        fallbackTier = fbTier;
        fallbackSpacing = spacing;
      }
    };
    for (let index = 0; index < candidates.length; index += 1) {
      const { model: entry, spacing } = candidates[index]!;
      const model = entry.model;
      signal.throwIfAborted();
      if (tried.has(model)) continue;
      tried.add(model);
      try {
        let build = fetchedBuilds.get(model);
        if (!build || build.expiresAtMs <= clock()) {
          build = await api.latest(model, { signal });
          fetchedBuilds.set(model, build);
        }
        const now = clock();
        if (build.expiresAtMs <= now) continue;
        const manifestBounds = build.manifest.descriptors.bounds;
        const centerMatch = point !== null && withinGeographicBounds(point.lat, point.lon, manifestBounds);
        const overlap = hasViewport ? boundsOverlapFraction(viewBounds, manifestBounds) : 0;
        const viewportMatch = hasViewport && overlap >= VIEWPORT_MIN_OVERLAP_FRACTION;
        const fallbackMatch = model === DEFAULT_MODEL && (
          (hasViewport && boundsOverlap(viewBounds, manifestBounds)) ||
          (globe && (point === null || centerMatch || (hasViewport && boundsOverlap(viewBounds, manifestBounds))))
        );
        if (point !== null && !centerMatch && !viewportMatch && !fallbackMatch) continue;
        if (point === null && hasViewport && !viewportMatch && !fallbackMatch) continue;
        const layer = layers.find(id => build.templates[id]);
        const frames = renderedFrames(build.manifest);
        if (validTimeMs === undefined && frames.every(frame => Date.parse(frame.validTime) < now)) continue;
        const frame = validTimeMs === undefined
          ? selectHostFrame(frames, now)
          : (selectAutoFrame(frames, validTimeMs) ?? (clampTime ? selectHostFrame(frames, validTimeMs) : null));
        if (!layer || !frame) continue;
        if (point === null || (globe && model === DEFAULT_MODEL && (centerMatch || viewportMatch || !hasViewport))) return { build, frame };
        const surface = build.manifest.surfaces.find(item => item.layers.includes(layer));
        const cell = surface && centerMatch ? locateSampleCell(surface.grid, point.lat, point.lon) : null;
        if (!centerMatch || !surface || cell === null) {
          if (hasViewport && (viewportMatch || fallbackMatch)) {
            recordFallback(build, frame, viewportMatch ? 0 : 1, spacing);
          }
          continue;
        }
        const sample = await api.sample(build, { lat: point.lat, lon: point.lon, layers: [layer], frames: [frame.id], signal });
        signal.throwIfAborted();
        const status = sample.frames[0]?.layers[layer]?.status;
        if (build.expiresAtMs <= clock()) continue;
        if (status === 'valid' || status === 'no-usable-lift') return { build, frame };
        if (status === 'outside-domain' && hasViewport && (viewportMatch || fallbackMatch)) {
          recordFallback(build, frame, viewportMatch ? 0 : 1, spacing);
        }
      } catch { signal.throwIfAborted(); }
    }
    signal.throwIfAborted();
    return fallbackSelection;
  };

  const primary = await runPass(false);
  if (primary || validTimeMs === undefined || !hasViewport) return primary;
  return runPass(true);
}
