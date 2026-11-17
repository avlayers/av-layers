import { normalizeLon } from '@av/contracts/geometry';
import type { ForecastRequestHandle, ForecastRequestSpec, PinnedBuild, PreparationBudget } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import { type WindDataCache, type WindPreparedGrid, WindCapacityError, WindDataSource } from '@av/client/wind';
import { STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts/layers';
import type { MapBoundsPort, Bounds } from '../map/viewport-policy';
import { cameraBounds, coversBounds } from '../map/viewport-policy';
import type { WindField } from './wind-overlay';
import type { WindHeight, WindStatus } from './wind-model';

export interface WindSchedulerPort {
  fetch: typeof fetch;
  request?: (spec: ForecastRequestSpec) => ForecastRequestHandle;
}
export interface WindCachePort {
  isBuildUnavailable(buildId: string): boolean;
  readonly allocatedBytes: number;
  clear(): void;
  onRelease?: (() => void) | null;
  evictUnreferenced?: () => number;
}

export interface WindSessionOptions {
  readonly apiBaseUrl: string;
  readonly map: MapBoundsPort;
  readonly lowMemory: boolean;
  readonly scheduler: WindSchedulerPort;
  readonly cache: WindCachePort;
  readonly budget?: PreparationBudget;
  readonly selectedPending?: (pending: boolean) => void;
  readonly relieveDisplay?: () => boolean;
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
interface WindJob extends WindView {
  controller: AbortController;
  status: 'loading' | 'ready';
  heights: Set<WindHeight>;
  done: Promise<void>;
}
interface Failure { attempts: number; retryAt: number | null }

export interface WindSession {
  update(): void;
  reconcile(): void;
  clear(): void;
  setPlaying(playing: boolean): void;
  heightChanged(previous: WindHeight): void;
  beforeRasterReveal(target: { build: PinnedBuild; frame: string }): void;
  readonly ready: ReadonlyMap<string, ReadonlySet<WindHeight>>;
  readonly staged: { build: PinnedBuild; frame: string; height: WindHeight } | null;
  readonly failed: ReadonlyMap<string, { attempts: number; retryAt: number | null }>;
  readonly memory: { numericBytes: number; preparedBytes: number; fieldSamplerBytes: number; horizonNumericRemaining: number | null; budgetUsed: number; budgetLimit: number | null };
  readonly displayed: boolean;
  readonly resident: boolean;
  readonly preparation: { promised: number; admitted: number; ready: number; limited: boolean };
  readonly current: { build: PinnedBuild; frame: string; source: WindDataSource } | null;
  readonly installed: { build: PinnedBuild; frame: string; source: WindDataSource; height: WindHeight; isOverview: boolean } | null;
  destroy(): void;
}

export function createWindSession(options: WindSessionOptions): WindSession {
  const { map, publish, field, state } = options;
  const jobs = new Map<string, WindJob>(), failures = new Map<string, Failure>();
  const parked = new Map<string, WindJob>();
  const inflight = new Set<WindJob>();
  let build: PinnedBuild | null = null, installed: WindJob | null = null, installedHeight: WindHeight = 'surface';
  let timer: ReturnType<typeof setTimeout> | null = null, timerAt = 0, preparationTimer: ReturnType<typeof setTimeout> | null = null, expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false, limited = false, blockedBytes = 0, direction = 1, lastFrame: string | null = null, viewKey = '';
  let pending: boolean | undefined;
  const isCapacity = (error: unknown) => error instanceof WindCapacityError || (error instanceof Error && ('code' in error && error.code === 'capacity' || error instanceof RangeError && /byte budget/.test(error.message)));
  const bytes = () => options.budget?.used ?? options.cache.allocatedBytes;
  const capacity = (frame: string) => {
    let reclaimed = false;
    const prior = parked.entries().next().value;
    if (prior || frame === state().selectedFrame) {
      const distant = [...ordered()].reverse().map(key => jobs.get(key)).find(job => job && job.frame !== frame && job !== installed && job.status === 'ready');
      const victim = prior?.[1] ?? distant;
      if (victim) {
        if (prior) parked.delete(prior[0]); else jobs.delete(victim.frame);
        dispose(victim); reclaimed = true;
      }
    }
    options.cache.evictUnreferenced?.();
    limited = !(reclaimed || options.relieveDisplay?.()); blockedBytes = bytes();
    if (!limited) schedule();
  };
  const active = () => {
    const s = state();
    return !destroyed && s.visible && s.mapReady && !s.expired && !s.mapFailed && !s.aborted && !!s.build?.manifest.mapData && s.build.expiresAtMs > Date.now() && !!s.selectedFrame;
  };
  const selected = () => { const s = state(); return s.selectedFrame ? jobs.get(s.selectedFrame) : undefined; };
  const readyAt = (job: WindJob | undefined, height: WindHeight) => !!job && job.status === 'ready' && job.heights.has(height) && (typeof job.source.hasPrepared !== 'function' || job.source.hasPrepared(height)) && (typeof job.source.hasField !== 'function' || job.source.hasField(height));
  const usableAt = (job: WindJob | undefined, height?: WindHeight): boolean => {
    const s = state();
    return !!job && !!s.build && !s.expired && job.build === s.build && s.build.expiresAtMs > Date.now()
      && (height === undefined || readyAt(job, height)) && coversBounds(job.bounds, cameraBounds(map));
  };
  function setPending(value: boolean): void {
    if (pending === value) return;
    pending = value; options.selectedPending?.(value);
  }
  function schedule(delay = 0): void {
    const at = Date.now() + Math.max(0, delay);
    if (destroyed || timer !== null && timerAt <= at) return;
    if (timer !== null) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => { timer = null; pump(); }, Math.max(0, delay));
  }
  function cancelTimers(): void {
    if (timer !== null) clearTimeout(timer);
    if (preparationTimer !== null) clearTimeout(preparationTimer);
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    timer = preparationTimer = expiryTimer = null;
  }
  function clearField(): void {
    field.clear(); installed = null; publish.displayed(false); publish.quality(false); publish.pointWind();
  }
  function dispose(job: WindJob): void {
    if (installed === job) clearField();
    job.controller.abort();
    job.source.dispose();
  }
  function reset(): void {
    cancelTimers();
    clearField();
    for (const job of jobs.values()) dispose(job);
    for (const job of parked.values()) dispose(job);
    parked.clear();
    jobs.clear(); failures.clear(); limited = false; blockedBytes = 0; build = null; lastFrame = null; viewKey = '';
    setPending(false); options.overlay.setWindActive(false, false); publish.status('unavailable'); publish.reservation();
  }
  function ordered(): string[] {
    const s = state();
    if (!s.build || !s.selectedFrame) return [];
    const frames = renderedFrames(s.build.manifest).map(frame => frame.id), index = frames.indexOf(s.selectedFrame);
    if (index < 0) return [];
    return frames.slice().sort((a, b) => {
      const da = frames.indexOf(a) - index, db = frames.indexOf(b) - index;
      return Math.abs(da) - Math.abs(db) || (db * direction - da * direction);
    });
  }
  function prepare(job: WindJob, height: WindHeight): boolean {
    if (readyAt(job, height)) return true;
    try {
      const prepared = job.source.prepare?.(height);
      if (!prepared) {
        jobs.delete(job.frame); dispose(job); recordFailure(job.frame); return false;
      }
      job.source.field?.(height);
      job.heights.add(height);
      failures.delete(job.frame);
      return true;
    } catch (error) {
      if (isCapacity(error)) { capacity(job.frame); return false; }
      jobs.delete(job.frame); dispose(job); recordFailure(job.frame); return false;
    }
  }
  function install(job: WindJob, height: WindHeight): boolean {
    if (!readyAt(job, height)) return false;
    try {
      const prepared = job.source.prepare(height);
      if (!prepared) return false;
      const sampler = typeof job.source.field === 'function' ? job.source.field(height) : {
        sample: (lat: number, lon: number) => {
          const sample = job.source.sample(lat, normalizeLon(lon), height);
          const status = sample.status === 'valid' ? STATUS_VALID : sample.status === 'no-lift' ? STATUS_NO_LIFT : sample.status === 'outside' ? STATUS_OUTSIDE : STATUS_UNAVAILABLE;
          return { ...sample, status };
        }
      };
      if (field.install) field.install(sampler, prepared, 'replace');
      else { field.setField(sampler, 'replace'); field.setPrepared(prepared); }
      installed = job; installedHeight = height;
      publish.displayed(true); publish.quality(job.source.isOverview === true); publish.pointWind();
      return true;
    } catch (error) {
      if (!isCapacity(error)) throw error;
      capacity(job.frame); return false;
    }
  }
  function reconcile(): void {
    if (destroyed) return;
    const s = state(), raster = options.displayedRaster(), job = selected();
    if (installed && (installedHeight !== s.height || !usableAt(installed))) clearField();
    const matches = !!raster && raster.build === s.build && raster.frame === s.selectedFrame;
    if (matches && usableAt(job, s.height) && job && (installed !== job || installedHeight !== s.height)) {
      if (installed) clearField();
      install(job, s.height);
    }
    const available = usableAt(job, s.height);
    const failure = s.selectedFrame ? failures.get(s.selectedFrame) : undefined;
    setPending(active() && !available && !limited && (!failure || job?.status === 'loading'));
    publish.status(options.replacementFailed() || failure ? 'unavailable' : available ? 'ready' : active() ? 'loading' : 'unavailable');
    options.overlay.setWindActive(active(), jobs.size > 0);
    publish.reservation();
  }
  function schedulePreparation(): void {
    if (destroyed || preparationTimer !== null || limited) return;
    preparationTimer = setTimeout(() => {
      preparationTimer = null;
      if (!active()) return;
      const height = state().height;
      const job = ordered().map(frame => jobs.get(frame)).find(value => value?.status === 'ready' && !readyAt(value, height));
      if (!job) return;
      if (prepare(job, height)) { reconcile(); schedulePreparation(); }
    }, 0);
  }
  function recordFailure(frame: string): void {
    const attempts = (failures.get(frame)?.attempts ?? 0) + 1;
    const retryAt = attempts >= 4 ? null : Date.now() + 30_000;
    failures.set(frame, { attempts, retryAt });
    if (retryAt !== null) schedule(retryAt - Date.now());
  }
  function start(frame: string, foreground: boolean): void {
    const s = state();
    if (!s.build || inflight.size >= 8) return;
    const bounds = cameraBounds(map), controller = new AbortController();
    const source = new WindDataSource(options.apiBaseUrl, {
      fetchImpl: foreground ? options.scheduler.fetch : (input, init) => options.scheduler.fetch(input, { ...init, priority: 'low' } as RequestInit),
      ...(options.scheduler.request ? { request: (spec: ForecastRequestSpec) => options.scheduler.request!(spec) } : {}),
      cache: options.cache as WindDataCache, budget: options.budget, priority: foreground ? 'foreground' : 'background',
      horizon: renderedFrames(s.build.manifest).length, overviewForHorizon: true, coalesceSpans: true
    });
    const job: WindJob = { zoom: map.getZoom(), build: s.build, frame, bounds, controller, source, status: 'loading', heights: new Set(), done: Promise.resolve() };
    jobs.set(frame, job); inflight.add(job);
    job.done = source.load({ build: job.build, frame, bounds, core: bounds, signal: controller.signal }).then(status => {
      if (jobs.get(frame) !== job || controller.signal.aborted || destroyed) return;
      if (status === 'ready') {
        job.status = 'ready';
        if (source.admitted) job.bounds = [...source.admitted] as Bounds;
      } else {
        jobs.delete(frame); source.dispose(); recordFailure(frame);
      }
    }, error => {
      if (jobs.get(frame) !== job || controller.signal.aborted || destroyed) return;
      jobs.delete(frame); source.dispose();
      if (isCapacity(error)) {
        capacity(frame);
      } else recordFailure(frame);
    }).finally(() => {
      inflight.delete(job);
      if (destroyed || build !== job.build || !active()) return;
      if (controller.signal.aborted) { schedule(); return; }
      const current = selected();
      if (current?.status === 'ready') prepare(current, state().height);
      reconcile(); schedule(); schedulePreparation();
    });
  }
  function pump(): void {
    if (!active()) { setPending(false); return; }
    const s = state(), frames = ordered(), current = selected();
    if (!current && s.selectedFrame) {
      const failure = failures.get(s.selectedFrame);
      if (!limited && (!failure || failure.retryAt !== null && failure.retryAt <= Date.now())) start(s.selectedFrame, true);
    }
    const selectedJob = selected();
    if (selectedJob?.status === 'ready' && !readyAt(selectedJob, s.height)) prepare(selectedJob, s.height);
    reconcile();
    const selectedFailure = s.selectedFrame ? failures.get(s.selectedFrame) : undefined;
    if (!limited && (readyAt(selected(), s.height) || !selected() && selectedFailure && (selectedFailure.retryAt === null || selectedFailure.retryAt > Date.now()))) {
      let background = [...jobs.values()].filter(job => job.status === 'loading' && job.frame !== s.selectedFrame).length;
      for (const frame of frames) {
        if (background >= 6) break;
        const failure = failures.get(frame);
        if (jobs.has(frame) || failure && (failure.retryAt === null || failure.retryAt > Date.now())) continue;
        start(frame, false); background++;
      }
    }
    schedulePreparation();
    const deadlines = [...failures.values()].flatMap(failure => failure.retryAt !== null && failure.retryAt > Date.now() ? [failure.retryAt] : []);
    if (deadlines.length && !limited) schedule(Math.min(...deadlines) - Date.now());
  }
  function update(): void {
    if (destroyed) return;
    const s = state();
    if (!active() || !s.build || !s.selectedFrame) { reset(); return; }
    const camera = cameraBounds(map);
    if (build && build !== s.build) reset();
    if (!build) {
      const selectedBuild = s.build;
      const expire = () => {
        if (build !== selectedBuild) return;
        const remaining = selectedBuild.expiresAtMs - Date.now();
        if (remaining <= 0) reset();
        else expiryTimer = setTimeout(expire, Math.min(2_147_483_647, remaining));
      };
      expiryTimer = setTimeout(expire, Math.min(2_147_483_647, selectedBuild.expiresAtMs - Date.now()));
    }
    build = s.build;
    const nextView = `${map.getZoom()}:${camera.join(',')}`;
    if (viewKey && viewKey !== nextView) { failures.clear(); limited = false; blockedBytes = 0; }
    viewKey = nextView;
    const fits = (job: WindJob) => job.build === s.build && coversBounds(job.bounds, camera) && (!job.source.isOverview || map.getZoom() <= job.zoom);
    if ([...jobs.values()].some(job => !fits(job)) || !jobs.size && [...parked.values()].some(fits)) {
      const restored = [...parked].filter(([, job]) => fits(job));
      for (const [frame, job] of parked) if (!restored.some(([key]) => key === frame)) dispose(job);
      parked.clear();
      for (const [frame, job] of jobs) {
        if (installed === job && !fits(job)) clearField();
        if (job.status === 'ready') parked.set(frame, job); else dispose(job);
      }
      jobs.clear();
      for (const [frame, job] of restored) jobs.set(frame, job);
    }
    if (lastFrame !== s.selectedFrame) {
      const previousSource = lastFrame ? jobs.get(lastFrame)?.source as (WindDataSource & { setPriority?: (priority: 'foreground' | 'background') => void }) | undefined : undefined;
      previousSource?.setPriority?.('background');
      const frames = renderedFrames(s.build.manifest).map(frame => frame.id), previous = lastFrame ? frames.indexOf(lastFrame) : -1, next = frames.indexOf(s.selectedFrame);
      if (previous >= 0 && next >= 0 && previous !== next) direction = next > previous ? 1 : -1;
      lastFrame = s.selectedFrame;
      if (!selected()) {
        const loading = [...jobs.values()].filter(job => job.status === 'loading');
        if (loading.length > 6) {
          const victim = [...ordered()].reverse().map(frame => jobs.get(frame)).find(job => job?.status === 'loading' && job !== installed);
          if (victim) { jobs.delete(victim.frame); dispose(victim); }
        }
      }
      if (!selected()) { limited = false; blockedBytes = 0; }
      selected()?.source.promote?.();
    }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    pump();
  }
  const released = () => {
    if (!limited || destroyed) return;
    const reclaimed = options.cache.evictUnreferenced?.() ?? 0;
    if (bytes() >= blockedBytes && reclaimed === 0) return;
    limited = false; schedule();
  };
  if ('onRelease' in options.cache) options.cache.onRelease = released;
  const unsubscribe = options.budget?.onRelease(released);
  return {
    update, reconcile, clear: reset,
    setPlaying() { schedule(); },
    heightChanged(previous) {
      const s = state();
      if (previous === s.height || destroyed) return;
      if (preparationTimer !== null) { clearTimeout(preparationTimer); preparationTimer = null; }
      failures.clear(); limited = false; blockedBytes = 0;
      if (installed && installedHeight !== s.height) clearField();
      const job = selected();
      if (job?.status === 'ready') prepare(job, s.height);
      reconcile(); schedule(); schedulePreparation();
    },
    beforeRasterReveal(target) {
      if (destroyed) return;
      const s = state(), camera = cameraBounds(map);
      if (installed && installed.build === target.build && installed.frame === target.frame && installedHeight === s.height && coversBounds(installed.bounds, camera)) return;
      clearField();
      const job = selected();
      if (active() && target.build === s.build && target.frame === s.selectedFrame && job && coversBounds(job.bounds, camera) && usableAt(job, s.height)) install(job, s.height);
    },
    get ready() {
      return new Map([...jobs].filter(([, job]) => job.status === 'ready' && usableAt(job)).map(([frame, job]) => [frame, new Set([...job.heights].filter(height => usableAt(job, height)))]));
    },
    get staged() { const s = state(), job = selected(); return job && usableAt(job, s.height) ? { build: job.build, frame: job.frame, height: s.height } : null; },
    get failed() { return new Map(failures); },
    get memory() {
      let preparedBytes = 0, fieldSamplerBytes = 0;
      for (const job of jobs.values()) {
        const memory = job.source.memoryUsage?.();
        preparedBytes += memory?.preparedBytes ?? 0; fieldSamplerBytes += memory?.fieldSamplerBytes ?? 0;
      }
      for (const job of parked.values()) {
        const memory = job.source.memoryUsage?.();
        preparedBytes += memory?.preparedBytes ?? 0; fieldSamplerBytes += memory?.fieldSamplerBytes ?? 0;
      }
      const snapshot = options.budget?.snapshot();
      return { numericBytes: options.cache.allocatedBytes,
        preparedBytes: snapshot?.['wind-prepared'] ?? preparedBytes,
        fieldSamplerBytes: snapshot?.['wind-sampler'] ?? fieldSamplerBytes,
        horizonNumericRemaining: selected()?.source.memoryUsage?.().horizonNumericRemaining ?? null,
        budgetUsed: options.budget?.used ?? options.cache.allocatedBytes, budgetLimit: options.budget?.limit ?? null };
    },
    get displayed() { return !!installed; },
    get resident() { return jobs.size + parked.size > 0; },
    get preparation() {
      const promised = state().build ? renderedFrames(state().build!.manifest).length : 0, height = state().height;
      return { promised, admitted: jobs.size, ready: [...jobs.values()].filter(job => usableAt(job, height)).length, limited };
    },
    get current() { const job = selected(); return job?.status === 'ready' && usableAt(job) ? job : null; },
    get installed() { return installed ? { build: installed.build, frame: installed.frame, source: installed.source, height: installedHeight, isOverview: installed.source.isOverview === true } : null; },
    destroy() {
      if (destroyed) return;
      reset(); destroyed = true; unsubscribe?.();
      if ('onRelease' in options.cache) options.cache.onRelease = null;
    }
  };
}
