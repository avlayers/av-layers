import type { Map as MapLibreMap } from 'maplibre-gl';
import { ApiClient, normalizePoint, type PinnedBuild } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';

export interface SynopticField {
  readonly id: string;
  readonly buildId: string;
  readonly frame: string;
  readonly cols: number;
  readonly rows: number;
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly total: Float32Array;
  readonly low: Float32Array;
  readonly mslp: Float32Array;
  readonly hasClouds: boolean;
  readonly hasMslp: boolean;
  readonly cloudsEvaluated?: boolean;
  readonly mslpEvaluated?: boolean;
}

export interface ViewportBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface SynopticChannelNeed {
  readonly needClouds?: boolean;
  readonly needMslp?: boolean;
}

// Single 48-point batch (8x6) fits inside MAX_SAMPLE_POINTS=64 and packs 2–5 frames per HTTP request.
const SAMPLE_COLS = 8;
const SAMPLE_ROWS = 6;
const MAX_FIELD_CACHE = 256;
const MAX_FOREGROUND_INFLIGHT = 3;
const MAX_LAT = 85.05112878;

export function rawMapViewBounds(map: MapLibreMap): ViewportBounds {
  const b = map.getBounds();
  let west = b.getWest(), east = b.getEast();
  if (east <= west) east += 360;
  if (east - west > 340) { west = -179.9; east = 179.9; }
  const south = Math.max(-MAX_LAT, b.getSouth());
  const north = Math.min(MAX_LAT, b.getNorth());
  west = Math.max(-179.9, west);
  east = Math.min(179.9, east);
  if (east - west < 0.04) east = Math.min(179.9, west + 0.04);
  return { west, south, east, north };
}

/**
 * Computes a scale-proportional padded sample box (`38%` per edge) so local pans and
 * moderate zooms reuse cached synoptic grids without coarse quantization or re-fetching.
 */
export function scaleAdaptiveSampleBox(raw: ViewportBounds): ViewportBounds & { readonly key: string } {
  const spanLon = Math.max(0.04, raw.east - raw.west);
  const spanLat = Math.max(0.03, raw.north - raw.south);
  const padLon = Math.min(20, spanLon * 0.38);
  const padLat = Math.min(14, spanLat * 0.38);
  const west = Math.max(-179.9, raw.west - padLon);
  const east = Math.min(179.9, raw.east + padLon);
  const south = Math.max(-MAX_LAT, raw.south - padLat);
  const north = Math.min(MAX_LAT, raw.north + padLat);
  const step = Math.max(0.01, Math.min(0.5, Math.min(spanLon, spanLat) * 0.12));
  const q = (v: number) => (Math.round(v / step) * step).toFixed(3);
  return { west, south, east, north, key: `${q(west)},${q(south)},${q(east)},${q(north)}` };
}

export function synopticFieldCoversView(field: ViewportBounds, raw: ViewportBounds): boolean {
  if (field.west > raw.west || field.east < raw.east || field.south > raw.south || field.north < raw.north) {
    return false;
  }
  const viewSpanLon = Math.max(0.04, raw.east - raw.west);
  const fieldSpanLon = field.east - field.west;
  return fieldSpanLon <= viewSpanLon * 2.85;
}

/**
 * Orders forecast frames for pilot scrubbing:
 * 1. Immediate same-day scrub window (`+1, -1, +2, +3, -2, +4..+8`),
 * 2. Multi-day same-hour jump targets (`anchor` UTC hour on subsequent/prior days),
 * 3. Remaining horizon frames outward from `anchorFrame`.
 */
export function pilotHorizonFrameOrder(build: PinnedBuild, anchorFrame: string): string[] {
  const frames = renderedFrames(build.manifest);
  const anchorIdx = frames.findIndex(f => f.id === anchorFrame);
  if (anchorIdx < 0) return frames.map(f => f.id);

  const ordered: string[] = [];
  const seen = new Set<string>([anchorFrame]);
  const push = (idx: number) => {
    const f = frames[idx];
    if (f && !seen.has(f.id)) {
      seen.add(f.id);
      ordered.push(f.id);
    }
  };

  for (const offset of [1, -1, 2, 3, -2, 4, 5, 6, 7, 8]) push(anchorIdx + offset);

  const anchorMs = Date.parse(frames[anchorIdx]!.validTime);
  if (Number.isFinite(anchorMs)) {
    const anchorTodMs = ((anchorMs % 86_400_000) + 86_400_000) % 86_400_000;
    const sameHourIndices: Array<{ idx: number; dayDist: number }> = [];
    for (let i = 0; i < frames.length; i++) {
      if (seen.has(frames[i]!.id)) continue;
      const ms = Date.parse(frames[i]!.validTime);
      if (!Number.isFinite(ms)) continue;
      const tod = ((ms % 86_400_000) + 86_400_000) % 86_400_000;
      const diff = Math.min(Math.abs(tod - anchorTodMs), 86_400_000 - Math.abs(tod - anchorTodMs));
      if (diff <= 90 * 60_000) {
        sameHourIndices.push({ idx: i, dayDist: Math.abs(ms - anchorMs) });
      }
    }
    sameHourIndices.sort((a, b) => a.dayDist - b.dayDist);
    for (const item of sameHourIndices) push(item.idx);
  }

  for (let radius = 1; radius < frames.length; radius++) {
    push(anchorIdx + radius);
    push(anchorIdx - radius);
  }
  return ordered;
}

function fieldSatisfies(field: SynopticField, wantClouds: boolean, wantMslp: boolean): boolean {
  return (!wantClouds || field.hasClouds || Boolean(field.cloudsEvaluated)) &&
    (!wantMslp || field.hasMslp || Boolean(field.mslpEvaluated));
}

/**
 * Fetches, caches, and background-warms viewport-adaptive synoptic fields (`cloud-cover-total`,
 * `cloud-cover-low`, `mslp-hpa`) using multi-frame `api.samples` batches.
 */
export class SynopticSampler {
  private readonly cache = new Map<string, SynopticField>();
  private readonly fgInflight = new Map<string, { promise: Promise<SynopticField | null>; controller: AbortController }>();
  private warmAbort: AbortController | null = null;
  private warmToken = 0;
  private active: SynopticField | null = null;

  constructor(private readonly api: ApiClient) {}

  get current(): SynopticField | null {
    return this.active;
  }

  cancel(): void {
    this.pauseWarming();
    for (const entry of this.fgInflight.values()) entry.controller.abort();
    this.fgInflight.clear();
  }

  pauseWarming(): void {
    this.warmToken++;
    this.warmAbort?.abort();
    this.warmAbort = null;
  }

  resetActive(): void {
    this.cancel();
    this.active = null;
  }

  dispose(): void {
    this.resetActive();
    this.cache.clear();
  }

  findCached(build: PinnedBuild, frame: string, raw: ViewportBounds, needed: SynopticChannelNeed = {}): SynopticField | null {
    const hasTotal = build.manifest.layers.includes('cloud-cover-total');
    const hasMslp = build.manifest.layers.includes('mslp-hpa');
    const wantClouds = hasTotal && (needed.needClouds ?? true);
    const wantMslp = hasMslp && (needed.needMslp ?? true);
    if (!wantClouds && !wantMslp) return null;

    const buildId = build.manifest.buildId;
    const box = scaleAdaptiveSampleBox(raw);
    const exactKey = `${buildId}:${frame}:${box.key}`;
    const exact = this.cache.get(exactKey);
    if (exact && fieldSatisfies(exact, wantClouds, wantMslp)) {
      this.touchCache(exactKey, exact);
      return exact;
    }
    for (const [key, candidate] of this.cache) {
      if (
        candidate.buildId === buildId
        && candidate.frame === frame
        && fieldSatisfies(candidate, wantClouds, wantMslp)
        && synopticFieldCoversView(candidate, raw)
      ) {
        this.touchCache(key, candidate);
        return candidate;
      }
    }
    return null;
  }

  async load(
    build: PinnedBuild,
    frame: string,
    raw: ViewportBounds,
    needed: SynopticChannelNeed = {}
  ): Promise<SynopticField | null> {
    const hasTotal = build.manifest.layers.includes('cloud-cover-total');
    const hasLow = build.manifest.layers.includes('cloud-cover-low');
    const hasMslp = build.manifest.layers.includes('mslp-hpa');
    const wantClouds = hasTotal && (needed.needClouds ?? true);
    const wantMslp = hasMslp && (needed.needMslp ?? true);
    if (!wantClouds && !wantMslp) return null;

    const hit = this.findCached(build, frame, raw, needed);
    if (hit) {
      this.active = hit;
      return hit;
    }

    const box = scaleAdaptiveSampleBox(raw);
    const buildId = build.manifest.buildId;
    const cacheKey = `${buildId}:${frame}:${box.key}`;
    const partial = this.cache.get(cacheKey);

    const fetchClouds = wantClouds && !partial?.hasClouds && !partial?.cloudsEvaluated;
    const fetchMslp = wantMslp && !partial?.hasMslp && !partial?.mslpEvaluated;
    const inflightKey = `${cacheKey}:${fetchClouds ? 'c' : ''}${fetchMslp ? 'p' : ''}`;

    const existing = this.fgInflight.get(inflightKey);
    if (existing) {
      const resolved = await existing.promise;
      if (resolved) this.active = resolved;
      return resolved;
    }

    // Pause background warming while foreground frame misses are in flight.
    this.pauseWarming();

    while (this.fgInflight.size >= MAX_FOREGROUND_INFLIGHT) {
      const oldestKey = this.fgInflight.keys().next().value;
      if (oldestKey === undefined) break;
      this.fgInflight.get(oldestKey)?.controller.abort();
      this.fgInflight.delete(oldestKey);
    }

    const controller = new AbortController();
    const promise = this.fetchBatch(build, [frame], box, {
      fetchClouds,
      hasLow: fetchClouds && hasLow,
      fetchMslp
    }, controller.signal).then(fields => fields[0] ?? null).finally(() => {
      if (this.fgInflight.get(inflightKey)?.controller === controller) {
        this.fgInflight.delete(inflightKey);
      }
    });

    this.fgInflight.set(inflightKey, { promise, controller });
    const field = await promise;
    if (field) this.active = field;
    return field;
  }

  /**
   * Politely warms multi-frame synoptic batches across the forecast horizon in pilot scrub order
   * so subsequent hour drags and multi-day jumps resolve synchronously in `0 ms` from RAM.
   */
  warmHorizon(
    build: PinnedBuild,
    anchorFrame: string,
    raw: ViewportBounds,
    needed: SynopticChannelNeed
  ): void {
    const hasTotal = build.manifest.layers.includes('cloud-cover-total');
    const hasLow = build.manifest.layers.includes('cloud-cover-low');
    const hasMslp = build.manifest.layers.includes('mslp-hpa');
    const wantClouds = hasTotal && Boolean(needed.needClouds);
    const wantMslp = hasMslp && Boolean(needed.needMslp);
    if (!wantClouds && !wantMslp) return;

    this.pauseWarming();
    const token = this.warmToken;
    const controller = new AbortController();
    this.warmAbort = controller;

    const box = scaleAdaptiveSampleBox(raw);
    const buildId = build.manifest.buildId;
    const candidateFrames = pilotHorizonFrameOrder(build, anchorFrame);
    const missing = candidateFrames.filter(f => {
      const existing = this.cache.get(`${buildId}:${f}:${box.key}`);
      if (existing && fieldSatisfies(existing, wantClouds, wantMslp)) return false;
      for (const cand of this.cache.values()) {
        if (cand.buildId === buildId && cand.frame === f && fieldSatisfies(cand, wantClouds, wantMslp) && synopticFieldCoversView(cand, raw)) {
          return false;
        }
      }
      return true;
    });
    if (!missing.length) return;

    const layerCount = (wantClouds ? (hasLow ? 2 : 1) : 0) + (wantMslp ? 1 : 0);
    const maxValues = build.manifest.descriptors.maxSampleValues || 256;
    const pointsCount = SAMPLE_COLS * SAMPLE_ROWS;
    const batchSize = Math.max(1, Math.min(6, Math.floor(maxValues / Math.max(1, pointsCount * layerCount))));

    void (async () => {
      for (let i = 0; i < missing.length; i += batchSize) {
        if (token !== this.warmToken || controller.signal.aborted || build.expiresAtMs <= Date.now()) return;
        const batch = missing.slice(i, i + batchSize).filter(f => {
          const cur = this.cache.get(`${buildId}:${f}:${box.key}`);
          return !cur || !fieldSatisfies(cur, wantClouds, wantMslp);
        });
        if (!batch.length) continue;
        const ok = await this.fetchBatch(build, batch, box, {
          fetchClouds: wantClouds,
          hasLow: wantClouds && hasLow,
          fetchMslp: wantMslp
        }, controller.signal);
        if (!ok.length && controller.signal.aborted) return;
      }
    })();
  }

  private touchCache(key: string, field: SynopticField): void {
    this.cache.delete(key);
    this.cache.set(key, field);
  }

  private storeField(key: string, field: SynopticField): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= MAX_FIELD_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, field);
  }

  private async fetchBatch(
    build: PinnedBuild,
    frames: readonly string[],
    box: ViewportBounds & { readonly key: string },
    spec: { fetchClouds: boolean; hasLow: boolean; fetchMslp: boolean },
    signal: AbortSignal
  ): Promise<SynopticField[]> {
    const layers: LayerId[] = [];
    if (spec.fetchClouds) {
      layers.push('cloud-cover-total');
      if (spec.hasLow) layers.push('cloud-cover-low');
    }
    if (spec.fetchMslp) layers.push('mslp-hpa');
    if (!layers.length || !frames.length) return [];

    const points: { lat: number; lon: number }[] = [];
    for (let r = 0; r < SAMPLE_ROWS; r++) {
      const lat = box.north - (r / (SAMPLE_ROWS - 1)) * (box.north - box.south);
      for (let c = 0; c < SAMPLE_COLS; c++) {
        const lon = box.west + (c / (SAMPLE_COLS - 1)) * (box.east - box.west);
        points.push(normalizePoint(lat, lon));
      }
    }

    try {
      const res = await this.api.samples(build, {
        points,
        frames,
        layers,
        signal
      });
      if (signal.aborted) return [];

      const buildId = build.manifest.buildId;
      const out: SynopticField[] = [];

      for (let fIdx = 0; fIdx < frames.length; fIdx++) {
        const frameId = frames[fIdx]!;
        const cacheKey = `${buildId}:${frameId}:${box.key}`;
        const prev = this.cache.get(cacheKey);

        const total = spec.fetchClouds
          ? new Float32Array(points.length).fill(Number.NaN)
          : (prev?.total ?? new Float32Array(points.length).fill(Number.NaN));
        const low = spec.fetchClouds
          ? new Float32Array(points.length).fill(Number.NaN)
          : (prev?.low ?? new Float32Array(points.length).fill(Number.NaN));
        const mslp = spec.fetchMslp
          ? new Float32Array(points.length).fill(Number.NaN)
          : (prev?.mslp ?? new Float32Array(points.length).fill(Number.NaN));

        let validCloudCells = 0;
        let validMslpCells = 0;
        for (let i = 0; i < res.points.length; i++) {
          const sampleFrames = res.points[i]!.sample.frames;
          const frameEntry = sampleFrames[fIdx]?.id === frameId
            ? sampleFrames[fIdx]
            : sampleFrames.find(entry => entry.id === frameId);
          const frameLayers = frameEntry?.layers;
          if (spec.fetchClouds) {
            const tCell = frameLayers?.['cloud-cover-total'];
            const tVal = tCell && tCell.status !== 'unavailable' && tCell.status !== 'outside-domain' ? tCell.value : null;
            const lCell = spec.hasLow ? frameLayers?.['cloud-cover-low'] : undefined;
            const lVal = spec.hasLow
              ? (lCell && lCell.status !== 'unavailable' && lCell.status !== 'outside-domain' ? lCell.value : null)
              : (typeof tVal === 'number' && Number.isFinite(tVal) ? tVal * 0.55 : null);
            if (typeof tVal === 'number' && Number.isFinite(tVal)) {
              const clampedTotal = Math.max(0, Math.min(100, tVal)) * 0.01;
              total[i] = clampedTotal;
              low[i] = typeof lVal === 'number' && Number.isFinite(lVal)
                ? Math.max(0, Math.min(100, lVal)) * 0.01
                : clampedTotal * 0.55;
              validCloudCells++;
            } else {
              total[i] = Number.NaN;
              low[i] = Number.NaN;
            }
          }
          if (spec.fetchMslp) {
            const pCell = frameLayers?.['mslp-hpa'];
            const pVal = pCell && pCell.status !== 'unavailable' && pCell.status !== 'outside-domain' ? pCell.value : null;
            if (typeof pVal === 'number' && Number.isFinite(pVal) && pVal > 850 && pVal < 1090) {
              mslp[i] = pVal;
              validMslpCells++;
            } else {
              mslp[i] = Number.NaN;
            }
          }
        }

        const hasClouds = (spec.fetchClouds && validCloudCells > 0) || Boolean(prev?.hasClouds);
        const hasMslp = (spec.fetchMslp && validMslpCells > 0) || Boolean(prev?.hasMslp);
        const cloudsEvaluated = spec.fetchClouds || Boolean(prev?.cloudsEvaluated);
        const mslpEvaluated = spec.fetchMslp || Boolean(prev?.mslpEvaluated);
        // Bump id suffix if upgraded in place so downstream contour caches key cleanly on channel presence.
        const field: SynopticField = {
          id: `${cacheKey}:${hasClouds ? 'c' : ''}${hasMslp ? 'p' : ''}`,
          buildId,
          frame: frameId,
          cols: SAMPLE_COLS,
          rows: SAMPLE_ROWS,
          west: box.west,
          south: box.south,
          east: box.east,
          north: box.north,
          total,
          low,
          mslp,
          hasClouds,
          hasMslp,
          cloudsEvaluated,
          mslpEvaluated
        };
        this.storeField(cacheKey, field);
        out.push(field);
      }
      return out;
    } catch {
      return [];
    }
  }
}
