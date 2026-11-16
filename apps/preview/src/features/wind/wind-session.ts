import { normalizeLon } from '@av/contracts/geometry';
import type { PinnedBuild } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import { type WindDataCache, type WindPreparedGrid, WindCapacityError, WindDataSource } from '@av/client/wind';
import { STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts/layers';
import type { MapBoundsPort, Bounds } from '../map/viewport-policy';
import { boundsAreaKm2, cameraBounds, coversBounds, createViewportWarmth, FOCUS_DWELL_MS, windBounds } from '../map/viewport-policy';
import { PLAYBACK_STEP_MS } from '../timeline/timeline-model';
import type { WindField } from './wind-overlay';
import type { WindHeight, WindStatus } from './wind-model';

export interface WindSchedulerPort { fetch: typeof fetch }
export interface WindCachePort {
  isBuildUnavailable(buildId: string): boolean;
  readonly allocatedBytes: number;
  clear(): void;
}

export interface WindSessionOptions {
  readonly apiBaseUrl: string;
  readonly map: MapBoundsPort;
  readonly lowMemory: boolean;
  readonly scheduler: WindSchedulerPort;
  readonly cache: WindCachePort;
  readonly overlay: { setWindActive(active: boolean, resident: boolean): void };
  readonly field: { install?(field: WindField, prepared: WindPreparedGrid | null, mode: 'replace' | 'swap'): void; setField(field: WindField, mode: 'replace' | 'swap'): void; setPrepared(prepared: WindPreparedGrid | null): void; clear(): void };
  readonly publish: {
    status(status: WindStatus): void;
    quality(overview: boolean): void;
    displayed(displayed: boolean): void;
    reservation(): void;
    pointWind(): void;
  };
  readonly state: () => {
    build: PinnedBuild | null; selectedFrame: string | null; height: WindHeight; visible: boolean;
    mapReady: boolean; expired: boolean; mapFailed: boolean; aborted: boolean;
  };
  readonly displayedRaster: () => { build: PinnedBuild; frame: string } | null;
  readonly replacementFailed: () => boolean;
}

interface WindView { zoom: number; build: PinnedBuild; frame: string; bounds: Bounds; source: WindDataSource }
interface WindRequest extends WindView {
  controller: AbortController;
  key: string;
  core?: Bounds;
  settled?: 'ready' | 'unavailable';
  failed?: unknown;
  done?: Promise<'ready' | 'unavailable'>;
}

export interface WindSession {
  update(): void;
  reconcile(): void;
  clear(): void;
  setPlaying(playing: boolean): void;
  heightChanged(previous: WindHeight): void;
  readonly displayed: boolean;
  readonly resident: boolean;
  readonly preparation: { promised: number; admitted: number; ready: number; limited: boolean };
  readonly current: { build: PinnedBuild; frame: string; source: WindDataSource } | null;
  readonly installed: { build: PinnedBuild; frame: string; source: WindDataSource; height: WindHeight } | null;
  destroy(): void;
}

/** Numeric wind acquisition, blending and retention for the preview map. */
export function createWindSession(options: WindSessionOptions): WindSession {
  const { map, publish, field, state } = options;
  let windView: WindView | null = null, windRequest: WindRequest | null = null, windPrefetch: WindRequest | null = null, installedWind: WindView | null = null;
  let windDisplayed = false, windLoading = false, height: WindHeight = 'surface', installedHeight: WindHeight = 'surface';
  let fillTimer: ReturnType<typeof setTimeout> | null = null, queuedWindLoad: (() => void) | null = null, destroyed = false;
  let acquireStatus: WindStatus = 'unavailable';
  const windHeld = new Map<string, WindRequest>();
  const failures = new Map<string, number>();
  let admittedWindow: number | null = null, capacityBlocked = false, blockedBytes = 0;
  const warmth = createViewportWarmth();
  function fullHorizon(): boolean {
    const bounds = map.getBounds();
    return warmth.update(boundsAreaKm2([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]));
  }
  const isCapacity = (error: unknown): boolean => error instanceof WindCapacityError || (error instanceof RangeError && /byte budget/.test(error.message));
  const failureKey = (build: PinnedBuild, frame: string): string => `${build.manifest.buildId}:${frame}`;
  const cooling = (build: PinnedBuild, frame: string): boolean => (failures.get(failureKey(build, frame)) ?? 0) > Date.now();
  function recordFailure(build: PinnedBuild, frame: string, capacity: boolean): void {
    if (failures.size >= 256) failures.delete(failures.keys().next().value!);
    failures.set(failureKey(build, frame), Date.now() + (capacity ? 1_000 : 30_000));
  }
  function orderedFrames(build: PinnedBuild, selectedFrame: string): string[] {
    const frames = renderedFrames(build.manifest).map(frame => frame.id), index = frames.indexOf(selectedFrame);
    return frames.slice().sort((a, b) => Math.abs(frames.indexOf(a) - index) - Math.abs(frames.indexOf(b) - index));
  }
  function retainedCount(): number {
    const { build, selectedFrame } = state();
    if (!build || !selectedFrame) return windHeld.size;
    let count = windHeld.size;
    if (!windHeld.has(selectedFrame)) count++;
    return count;
  }
  function evictFarthest(limit: number): boolean {
    const { build, selectedFrame } = state();
    if (!build || !selectedFrame) return false;
    const keep = new Set(orderedFrames(build, selectedFrame).slice(0, limit)), evicted: [string, WindRequest][] = [];
    for (const [frame, held] of windHeld) {
      if (keep.has(frame) || held === windView || held === installedWind || held === windRequest || held === windPrefetch) continue;
      windHeld.delete(frame); evicted.push([frame, held]);
    }
    for (const [, held] of evicted) if (!retained(held)) held.source.dispose();
    return evicted.length > 0;
  }
  function unblockIfReleased(): void {
    const { build } = state();
    if (!capacityBlocked || options.cache.allocatedBytes >= blockedBytes) return;
    const promised = build ? renderedFrames(build.manifest).length : 0;
    capacityBlocked = false;
    if (admittedWindow !== null) admittedWindow = admittedWindow + 1 >= promised ? null : admittedWindow + 1;
  }
  const retiring = new Map<WindView, ReturnType<typeof setTimeout>>();

  const hasWindData = (): boolean => Boolean(state().build?.manifest.mapData);
  const retained = (view: WindView): boolean =>
    windView === view || windRequest === view || windPrefetch === view || retiring.has(view) || [...windHeld.values()].includes(view as WindRequest);

  function dropRetired(): void {
    for (const [view, timer] of retiring) { clearTimeout(timer); view.source.dispose(); }
    retiring.clear();
  }
  function retire(view: WindView): void {
    if (retiring.has(view)) return;
    retiring.set(view, setTimeout(() => {
      retiring.delete(view);
      if (!retained(view)) view.source.dispose();
    }, PLAYBACK_STEP_MS + 50));
  }
  function releasePrefetch(): void {
    const prefetch = windPrefetch;
    windPrefetch = null;
    if (!prefetch) return;
    prefetch.controller.abort();
    if (!retained(prefetch)) prefetch.source.dispose();
  }
  function cancelFill(): void {
    if (fillTimer !== null) { clearTimeout(fillTimer); fillTimer = null; }
  }
  function setStatus(status: WindStatus): void { publish.status(status); }

  function setField(mode: 'replace' | 'swap'): void {
    const view = windView;
    if (!view) return;
    if (mode === 'swap' && installedWind === view) return;
    const previous = mode === 'swap' ? installedWind : null;
    height = state().height;
    installedHeight = height;
    const prepared = typeof view.source.prepare === 'function' ? view.source.prepare(height) : null;
    const installed = typeof view.source.field === 'function' ? view.source.field(height) : {
      sample: (lat: number, lon: number) => {
        const sample = view.source.sample(lat, normalizeLon(lon), height);
        const status = sample.status === 'valid' ? STATUS_VALID : sample.status === 'no-lift' ? STATUS_NO_LIFT : sample.status === 'outside' ? STATUS_OUTSIDE : STATUS_UNAVAILABLE;
        return { ...sample, status };
      }
    };
    if (field.install) field.install(installed, prepared, mode);
    else { field.setField(installed, mode); field.setPrepared(prepared); }
    installedWind = view;
    windDisplayed = true;
    publish.displayed(true);
    if (previous && previous !== view) retire(previous);
  }

  function reconcile(): void {
    if (destroyed) return;
    const displayed = options.displayedRaster();
    const build = state().build;
    const sameBuild = Boolean(windView && windView.build === build);
    const aligned = Boolean(sameBuild && windView!.frame === state().selectedFrame && (!displayed || displayed.build === windView!.build && displayed.frame === windView!.frame));
    if (aligned) setField(installedWind && installedWind.build === windView!.build ? 'swap' : 'replace');
    else if (!sameBuild && windDisplayed) { field.clear(); windDisplayed = false; installedWind = null; publish.displayed(false); }
    publish.quality(!!(aligned && windView?.source.isOverview));
    if (aligned) setStatus('ready');
    else if (acquireStatus === 'unavailable' || options.replacementFailed()) setStatus('unavailable');
    else if (acquireStatus === 'loading' || windView) setStatus('loading');
    publish.reservation();
    publish.pointWind();
  }

  function dropUnusable(): void {
    const previous = windView;
    windView = null; installedWind = null; windDisplayed = false;
    field.clear(); publish.displayed(false);
    if (previous && !retained(previous)) previous.source.dispose();
  }

  function cancelRequest(): void {
    const request = windRequest;
    windRequest = null; queuedWindLoad = null;
    request?.controller.abort();
    if (request && !retained(request)) request.source.dispose();
  }

  function clear(): void {
    if (destroyed) return;
    cancelFill();
    for (const view of windHeld.values()) if (view !== windView && view !== windRequest) view.source.dispose();
    windHeld.clear();
    failures.clear();
    admittedWindow = null; capacityBlocked = false; blockedBytes = 0;
    releasePrefetch(); dropRetired(); cancelRequest();
    if (installedWind && installedWind !== windView) installedWind.source.dispose();
    windView?.source.dispose(); windView = null; installedWind = null; windDisplayed = false;
    acquireStatus = 'unavailable';
    field.clear(); publish.quality(false); publish.displayed(false); setStatus('unavailable'); publish.reservation(); publish.pointWind();
  }

  function scheduleFill(delay = FOCUS_DWELL_MS): void {
    if (destroyed || fillTimer !== null || windPrefetch || options.lowMemory) return;
    fillTimer = setTimeout(() => { fillTimer = null; ensurePrefetch(); }, delay);
  }

  function ensurePrefetch(): void {
    const { build, selectedFrame, visible, mapReady, expired, mapFailed } = state();
    if (destroyed || windPrefetch || options.lowMemory || !visible || !hasWindData() || !mapReady || !build || !selectedFrame || expired || mapFailed || !fullHorizon()) return;
    unblockIfReleased();
    const frames = renderedFrames(build.manifest);
    const ordered = orderedFrames(build, selectedFrame);
    const limit = admittedWindow ?? frames.length;
    const frame = ordered
      .filter(id => id !== selectedFrame && id !== windView?.frame && id !== windRequest?.frame && !windHeld.has(id) && !cooling(build, id))
      .find(id => ordered.findIndex(item => item === id) < limit);
    if (!frame) return;
    const bounds = windBounds(map, options.lowMemory);
    const request: WindRequest = {
      zoom: map.getZoom(), build, frame, bounds, core: cameraBounds(map), key: `prefetch:${frame}`, controller: new AbortController(),
      source: new WindDataSource(options.apiBaseUrl, {
        fetchImpl: (input, init) => options.scheduler.fetch(input, { ...init, priority: 'low' } as RequestInit),
        cache: options.cache as WindDataCache, coalesceSpans: true
      })
    };
    windPrefetch = request;
    const done = request.source.load({ ...request, signal: request.controller.signal }).then(status => { request.settled = status; return status; }, error => { request.failed = error; throw error; });
    request.done = done;
    void done.then(status => {
      if (windPrefetch !== request) return;
      windPrefetch = null;
      if (status === 'ready') {
        const admitted = request.source.admitted;
        if (admitted) request.bounds = [admitted[0], admitted[1], admitted[2], admitted[3]];
        if (typeof request.source.prepare === 'function') request.source.prepare(state().height);
        failures.delete(failureKey(request.build, request.frame));
        windHeld.set(request.frame, request); scheduleFill(0);
      } else {
        recordFailure(request.build, request.frame, false);
        if (!retained(request)) request.source.dispose();
        scheduleFill(FOCUS_DWELL_MS);
      }
    }, error => {
      let capacity = false;
      if (!request.controller.signal.aborted) {
        capacity = isCapacity(error);
        if (capacity) {
          capacityBlocked = true; blockedBytes = options.cache.allocatedBytes;
          admittedWindow = Math.max(1, retainedCount());
          evictFarthest(admittedWindow);
        } else recordFailure(request.build, request.frame, false);
      }
      if (windPrefetch === request) windPrefetch = null;
      if (!retained(request)) request.source.dispose();
      if (!capacity) scheduleFill(FOCUS_DWELL_MS);
    });
  }

  function watch(request: WindRequest, work?: Promise<'ready' | 'unavailable'>): void {
    windRequest = request;
    const run = async (): Promise<void> => {
      windLoading = true;
      const retain = () => Boolean(windView && windView.build === request.build && windView.frame === request.frame && coversBounds(windView.bounds, request.bounds));
      const pending = work ?? (request.done = request.source.load({ ...request, signal: request.controller.signal }));
      try {
        let status: 'ready' | 'unavailable';
        try { status = await pending; }
        catch (error) {
          if (!isCapacity(error) || request.controller.signal.aborted) throw error;
          releasePrefetch();
          if (!windView || retain()) throw error;
          for (const held of windHeld.values()) if (held !== windView) held.source.dispose();
          windHeld.clear();
          dropRetired(); windView.source.dispose(); windView = null; windDisplayed = false; installedWind = null; field.clear(); publish.displayed(false);
          status = await request.source.load({ ...request, signal: request.controller.signal });
        }
        if (destroyed || windRequest !== request || request.controller.signal.aborted) return;
        if (status === 'ready') {
          const previous = windView;
          const admitted = request.source.admitted;
          if (admitted) request.bounds = [admitted[0], admitted[1], admitted[2], admitted[3]];
          windView = request;
          windHeld.set(request.frame, request);
          if (previous && previous !== request && previous.frame !== request.frame && previous.build === request.build) windHeld.set(previous.frame, previous as WindRequest);
          else if (previous && previous !== request && (previous !== installedWind || !(windDisplayed && previous.build === request.build))) {
            if (previous === installedWind) installedWind = null;
            if (!retained(previous)) previous.source.dispose();
          }
          acquireStatus = 'ready'; setStatus('ready');
        } else {
          const keep = retain();
          acquireStatus = keep ? 'ready' : 'unavailable';
          setStatus(acquireStatus);
          if (!keep) { recordFailure(request.build, request.frame, false); dropUnusable(); }
        }
        reconcile();
        if (status === 'ready') scheduleFill();
      } catch {
        if (windRequest === request && !request.controller.signal.aborted) {
          const keep = retain(); acquireStatus = keep ? 'ready' : 'unavailable'; setStatus(acquireStatus); if (!keep) dropUnusable(); reconcile();
        }
      } finally {
        if (windRequest === request) windRequest = null;
        if (!retained(request)) request.source.dispose();
        windLoading = false;
        if (!destroyed && acquireStatus !== 'ready') scheduleFill(FOCUS_DWELL_MS);
        const next = queuedWindLoad; queuedWindLoad = null; next?.();
      }
    };
    if (windLoading) queuedWindLoad = () => { void run(); };
    else void run();
  }

  function update(): void {
    if (destroyed) return;
    const { build, selectedFrame, visible, mapReady, expired, mapFailed, aborted } = state();
    if (!visible || !hasWindData()) { cancelRequest(); releasePrefetch(); publish.reservation(); return; }
    if (!mapReady || !build || !selectedFrame || expired || mapFailed || aborted) return;
    if (options.cache.isBuildUnavailable(build.manifest.buildId)) { clear(); return; }
    if (admittedWindow !== null) evictFarthest(admittedWindow);
    const camera = cameraBounds(map), view = windBounds(map, options.lowMemory), identity = windView;
    const covered = (candidate: WindView) => (candidate.source.isOverview === false || map.getZoom() <= candidate.zoom) && coversBounds(candidate.bounds, camera);
    for (const [frame, held] of windHeld) if (held.build !== build || !covered(held)) { windHeld.delete(frame); if (!retained(held)) held.source.dispose(); }
    if (identity && identity.build === build && identity.frame === selectedFrame && covered(identity)) {
      cancelRequest(); acquireStatus = 'ready'; setStatus('ready'); reconcile(); scheduleFill(); return;
    }
    cancelFill();
    if (windPrefetch && !covered(windPrefetch)) releasePrefetch();
    const held = windHeld.get(selectedFrame);
    if (held && held.build === build && covered(held) && held.done) {
      windHeld.delete(selectedFrame); cancelRequest();
      watch(held, held.settled ? Promise.resolve(held.settled) : held.done); return;
    }
    const prefetch = windPrefetch;
    if (prefetch && prefetch.build === build && prefetch.frame === selectedFrame && covered(prefetch) && prefetch.done) {
      windPrefetch = null; cancelRequest();
      watch(prefetch, prefetch.settled ? Promise.resolve(prefetch.settled) : prefetch.done); return;
    }
    const key = JSON.stringify([build.manifest.model, build.manifest.buildId, selectedFrame, view, map.getZoom()]);
    if (key === windRequest?.key) return;
    if (identity && identity.build !== build) clear();
    else cancelRequest();
    acquireStatus = 'loading';
    setStatus('loading');
    const request: WindRequest = {
      zoom: map.getZoom(), build, frame: selectedFrame, bounds: view, core: camera, key, controller: new AbortController(),
      source: new WindDataSource(options.apiBaseUrl, { fetchImpl: options.scheduler.fetch, cache: options.cache as WindDataCache, coalesceSpans: true })
    };
    watch(request);
  }

  return {
    update, reconcile, clear,
    setPlaying(playing: boolean) { scheduleFill(playing ? 0 : FOCUS_DWELL_MS); },
    heightChanged(previous) { if (windDisplayed && previous !== state().height) setField('replace'); },
    get displayed() { return windDisplayed; },
    get resident() { return Boolean(windView || windRequest || windPrefetch || windHeld.size || retiring.size); },
    get preparation() {
      const build = state().build, promised = build ? renderedFrames(build.manifest).length : 0;
      const admitted = admittedWindow === null ? promised : Math.min(admittedWindow, promised);
      return { promised, admitted, ready: windHeld.size, limited: capacityBlocked || admitted < promised };
    },
    get current() { return windView; },
    get installed() { return installedWind && windDisplayed ? { build: installedWind.build, frame: installedWind.frame, source: installedWind.source, height: installedHeight } : null; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelFill();
      const owned = new Set<WindView>([...retiring.keys(), ...windHeld.values(), windView, installedWind, windRequest, windPrefetch].filter((view): view is WindView => Boolean(view)));
      for (const timer of retiring.values()) clearTimeout(timer);
      retiring.clear();
      for (const view of owned) view.source.dispose();
      windHeld.clear();
      failures.clear();
      windView = installedWind = windRequest = windPrefetch = null;
    }
  };

}
