/** Load a point's selected sample first, with bounded pages for the remaining forecast. */
import type { LayerId } from '@av/contracts/layers';
import { maxProfileFrames } from '@av/contracts/point-products';
import { renderedFrames, surfaceFrameCount, type ManifestV5 } from '@av/contracts/publication';
import type { PinnedBuild, PointFrame, PointHorizon, PointSeries, PointSeriesLoader, PointTerrain } from './client-types.ts';

const MAX_PAGES = 16;
const MAX_PROFILE_GROUPS_PER_PAGE = 6;
const liftLayers = ['usable-lift-msl', 'usable-lift-agl'] as const;
const diagnostics = ['precip-rate', 'thermal-velocity', 'thermal-top-msl', 'surface-lcl-msl',
  'bl-mean-wind-u', 'bl-mean-wind-v', 'wind-10m-u', 'wind-10m-v'] as const;
const scalarFields: readonly LayerId[] = [...liftLayers, ...diagnostics, 'cloud-cover-total'];

/** Page a frame axis so each request stays inside the point value budget. */
export function fieldSeriesPages(frameIds: readonly string[], fieldCount: number, maxSampleValues: number): string[][] {
  if (!Number.isSafeInteger(fieldCount) || fieldCount < 1) throw new RangeError('Field series requires a field');
  if (!Number.isSafeInteger(maxSampleValues) || maxSampleValues < 1) throw new RangeError('Field series exceeds the sample budget');
  const pageSize = Math.floor(maxSampleValues / fieldCount);
  if (pageSize < 1) throw new RangeError('Field series exceeds the sample budget');
  const pages: string[][] = [];
  for (let offset = 0; offset < frameIds.length; offset += pageSize) pages.push(frameIds.slice(offset, offset + pageSize));
  return pages;
}
// Chart scalars and the inputs to /profile cloud and wind diagnostics.
const profileFields: readonly LayerId[] = [...diagnostics, 'pbl-height-agl', 'wind-gust-10m',
  'sfc-temp-c', 'sfc-dewpoint-c', 'cape-jkg', 'cloud-cover-total', 'cloud-cover-low'];

/** Published map-lift layers and the frames where those layers can be sampled. */
export function pointLiftExpectation(build: PinnedBuild): { layers: readonly LayerId[]; frames: ReadonlySet<string> } {
  const { manifest } = build;
  const fine = manifest.surfaces.find(surface => surface.kind === 'fine');
  if (!fine) return { layers: [], frames: new Set() };
  const layers = liftLayers.filter(layer => fine.layers.includes(layer));
  return { layers, frames: new Set(manifest.frames.slice(0, surfaceFrameCount(manifest, fine)).map(frame => frame.id)) };
}

function nativeSurface({ manifest }: PinnedBuild) {
  return manifest.surfaces.find(surface => surface.kind === 'native');
}

function profileSeriesPages(
  manifest: ManifestV5,
  surface: NonNullable<ReturnType<typeof nativeSurface>>,
  frameIds: readonly string[],
  pageSize: number,
  preferredFrameId: string
): string[][] {
  if (!frameIds.length) return [];
  const profileGroups = surface.profiles?.groups ?? [];
  const indexById = new Map(manifest.frames.map((frame, index) => [frame.id, index]));
  const scalarGroups = surface.samples.format === 'frame-group-block-shards-v1'
    ? [...new Map(surface.samples.shards.map(shard => [shard.group, { firstFrame: shard.firstFrame, frameCount: shard.frameCount }])).values()]
    : [{ firstFrame: 0, frameCount: manifest.frames.length }];
  const buckets: string[][][] = scalarGroups.map(() => []);
  for (const group of profileGroups) {
    const selected = frameIds.filter(id => {
      const index = indexById.get(id);
      return index !== undefined && index >= group.firstFrame && index < group.firstFrame + group.frameCount;
    });
    if (!selected.length) continue;
    const scalarIndex = Math.max(0, scalarGroups.findIndex(scalar =>
      group.firstFrame >= scalar.firstFrame && group.firstFrame < scalar.firstFrame + scalar.frameCount));
    for (let offset = 0; offset < selected.length; offset += pageSize) {
      buckets[scalarIndex]!.push(selected.slice(offset, offset + pageSize));
    }
  }
  const activeBuckets = buckets.filter(bucket => bucket.length > 0);
  if (!activeBuckets.length) return fieldSeriesPages(frameIds, 1, pageSize);
  for (let maxGroups = MAX_PROFILE_GROUPS_PER_PAGE; ; maxGroups++) {
    const pages: string[][] = [];
    for (const bucket of activeBuckets) {
      const pageCount = Math.ceil(bucket.length / maxGroups);
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        const start = Math.floor(pageIndex * bucket.length / pageCount);
        const end = Math.floor((pageIndex + 1) * bucket.length / pageCount);
        const merged = bucket.slice(start, end).flat();
        for (let offset = 0; offset < merged.length; offset += pageSize) {
          pages.push(merged.slice(offset, offset + pageSize));
        }
      }
    }
    if (pages.length <= MAX_PAGES || maxGroups >= profileGroups.length) {
      const preferredIndex = pages.findIndex(page => page.includes(preferredFrameId));
      if (preferredIndex > 0) {
        const [preferred] = pages.splice(preferredIndex, 1);
        pages.unshift(preferred!);
      }
      return pages;
    }
  }
}

export function hasNativeProfiles(build: PinnedBuild): boolean {
  return nativeSurface(build)?.profiles !== undefined;
}

function pointSelection(build: PinnedBuild) {
  const native = nativeSurface(build);
  if (!native?.profiles) {
    const { manifest } = build;
    const layers = scalarFields.filter(layer => manifest.layers.includes(layer));
    return { layers, sample: { layers, frames: undefined }, profile: null };
  }
  const sample = pointLiftExpectation(build);
  const selected = native.layers.filter(layer => profileFields.includes(layer));
  // The profile route requires a scalar selection alongside the atmospheric levels.
  const layers = selected.length ? selected : native.layers.slice(0, 1);
  return { layers: [...sample.layers, ...layers], sample, profile: { layers, levelCount: native.profiles.levelCount } };
}

function pointFrames(manifest: ManifestV5, horizon: PointHorizon) {
  let frames = manifest.frames;
  if (horizon !== 'forecast') {
    if (manifest.mapFrameCount !== undefined) frames = renderedFrames(manifest);
    else {
      const until = Date.parse(frames[0].validTime) + 24 * 3600000;
      frames = frames.filter(frame => Date.parse(frame.validTime) < until);
    }
  }
  return frames.map(frame => frame.id);
}

export function pointSeriesSelection(build: PinnedBuild, horizon: PointHorizon = 'day') {
  const { layers } = pointSelection(build);
  return { layers, frames: layers.length ? pointFrames(build.manifest, horizon) : [] };
}

type ReadPage = (frames: readonly string[], layers: readonly LayerId[], signal: AbortSignal) => Promise<{ frames: readonly PointFrame[] }>;
interface PointSource {
  read: ReadPage;
  layers: readonly LayerId[];
  frames?: ReadonlySet<string>;
  ready: Set<string>;
  pageSize(): number;
}

export function createPointSeriesLoader(
  build: PinnedBuild,
  readSample: ReadPage,
  readProfile: ReadPage,
  assertLive: () => void,
  readTerrain?: (signal: AbortSignal) => Promise<PointTerrain | null>,
): PointSeriesLoader {
  const m = build.manifest, native = nativeSurface(build), cache = new Map<string, PointFrame>();
  const sampled = new Set<string>(), profiled = new Set<string>();
  let siteTerrain: PointTerrain | null | undefined;
  const { layers, sample, profile } = pointSelection(build);
  const sources: PointSource[] = [];
  if (sample.layers.length) sources.push({ read: readSample, layers: sample.layers, frames: sample.frames,
    ready: sampled, pageSize: () => Math.floor(m.descriptors.maxSampleValues / sample.layers.length) });
  if (profile) sources.push({ read: readProfile, layers: profile.layers, frames: undefined,
    ready: profiled, pageSize: () => maxProfileFrames(profile.levelCount, profile.layers.length) });
  let pending: Promise<unknown> = Promise.resolve(), active: AbortController | null = null, disposed = false;
  return {
    load(horizon, signal, options) {
      active?.abort();
      const controller = new AbortController(); active = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const previous = pending;
      const work = (async () => {
        await previous.catch(() => {});
        if (disposed) throw new Error('Point series is closed');
        const assertActive = () => { controller.signal.throwIfAborted(); assertLive(); };
        assertActive();
        if (!layers.length) throw new Error('Point fields are unavailable');
        const frames = pointFrames(m, horizon);
        const first = frames.find(id => id === options?.frameId) ?? frames[0];
        const plans = sources.map(source => {
          const missing = frames.filter(id => (!source.frames || source.frames.has(id)) && !source.ready.has(id));
          const requests: string[][] = [];
          const parallel = source.ready === profiled && (native?.profiles?.groups.length ?? 0) > MAX_PROFILE_GROUPS_PER_PAGE;
          if (missing.length) {
            const pageSize = source.pageSize();
            if (pageSize < 1) throw new RangeError('Point response exceeds the byte budget');
            if (parallel && native) {
              const pages = profileSeriesPages(m, native, missing, pageSize, first);
              if (pages.length > MAX_PAGES) throw new RangeError('Point forecast page budget exceeded');
              requests.push(...pages);
            } else {
              if (missing.includes(first)) requests.push([first]);
              const rest = missing.filter(id => id !== first);
              const restPages = fieldSeriesPages(rest, 1, pageSize);
              if (requests.length + restPages.length > MAX_PAGES) throw new RangeError('Point forecast page budget exceeded');
              requests.push(...restPages);
            }
          }
          return { source, requests, parallel };
        });
        const view = (): PointSeries => ({
          layers,
          frames: frames.flatMap(id => cache.get(id) ?? []),
          ...(siteTerrain ? { siteTerrain } : {}),
        });
        const progress = (loading: boolean, result?: PointSeries) => {
          assertActive();
          options?.onProgress?.(result ?? view(), frames.length, loading);
          assertActive();
        };
        const needsTerrain = readTerrain !== undefined && siteTerrain === undefined;
        let outstanding = plans.reduce((count, plan) => count + plan.requests.length, 0) + (needsTerrain ? 1 : 0);
        // Fetch sources in parallel, giving the selected map sample the first view.
        let selectedLiftPending = sample.layers.length > 0 && sample.frames?.has(first) === true && !sampled.has(first);
        if (outstanding && !selectedLiftPending && cache.has(first)) progress(true);
        let failure: { cause: unknown } | undefined;
        const terrainTask = needsTerrain
          ? (async () => {
              try {
                const resolved = await readTerrain(controller.signal);
                assertActive();
                // Keep transient unavailable tile outcomes retryable while latching authoritative null/valid/outside-domain.
                siteTerrain = resolved?.status === 'unavailable' ? undefined : resolved;
              } catch {
                assertActive();
                // Transient failure: leave siteTerrain undefined so a subsequent load retries.
              }
              if (--outstanding > 0 && !selectedLiftPending && cache.size > 0) progress(true);
            })()
          : Promise.resolve();
        const settled = await Promise.allSettled([
          terrainTask,
          ...plans.map(async ({ source, requests, parallel }) => {
            const applyPage = (response: { frames: readonly PointFrame[] }) => {
              for (const frame of response.frames) {
                const previousFrame = cache.get(frame.id);
                cache.set(frame.id, previousFrame
                  ? { ...previousFrame, ...frame, layers: { ...previousFrame.layers, ...frame.layers } }
                  : frame);
                source.ready.add(frame.id);
              }
            };
            if (parallel && requests.length > 1) {
              const results = await Promise.all(requests.map(async (ids, index) => {
                let response;
                try { response = await source.read(ids, source.layers, controller.signal); }
                catch (cause) {
                  assertActive();
                  failure ??= { cause };
                  --outstanding;
                  return false;
                }
                assertActive();
                applyPage(response);
                if (--outstanding > 0 && index === 0 && !selectedLiftPending) progress(true);
                return true;
              }));
              if (outstanding > 0 && !selectedLiftPending && results.slice(1).some(Boolean)) progress(true);
              return;
            }
            for (const [index, ids] of requests.entries()) {
              const selectsLift = selectedLiftPending && source.ready === sampled;
              let response;
              try { response = await source.read(ids, source.layers, controller.signal); }
              catch (cause) {
                assertActive();
                failure ??= { cause };
                outstanding -= requests.length - index;
                if (selectsLift) {
                  selectedLiftPending = false;
                  if (outstanding && cache.has(first)) progress(true);
                }
                return;
              }
              assertActive();
              applyPage(response);
              if (selectsLift) selectedLiftPending = false;
              if (--outstanding > 0 && !selectedLiftPending) progress(true);
            }
          }),
        ]);
        for (const result of settled) if (result.status === 'rejected') throw result.reason;
        assertActive();
        const result = view();
        if (!failure || result.frames.length) progress(false, result);
        if (failure) throw failure.cause;
        return result;
      })();
      pending = work;
      return work.finally(() => {
        signal?.removeEventListener('abort', abort);
        if (active === controller) active = null;
      });
    },
    dispose() { disposed = true; active?.abort(); cache.clear(); sampled.clear(); profiled.clear(); siteTerrain = undefined; }
  };
}
