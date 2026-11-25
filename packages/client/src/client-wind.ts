import pRetry from 'p-retry';
import { normalizeLon, prepareGridGeometry, withinGeographicBounds, type GeographicBounds, type Grid, type GridGeometry } from '@av/contracts/geometry';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts/layers';
import { WIND_CHUNK_LIMIT, WIND_FINE_CELL_BYTES, WIND_FRAME_LIMIT, WIND_HEIGHTS, WIND_INDEX_ENTRIES, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_TILE_SIZE, WIND_OVERVIEW_VALUES, assertWindFrameLayout, decodeTileMask, encodeWindByte, parseWindFrame, windLayout, windOverviewLayout, type TileMask } from '@av/contracts/wind-data';
import { nearerContributor } from '@av/forecast/sampler';
import { decodePackedWindChunk, encodeWindColumns, samplePackedWindColumns, type PackedWindChunk } from '@av/forecast/wind';
import type { PinnedBuild } from './client-types.ts';
import type { PreparationBudget, PreparationLease } from './client-preparation-budget.ts';
import type { ForecastRequestHandle, ForecastRequestSpec, RequestPriority } from './client-request-scheduler.ts';
import { MAX_CHUNKS, chunks, flags, offsets, overviewCoordinate, samplingPlan, targetHeight, tilesForBounds, validateChunk, values } from './client-wind-sampling.ts';
import { WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, WindCapacityError, WindDataCache, type CachedBytes, type PendingBytes } from './client-wind-cache.ts';

export { WIND_NUMERIC_BYTES, WIND_WINDOW_BYTES, WIND_WINDOW_ENTRIES, WindCapacityError, WindDataCache } from './client-wind-cache.ts';

type WindStatus = 'valid' | 'unavailable' | 'outside' | 'no-lift';
/** Positive, unwrapped longitude interval aligned to the world copy nearest the window center. */
export function preparedBounds(bounds: GeographicBounds): GeographicBounds {
  const [west, south, east, north] = bounds;
  const span = east >= west ? east - west : east + 360 - west;
  const start = normalizeLon(west + span / 2) - span / 2;
  return [start, south, start + span, north];
}

export interface WindPreparedGrid {
  readonly bounds: GeographicBounds;
  readonly data: Uint8Array<ArrayBuffer>;
  readonly size: number;
  readonly height: 'surface' | number | 'lift';
  readonly key: string;
  readonly retain?: () => () => void;
}
export interface WindPreparationOptions {
  readonly signal?: AbortSignal;
  readonly size?: number;
}
interface WindPreparationTask {
  readonly height: 'surface' | number | 'lift';
  readonly controller: AbortController;
  step(): boolean;
  finish(): WindPreparedGrid;
  cancel(reason?: unknown): void;
}
export interface WindSample { status: WindStatus; u: number | null; v: number | null }
interface Overview { stride: number; width: number; height: number; tilesAcross: number; data: Map<number, DataView> }
const empty = (status: WindStatus): WindSample => ({ status, u: null, v: null });
const DETAIL_MAX_BYTES = WIND_NUMERIC_BYTES / 2 - WIND_FRAME_LIMIT, SINGLE_VIEW_MAX_BYTES = WIND_NUMERIC_BYTES - WIND_FRAME_LIMIT;
const MAX_SPAN_BYTES = 1024 * 1024, SPAN_STRIPE = 8;
const REQUEST_TIMEOUT_MS = 15_000, FIELD_SLOTS = 8192;
/** Cancel reason for a queued request moved behind newer work; it re-runs without spending a retry. */
const DEMOTED_REQUEST = new Error('Demoted wind request');
const DEFAULT_PREPARED_GRID_SIZE = 128;
const PREPARATION_SLICE_MS = 4, PREPARATION_SLICE_ROWS = 8;
export const WIND_FIELD_SAMPLER_BYTES = FIELD_SLOTS * 17;
export const WIND_PREPARED_GRID_BYTES = DEFAULT_PREPARED_GRID_SIZE * DEFAULT_PREPARED_GRID_SIZE * 4;
const OUTSIDE_WIND = decodePackedWindChunk(encodeWindColumns([null], 1));

type WindRequestSpec = ForecastRequestSpec & { init?: RequestInit };
interface WindSourceOptions {
  fetchImpl?: typeof fetch;
  cache?: WindDataCache;
  budget?: PreparationBudget;
  request?: (spec: WindRequestSpec) => ForecastRequestHandle;
  priority?: RequestPriority;
  horizon?: number;
  overviewForHorizon?: boolean;
  coalesceSpans?: boolean;
  /** Transient failures retry with p-retry backoff: `retryMinTimeoutMs`, then ×4, jittered ×1–2. */
  retries?: number;
  retryMinTimeoutMs?: number;
}

class WindTransientError extends Error {
  constructor(message: string) { super(message); this.name = 'WindTransientError'; }
}

export class WindDataSource {
  private controller?: AbortController;
  private current?: { build: PinnedBuild; bounds: GeographicBounds; tileSize: number; fineTileSize: number; native: Grid; fineGrid: Grid; nativeGeometry: GridGeometry; fineGeometry: GridGeometry; wind: Map<number, PackedWindChunk>; fine: Map<number, DataView>; windMask?: TileMask; fineMask?: TileMask; overview?: Overview };
  private generation = 0;
  private disposed = false;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly cache: WindDataCache;
  private readonly held = new Set<CachedBytes>();
  private readonly preparedGrids = new Map<string, { grid: WindPreparedGrid; release(): void }>();
  private preparing?: WindPreparationTask;
  private readonly preparedUsage = { bytes: 0 };
  private readonly fields = new Map<string | number, { field: ReturnType<WindDataSource['field']>; dispose(): void }>();
  private readonly budget?: PreparationBudget;
  private horizonResources?: { root: string; tasks: Array<{ kind: string; tile: number; bytes: number }> };
  private foreground: boolean;
  private active?: AbortController;
  constructor(private readonly baseUrl: string, private readonly options: WindSourceOptions = {}) {
    if (options.horizon !== undefined && (!Number.isSafeInteger(options.horizon) || options.horizon < 1)) throw new RangeError('Invalid wind horizon');
    this.cache = options.cache ?? new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, options.budget);
    if (options.cache && options.budget) this.cache.bindBudget(options.budget);
    this.budget = options.budget ?? this.cache.preparationBudget;
    this.foreground = options.priority !== 'background';
  }

  promote(): void {
    this.setPriority('foreground');
  }

  setPriority(priority: RequestPriority): void {
    this.foreground = priority === 'foreground';
    for (const entry of this.held) if (entry.pending) {
      if (this.foreground) for (const handle of entry.pending.handles) handle.promote();
      else if (!this.pendingForeground(entry.pending)) for (const handle of entry.pending.handles) if (handle.started === false) { handle.cancel(DEMOTED_REQUEST); entry.pending.revoke.get(handle)?.(); }
      for (const wake of entry.pending.wake) wake();
    }
  }

  private pendingForeground(pending: PendingBytes): boolean {
    return pending.entries.some(entry => [...entry.owners].some(owner => owner.foreground));
  }

  memoryUsage(): { fieldSamplerBytes: number; preparedBytes: number; numericBytes: number; horizonNumericRemaining: number | null } {
    return { fieldSamplerBytes: this.fields.size * WIND_FIELD_SAMPLER_BYTES,
      preparedBytes: this.preparedUsage.bytes,
      numericBytes: this.cache.allocatedBytes,
      horizonNumericRemaining: this.horizonResources ? this.cache.horizonCost(this.horizonResources.root, this.horizonResources.tasks, this.options.horizon ?? 1).remaining : null };
  }

  get isOverview(): boolean | undefined {
    return this.current ? !!this.current.overview : undefined;
  }

  /** Overview stride actually loaded. Native detail has no stride. */
  get overviewStride(): number | null {
    return this.current?.overview?.stride ?? null;
  }

  hasField(height: 'surface' | number | 'lift'): boolean {
    return !!this.current && this.current.build.expiresAtMs > Date.now() && this.fields.has(height);
  }

  /** Fast direct-mapped quantized field sampler (~220 m cells, zero heap allocation) for 60fps map rendering. */
  field(height: 'surface' | number | 'lift'): { sample(lat: number, lon: number): { u: number | null; v: number | null; status: number } } {
    const cached = this.fields.get(height);
    if (cached) return cached.field;
    if (this.disposed) return { sample: () => ({ u: null, v: null, status: STATUS_UNAVAILABLE }) };
    if (this.fields.size >= 4) {
      const oldest = this.fields.keys().next().value!;
      this.fields.get(oldest)?.dispose(); this.fields.delete(oldest);
    }
    const lease = this.budget?.reserve('wind-sampler', WIND_FIELD_SAMPLER_BYTES, this.foreground ? 'foreground' : 'background');
    if (this.budget && !lease) throw new WindCapacityError();
    let storage: { keys: Float64Array; uv: Float32Array; statuses: Uint8Array } | undefined;
    try { storage = { keys: new Float64Array(FIELD_SLOTS).fill(-1), uv: new Float32Array(FIELD_SLOTS * 2), statuses: new Uint8Array(FIELD_SLOTS) }; }
    catch (error) { lease?.release(); throw error; }
    const out = { u: null as number | null, v: null as number | null, status: STATUS_UNAVAILABLE };
    let gen = this.generation;
    const field = {
      sample: (lat: number, lon: number) => {
        if (!this.current || this.current.build.expiresAtMs <= Date.now()) {
          this.current = undefined; out.status = STATUS_UNAVAILABLE; out.u = out.v = null; return out;
        }
        if (!storage) {
          const sample = this.sample(lat, lon, height);
          out.status = sample.status === 'valid' ? STATUS_VALID : sample.status === 'no-lift' ? STATUS_NO_LIFT : sample.status === 'outside' ? STATUS_OUTSIDE : STATUS_UNAVAILABLE;
          out.u = sample.u; out.v = sample.v; return out;
        }
        const { keys, uv, statuses } = storage;
        if (gen !== this.generation) { keys.fill(-1); gen = this.generation; }
        const wrapped = normalizeLon(lon);
        const iy = Math.round((lat + 90) * 500), ix = Math.round((wrapped + 180) * 500);
        const tag = iy * 180_002 + ix, slot = ((Math.imul(iy, 2654435761) ^ Math.imul(ix, 2246822519)) >>> 0) & (FIELD_SLOTS - 1);
        if (keys[slot] === tag) {
          const st = statuses[slot];
          out.status = st; out.u = st === STATUS_VALID ? uv[slot * 2] : null; out.v = st === STATUS_VALID ? uv[slot * 2 + 1] : null;
          return out;
        }
        const s = this.sample(lat, wrapped, height);
        const st = s.status === 'valid' ? STATUS_VALID : s.status === 'no-lift' ? STATUS_NO_LIFT : s.status === 'outside' ? STATUS_OUTSIDE : STATUS_UNAVAILABLE;
        keys[slot] = tag; statuses[slot] = st;
        uv[slot * 2] = s.u ?? 0; uv[slot * 2 + 1] = s.v ?? 0;
        out.status = st; out.u = s.u; out.v = s.v;
        return out;
      }
    };
    this.fields.set(height, { field, dispose: () => { storage = undefined; lease?.release(); } });
    return field;
  }

  /**
   * Quantized rendered lattice for the admitted extent. Sampling runs against the scientific
   * sampler once per retained frame; selection only uploads the returned bytes.
   */
  hasPrepared(height: 'surface' | number | 'lift', size = DEFAULT_PREPARED_GRID_SIZE): boolean {
    return !!this.current && this.current.build.expiresAtMs > Date.now() && this.preparedGrids.has(`${this.generation}:${height}:${size}`);
  }

  prepare(height: 'surface' | number | 'lift', size = DEFAULT_PREPARED_GRID_SIZE): WindPreparedGrid | null {
    const task = this.beginPreparation(height, size);
    if (!task || !('step' in task)) return task;
    try {
      while (task.step()) { /* The synchronous API completes every row in this turn. */ }
      return task.finish();
    } finally { task.cancel(); }
  }

  /** Yield between small row batches; a new preparation, load or disposal cancels unfinished work. */
  async prepareAsync(height: 'surface' | number | 'lift', options: WindPreparationOptions = {}): Promise<WindPreparedGrid | null> {
    options.signal?.throwIfAborted();
    const task = this.beginPreparation(height, options.size ?? DEFAULT_PREPARED_GRID_SIZE);
    if (!task || !('step' in task)) return task;
    const abort = () => task.cancel(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      let started = performance.now(), rows = 0;
      while (task.step()) {
        if (++rows < PREPARATION_SLICE_ROWS && performance.now() - started < PREPARATION_SLICE_MS) continue;
        await new Promise<void>((resolve, reject) => {
          const signal = task.controller.signal;
          const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(); }, 0);
          signal.addEventListener('abort', cancelled, { once: true });
          if (signal.aborted) cancelled();
        });
        rows = 0; started = performance.now();
      }
      return task.finish();
    } finally {
      options.signal?.removeEventListener('abort', abort);
      task.cancel();
    }
  }

  /** Reclaim historical heights while retaining the active height across the timeline. */
  trimHeights(height: 'surface' | number | 'lift'): void {
    if (this.preparing && this.preparing.height !== height) this.preparing.cancel();
    for (const [key, item] of this.preparedGrids) if (item.grid.height !== height) { item.release(); this.preparedGrids.delete(key); }
    for (const [key, item] of this.fields) if (key !== height) { item.dispose(); this.fields.delete(key); }
  }

  private beginPreparation(height: 'surface' | number | 'lift', size: number): WindPreparedGrid | WindPreparationTask | null {
    const current = this.current;
    if (!current || current.build.expiresAtMs <= Date.now()) return null;
    if (!Number.isSafeInteger(size) || size < 1 || size > 1024) throw new RangeError('Invalid wind preparation size');
    if (height !== 'surface' && height !== 'lift' && (!Number.isFinite(height) || height < 0)) throw new RangeError('Invalid AGL height');
    const key = `${this.generation}:${height}:${size}`;
    this.preparing?.cancel();
    const cached = this.preparedGrids.get(key);
    if (cached) return cached.grid;
    if (this.preparedGrids.size >= 4) {
      const oldest = this.preparedGrids.keys().next().value!;
      this.preparedGrids.get(oldest)!.release(); this.preparedGrids.delete(oldest);
    }
    const lease = this.budget?.reserve('wind-prepared', size * size * 4, this.foreground ? 'foreground' : 'background');
    if (this.budget && !lease) throw new WindCapacityError();
    let data: Uint8Array<ArrayBuffer>;
    try { data = new Uint8Array(new ArrayBuffer(size * size * 4)); } catch (error) { lease?.release(); throw error; }
    this.preparedUsage.bytes += data.byteLength;
    let references = 1;
    const release = () => {
      if (--references === 0) { this.preparedUsage.bytes -= data.byteLength; lease?.release(); }
    };
    const [west, south, east, north] = preparedBounds(current.bounds);
    const span = east - west, generation = this.generation, controller = new AbortController();
    let row = 0, settled = false;
    const grid: WindPreparedGrid = { bounds: [west, south, east, north], data, size, height, key, retain: () => {
      if (!references) throw new Error('Wind prepared grid is released');
      references++;
      let retained = true;
      return () => { if (retained) { retained = false; release(); } };
    } };
    const check = () => {
      controller.signal.throwIfAborted();
      if (this.current !== current || this.generation !== generation || current.build.expiresAtMs <= Date.now()) throw new DOMException('Wind preparation superseded', 'AbortError');
    };
    const task: WindPreparationTask = {
      height, controller,
      step: () => {
        check();
        const lat = south + (north - south) * (row + 0.5) / size;
        for (let x = 0; x < size; x++) {
          const sample = this.sample(lat, normalizeLon(west + span * (x + 0.5) / size), height);
          if (sample.status !== 'valid' || sample.u === null || sample.v === null) continue;
          const offset = (row * size + x) * 4;
          data[offset] = encodeWindByte(sample.u); data[offset + 1] = encodeWindByte(sample.v); data[offset + 3] = 255;
        }
        return ++row < size;
      },
      finish: () => {
        check(); settled = true;
        this.preparedGrids.set(key, { grid, release });
        if (this.preparing === task) this.preparing = undefined;
        return grid;
      },
      cancel: reason => {
        if (settled) return;
        settled = true; controller.abort(reason ?? new DOMException('Wind preparation cancelled', 'AbortError'));
        release();
        if (this.preparing === task) this.preparing = undefined;
      }
    };
    this.preparing = task;
    return task;
  }

  private clearPrepared(): void {
    this.preparing?.cancel();
    for (const item of this.preparedGrids.values()) item.release();
    this.preparedGrids.clear();
  }

  private release(): void {
    for (const entry of [...this.held]) this.releaseEntry(entry);
  }

  private releaseEntry(entry: CachedBytes): void {
    if (!this.held.delete(entry)) return;
    entry.owners.delete(this);
    this.cache.release(entry);
  }

  private hold(entry: CachedBytes): CachedBytes {
    if (this.held.has(entry)) this.cache.release(entry);
    else { this.held.add(entry); entry.owners.add(this); }
    return entry;
  }

  /** Bounds actually loaded. A padded request keeps the camera rectangle when the pad exceeds one view. */
  admitted: GeographicBounds | null = null;

  async load({ build, frame, bounds, core, signal, finerThan }: { build: PinnedBuild; frame: string; bounds: GeographicBounds; core?: GeographicBounds; signal?: AbortSignal; finerThan?: number }): Promise<'ready' | 'unavailable'> {
    this.controller?.abort(); this.current = undefined; this.admitted = null; this.horizonResources = undefined; this.clearPrepared(); this.generation++;
    if (this.disposed) throw new Error('Wind source is disposed');
    const controller = new AbortController(); this.controller = controller;
    const previous = this.pending;
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    this.pending = previous.then(() => turn);
    const waiting = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      waiting.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { waiting.removeEventListener('abort', abort); reject(waiting.reason); };
        waiting.addEventListener('abort', abort, { once: true });
        if (waiting.aborted) abort();
        previous.then(() => { waiting.removeEventListener('abort', abort); resolve(); });
      });
      waiting.throwIfAborted();
      this.release();
      this.active = controller;
      const abort = () => this.release();
      waiting.addEventListener('abort', abort, { once: true });
      try { return await this.loadView(build, frame, bounds, controller, signal, core, finerThan); }
      finally { waiting.removeEventListener('abort', abort); }
    } finally {
      if (this.active === controller) {
        this.active = undefined;
        if (this.disposed || controller.signal.aborted || !this.current) { this.horizonResources = undefined; this.release(); }
      }
      release();
    }
  }

  private async loadView(build: PinnedBuild, frame: string, bounds: GeographicBounds, controller: AbortController, signal?: AbortSignal, core?: GeographicBounds, finerThan?: number): Promise<'ready' | 'unavailable'> {
    if (build.expiresAtMs <= Date.now() || Date.parse(build.manifest.expiresAt) !== build.expiresAtMs) return 'unavailable';
    if (this.cache.isBuildUnavailable(build.manifest.buildId)) return 'unavailable';
    if (!build.manifest.frames.slice(0, build.manifest.mapFrameCount ?? build.manifest.frames.length).some(item => item.id === frame)) return 'unavailable';
    if (!bounds.every(Number.isFinite) || bounds[1] < -90 || bounds[3] > 90 || bounds[1] > bounds[3] || bounds[0] < -180 || bounds[0] > 180 || bounds[2] < -180 || bounds[2] > 180) throw new RangeError('Invalid wind bounds');
    const native = build.manifest.surfaces.find(s => s.kind === 'native'), fine = build.manifest.surfaces.find(s => s.kind === 'fine');
    if (!native || !fine) return 'unavailable';
    const baseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    baseSignal.throwIfAborted();
    const root = `${this.baseUrl.replace(/\/+$/, '')}/v1/models/${encodeURIComponent(build.manifest.model)}/runs/${encodeURIComponent(build.manifest.buildId)}/data/${encodeURIComponent(frame)}`;
    const readStream = async (url: string, type: string, targets: CachedBytes[], pending: PendingBytes): Promise<number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single'> => {
      const attemptSignal = pending.controller.signal;
      attemptSignal.throwIfAborted();
      if (this.cache.failureRemaining(url) > 0) throw new Error('Numeric resource is cooling down');
      const transient = (error: unknown) => error instanceof WindTransientError || (error instanceof TypeError && !attemptSignal.aborted);
      try {
        return await pRetry(() => readOnce(url, type, targets, pending), {
          retries: this.options.retries ?? 2, minTimeout: this.options.retryMinTimeoutMs ?? 250, factor: 4, randomize: true, signal: attemptSignal,
          shouldRetry: ({ error }) => error === DEMOTED_REQUEST || transient(error),
          shouldConsumeRetry: ({ error }) => error !== DEMOTED_REQUEST
        });
      } catch (error) {
        if (transient(error)) this.cache.recordFailure(url);
        throw error;
      }
    };
    const readOnce = async (url: string, type: string, targets: CachedBytes[], pending: PendingBytes): Promise<number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single'> => {
      const attemptSignal = pending.controller.signal;
      attemptSignal.throwIfAborted();
      const limit = targets.reduce((sum, item) => sum + item.capacity, 0);
      let foreground: boolean, responseLease: PreparationLease | undefined;
      for (;;) {
        foreground = this.pendingForeground(pending);
        const required = (pending.responseLease ? 0 : limit) + targets.reduce((sum, item) => sum + (item.bytes.length ? 0 : item.capacity), 0);
        if (!foreground && this.budget && required > this.budget.backgroundLimit) throw new WindCapacityError();
        if (!foreground && this.budget && !this.budget.canReserve(required, 'background')) this.cache.evictUnreferenced();
        if (!foreground && this.budget && !this.budget.canReserve(required, 'background')) {
          await new Promise<void>((resolve, reject) => {
            const finish = () => { unsubscribe(); cacheUnsubscribe(); pending.wake.delete(finish); attemptSignal.removeEventListener('abort', abort); resolve(); };
            const abort = () => { unsubscribe(); cacheUnsubscribe(); pending.wake.delete(finish); attemptSignal.removeEventListener('abort', abort); reject(attemptSignal.reason); };
            const unsubscribe = this.budget!.onRelease(finish);
            const cacheUnsubscribe = this.cache.onAvailable(finish);
            pending.wake.add(finish); attemptSignal.addEventListener('abort', abort, { once: true });
            if (attemptSignal.aborted) abort();
          });
          continue;
        }
        const allocated: CachedBytes[] = [];
        try {
          responseLease = pending.responseLease ?? this.cache.reserveResponse(limit, foreground);
          pending.responseLease = undefined;
          if (responseLease && responseLease.bytes !== limit && !responseLease.resize(limit)) throw new WindCapacityError();
          for (const item of targets) if (!item.bytes.length) { this.cache.allocate(item, foreground); allocated.push(item); }
          break;
        } catch (error) {
          for (const item of allocated) this.cache.unallocate(item);
          responseLease?.release(); responseLease = undefined;
          throw error;
        }
      }
      const reqCtrl = new AbortController(), timer = setTimeout(() => reqCtrl.abort(new DOMException('Numeric request timed out', 'TimeoutError')), REQUEST_TIMEOUT_MS);
      const reqSig = AbortSignal.any([attemptSignal, reqCtrl.signal]);
      let handle: ForecastRequestHandle | undefined;
      let demoted = false;
      const cancel = () => handle?.cancel(reqSig.reason);
      reqSig.addEventListener('abort', cancel, { once: true });
      try {
        reqSig.throwIfAborted();
        const init: RequestInit = { signal: reqSig, redirect: 'error' };
        if (this.options.request) {
          handle = this.options.request({ url, kind: type === 'application/json' ? 'json' : 'wind', priority: foreground ? 'foreground' : 'background', maxResponseBytes: limit,
            ...(type === 'application/json' ? {} : { exactResponseBytes: limit }),
            ...(responseLease && this.budget ? { responseLease: { budget: this.budget, lease: responseLease } } : {}), init });
          responseLease = undefined;
          pending.handles.add(handle);
          pending.revoke.set(handle, () => { for (const item of targets) if (item.used === null && item.pending === pending && item.bytes.length) this.cache.unallocate(item); });
          if (reqSig.aborted) cancel();
        }
        const res = await (handle ? handle.response : (this.options.fetchImpl ?? fetch)(url, init));
        if (targets.length > 1 && res.status === 400) { await res.body?.cancel(); return 'unsupported-span'; }
        if (targets.length > 1 && res.status === 404) { await res.body?.cancel(); return 'retry-single'; }
        if (res.status === 409) { await res.body?.cancel(); return 'product-unavailable'; }
        if (res.status === 404) { await res.body?.cancel(); return null; }
        if (res.status === 502 || res.status === 503 || res.status === 504) { await res.body?.cancel(); throw new WindTransientError(`Transient numeric response ${res.status}`); }
        if (!res.ok || res.headers.get('content-type')?.split(';')[0] !== type) { await res.body?.cancel(); throw new Error('Invalid numeric response'); }
        const declared = res.headers.get('content-length'), identity = (res.headers.get('content-encoding') ?? 'identity') === 'identity';
        if (declared !== null && identity && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await res.body?.cancel(); throw new Error('Numeric response exceeds budget'); }
        if (!res.body) throw new Error('Numeric response is empty');
        const reader = res.body.getReader();
        let cancellation: Promise<void> | undefined;
        const abort = () => { cancellation ??= reader.cancel(reqSig.reason).catch(() => {}); };
        reqSig.addEventListener('abort', abort, { once: true });
        if (reqSig.aborted) abort();
        let used = 0, slot = 0, slotOffset = 0;
        try {
          for (;;) {
            const next = await reader.read(); reqSig.throwIfAborted();
            if (next.done) break;
            if (used + next.value.length > limit) throw new Error('Numeric response exceeds budget');
            for (let pos = 0; pos < next.value.length;) {
              const dest = targets[slot]!.bytes, take = Math.min(dest.length - slotOffset, next.value.length - pos);
              dest.set(next.value.subarray(pos, pos + take), slotOffset);
              pos += take; used += take; slotOffset += take;
              if (slotOffset === dest.length) { slot++; slotOffset = 0; }
            }
          }
        } finally { reqSig.removeEventListener('abort', abort); await (cancellation ?? reader.cancel().catch(() => {})); reader.releaseLock(); }
        if (declared !== null && (res.headers.get('content-encoding') ?? 'identity') === 'identity' && used !== Number(declared)) throw new Error('Numeric response length mismatch');
        this.cache.clearFailure(url);
        return used;
      } catch (error) {
        demoted = error === DEMOTED_REQUEST && handle?.started === false;
        throw error;
      } finally {
        clearTimeout(timer); reqSig.removeEventListener('abort', cancel);
        if (handle) { await handle.settled; pending.handles.delete(handle); pending.revoke.delete(handle); }
        if (demoted) for (const item of targets) if (item.used === null && item.pending === pending && item.bytes.length) this.cache.unallocate(item);
        responseLease?.release();
      }
    };
    const wait = async (pending: PendingBytes) => {
      if (this.foreground) for (const handle of pending.handles) handle.promote();
      baseSignal.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(baseSignal.reason);
        baseSignal.addEventListener('abort', abort, { once: true });
        if (baseSignal.aborted) abort();
      });
      try { return await Promise.race([pending.promise, cancelled]); }
      catch (error) {
        if (baseSignal.aborted && pending.entries.every(entry => !entry.references)) await pending.promise.catch(() => {});
        throw error;
      } finally { baseSignal.removeEventListener('abort', abort); }
    };
    const descEntry = this.hold(this.cache.take(root, WIND_FRAME_LIMIT, build.expiresAtMs, this.foreground));
    const descPending = descEntry.used === null ? descEntry.pending ?? this.cache.start([descEntry], async pending => {
      const used = await readStream(root, 'application/json', [descEntry], pending);
      if (typeof used === 'number') {
        const parsed = parseWindFrame(descEntry.bytes.subarray(0, used));
        if (parsed.frame !== frame) throw new Error('Numeric frame mismatch');
        assertWindFrameLayout(parsed, { native: native.grid, fine: fine.grid });
        descEntry.used = used;
      }
      return used;
    }, this.cache.reserveResponse(WIND_FRAME_LIMIT, this.foreground)) : undefined;
    const descUsed = descEntry.used ?? await wait(descPending!);
    if (descUsed === 'product-unavailable') { this.cache.markBuildUnavailable(build.manifest.buildId); return 'unavailable'; }
    if (typeof descUsed !== 'number') return 'unavailable';
    const descriptor = parseWindFrame(descEntry.bytes.subarray(0, descUsed));
    if (descriptor.frame !== frame) throw new Error('Numeric frame mismatch');
    assertWindFrameLayout(descriptor, { native: native.grid, fine: fine.grid });
    descEntry.used = descUsed;

    const windTotal = windLayout(native.grid.width, native.grid.height, descriptor.tileSize, descriptor.levels);
    const fineTotal = windLayout(fine.grid.width, fine.grid.height, descriptor.fineTileSize);
    const windMask = decodeTileMask(descriptor.windMask, windTotal.count) ?? undefined;
    const fineMask = decodeTileMask(descriptor.fineMask, fineTotal.count) ?? undefined;
    let box = bounds;
    let winds = tilesForBounds(native.grid, bounds, descriptor.tileSize, 2, windMask);
    let fines = tilesForBounds(fine.grid, bounds, descriptor.fineTileSize, 2, fineMask);
    const windBytes = windTotal.chunkBytes, fineBytes = fineTotal.chunkBytes;
    const wind = new Map<number, PackedWindChunk>(), fineData = new Map<number, DataView>();
    let capacityResource: 'numeric' | 'preparation' | null = null;
    const horizonCost = (tasks: Array<{ kind: string; tile: number; bytes: number }>) => {
      const result = this.cache.horizonCost(root, tasks, this.options.horizon ?? 1);
      if (!result.fits) capacityResource = result.resource;
      return result.fits ? result.remaining : Infinity;
    };

    const validExtent = (extent: GeographicBounds | undefined): extent is GeographicBounds => !!extent
      && extent.every(Number.isFinite) && extent[1] >= -90 && extent[3] <= 90 && extent[1] <= extent[3]
      && extent[0] >= -180 && extent[0] <= 180 && extent[2] >= -180 && extent[2] <= 180;
    const extents = () => {
      const list: GeographicBounds[] = [];
      const add = (extent: GeographicBounds | undefined) => {
        if (!validExtent(extent) || list.some(item => item.every((value, index) => value === extent[index]))) return;
        list.push(extent);
      };
      add(bounds);
      if (validExtent(core) && bounds[0] <= bounds[2] && core[0] <= core[2]) {
        const reduced: GeographicBounds = [(bounds[0] + core[0]) / 2, (bounds[1] + core[1]) / 2, (bounds[2] + core[2]) / 2, (bounds[3] + core[3]) / 2];
        if (core[0] >= reduced[0] && core[1] >= reduced[1] && core[2] <= reduced[2] && core[3] <= reduced[3]) add(reduced);
      }
      add(core);
      return list;
    };
    const selectOverview = () => {
      let selected: { overview: Overview; tasks: Array<{ kind: string; tile: number; bytes: number }>; bounds: GeographicBounds } | undefined;
      let partial: typeof selected;
      const levels = [...(descriptor.overview ?? [])].filter(level => finerThan === undefined || level.stride < finerThan).sort((a, b) => a.stride - b.stride);
      for (const level of levels) {
        const layout = windOverviewLayout(native.grid, level.stride);
        let horizonChoice: typeof selected, partialChoice: typeof selected;
        for (const extent of extents()) {
          const tiles = tilesForBounds(native.grid, extent, WIND_OVERVIEW_TILE_SIZE * level.stride, level.stride * 2);
          if (!tiles || tiles.length * layout.chunkBytes > DETAIL_MAX_BYTES) continue;
          const tasks = tiles.map(tile => ({ kind: `overview-${level.stride}`, tile, bytes: layout.chunkBytes }));
          const candidate = {
            overview: { stride: level.stride, width: layout.width, height: layout.height, tilesAcross: Math.ceil(layout.width / WIND_OVERVIEW_TILE_SIZE), data: new Map<number, DataView>() },
            tasks, bounds: extent
          };
          const single = this.cache.horizonCost(root, tasks, 1);
          const incoming = tasks.reduce((sum, task) => sum + task.bytes, 0);
          const response = Math.min(incoming, Math.max(0, single.remaining));
          const full = this.cache.horizonCost(root, tasks, this.options.horizon ?? 1, response);
          const partialPlan = response === 0 ? single : this.cache.horizonCost(root, tasks, 1, response);
          if (full.fits) horizonChoice ??= candidate;
          else if (partialPlan.fits) partialChoice ??= candidate;
          else capacityResource = partialPlan.resource ?? full.resource ?? capacityResource;
        }
        if (horizonChoice) { selected = horizonChoice; break; }
        partial ??= partialChoice;
      }
      const chosen = selected ?? partial;
      if (chosen) box = chosen.bounds;
      return chosen;
    };

    const fetchTasks = async (rawTasks: Array<{ kind: string; tile: number; bytes: number }>, targetOverview?: Overview) => {
      const admission = this.cache.horizonCost(root, rawTasks, 1);
      if (admission.resource) throw new WindCapacityError(undefined, admission.resource);
      const coalesce = (this.options.coalesceSpans ?? !this.options.fetchImpl) && !this.cache.spansUnsupported;
      const tasks: Array<{ kind: string; tile: number; bytes: number; entry: CachedBytes }> = [];
      try {
        for (const item of rawTasks) tasks.push({ ...item, entry: this.hold(this.cache.take(`${root}/${item.kind}/${item.tile}`, item.bytes, build.expiresAtMs, this.foreground, true)) });
      } catch (error) {
        for (const { entry } of tasks) this.releaseEntry(entry);
        throw error;
      }
      const batches: Array<typeof tasks> = [];
      for (const item of coalesce ? [...tasks].sort((a, b) => a.kind.localeCompare(b.kind) || a.tile - b.tile) : tasks) {
        if (item.entry.used !== null || item.entry.pending) continue;
        const batch = batches.at(-1), first = batch?.[0], last = batch?.at(-1);
        if (coalesce && first && last && first.kind === item.kind && last.tile + 1 === item.tile
          && Math.floor(item.tile / SPAN_STRIPE) === Math.floor(first.tile / SPAN_STRIPE)
          && Math.floor(item.tile / WIND_INDEX_ENTRIES) === Math.floor(first.tile / WIND_INDEX_ENTRIES)
          && (batch!.length + 1) * item.bytes <= MAX_SPAN_BYTES) batch!.push(item);
        else batches.push([item]);
      }
      const commit = (kind: string, tile: number, entry: CachedBytes) => {
        entry.decoded ??= validateChunk(kind, entry.bytes, descriptor.tileSize, descriptor.levels, !!targetOverview);
        entry.used = entry.bytes.length;
        if (kind === 'wind') wind.set(tile, entry.decoded as PackedWindChunk);
        else (targetOverview ? targetOverview.data : fineData).set(tile, entry.decoded as DataView);
      };
      const check = (used: number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single', expected: number) => {
        if (typeof used !== 'number') throw new Error('Numeric chunk missing');
        if (used !== expected) throw new Error('Numeric chunk length mismatch');
      };
      const lanes: Promise<unknown>[] = Array.from({ length: 4 }, () => Promise.resolve());
      let failure: unknown;
      for (const [index, batch] of batches.entries()) {
        const first = batch[0]!, entries = batch.map(item => item.entry), lane = index % lanes.length;
        const previous = lanes[lane]!;
        const pending = this.cache.start(entries, async owner => {
          try {
            await new Promise<void>((resolve, reject) => {
              const abort = () => { owner.controller.signal.removeEventListener('abort', abort); reject(owner.controller.signal.reason); };
              owner.controller.signal.addEventListener('abort', abort, { once: true });
              if (owner.controller.signal.aborted) abort();
              previous.then(() => { owner.controller.signal.removeEventListener('abort', abort); resolve(); }, error => { owner.controller.signal.removeEventListener('abort', abort); reject(error); });
            });
          } catch (error) { owner.controller.signal.throwIfAborted(); failure ??= error; }
          owner.controller.signal.throwIfAborted();
          if (failure !== undefined && entries.every(entry => entry.references <= (this.held.has(entry) ? 1 : 0))) throw failure;
          try {
          let used: number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single' = 'retry-single';
          if (batch.length > 1 && !this.cache.spansUnsupported) {
            used = await readStream(`${root}/${first.kind}/${first.tile}-${batch.at(-1)!.tile}`, 'application/octet-stream', entries, owner);
            if (used === 'unsupported-span') this.cache.recordSpanResult(false);
            else if (used !== 'retry-single') this.cache.recordSpanResult(true);
          }
          if (used === 'unsupported-span' || used === 'retry-single') {
            for (const item of batch) check(await readStream(`${root}/${item.kind}/${item.tile}`, 'application/octet-stream', [item.entry], owner), item.bytes);
          } else check(used, entries.length * first.bytes);
          for (const item of batch) {
            item.entry.decoded = validateChunk(item.kind, item.entry.bytes, descriptor.tileSize, descriptor.levels, !!targetOverview);
          }
          for (const item of batch) item.entry.used = item.bytes;
          return entries.length * first.bytes;
          } catch (error) { failure ??= error; throw error; }
        });
        lanes[lane] = pending.promise;
      }
      const pending = new Set(tasks.flatMap(item => item.entry.pending ? [item.entry.pending] : []));
      try { await Promise.all([...pending].map(wait)); }
      catch (error) {
        for (const { entry } of tasks) this.releaseEntry(entry);
        const drained = new Set<PendingBytes>();
        for (;;) {
          const aborted = [...pending].filter(item => item.controller.signal.aborted && !drained.has(item));
          if (!aborted.length) break;
          for (const item of aborted) drained.add(item);
          await Promise.all(aborted.map(item => item.promise.catch(() => {})));
        }
        throw error;
      }
      baseSignal.throwIfAborted();
      for (const item of tasks) commit(item.kind, item.tile, item.entry);
    };

    let overview: Overview | undefined;
    const detailBudget = descriptor.overview?.length ? DETAIL_MAX_BYTES : SINGLE_VIEW_MAX_BYTES;
    const admits = (windTiles: number[] | null, fineTiles: number[] | null) => !!windTiles && !!fineTiles
      && windTiles.length + fineTiles.length <= MAX_CHUNKS && windBytes <= WIND_CHUNK_LIMIT
      && windTiles.length * windBytes + fineTiles.length * fineBytes <= detailBudget
      && (!this.options.overviewForHorizon || Number.isFinite(horizonCost([...windTiles.map(tile => ({ kind: 'wind', tile, bytes: windBytes })), ...fineTiles.map(tile => ({ kind: 'fine', tile, bytes: fineBytes }))])));
    if (!admits(winds, fines) && core?.every(Number.isFinite) && core[1] >= -90 && core[3] <= 90 && core[1] <= core[3] && core[0] >= -180 && core[0] <= 180 && core[2] >= -180 && core[2] <= 180) {
      const coreWinds = tilesForBounds(native.grid, core, descriptor.tileSize, 2, windMask);
      const coreFines = tilesForBounds(fine.grid, core, descriptor.fineTileSize, 2, fineMask);
      if (admits(coreWinds, coreFines)) { box = core; winds = coreWinds; fines = coreFines; }
    }
    if (winds && fines && admits(winds, fines)) {
      const detailTasks = [...winds.map(tile => ({ kind: 'wind', tile, bytes: windBytes })), ...fines.map(tile => ({ kind: 'fine', tile, bytes: fineBytes }))];
      this.horizonResources = { root, tasks: detailTasks };
      try {
        await fetchTasks(detailTasks);
      } catch (error) {
        for (const entry of [...this.held]) if (entry !== descEntry) this.releaseEntry(entry);
        wind.clear(); fineData.clear();
        const fallback = !baseSignal.aborted && ((this.options.overviewForHorizon && error instanceof WindCapacityError) || (error instanceof Error && error.message === 'Numeric chunk missing')) ? selectOverview() : undefined;
        if (!fallback) { controller.abort(); throw error; }
        this.horizonResources = { root, tasks: fallback.tasks };
        overview = fallback.overview;
        try { await fetchTasks(fallback.tasks, overview); } catch (fallbackError) { controller.abort(); throw fallbackError; }
      }
    } else {
      const selected = selectOverview();
      if (!selected) { if (capacityResource) throw new WindCapacityError(undefined, capacityResource); return 'unavailable'; }
      this.horizonResources = { root, tasks: selected.tasks };
      overview = selected.overview;
      try { await fetchTasks(selected.tasks, overview); } catch (error) { controller.abort(); throw error; }
    }

    baseSignal.throwIfAborted();
    if (this.controller !== controller || build.expiresAtMs <= Date.now()) return 'unavailable';
    this.generation++;
    this.admitted = box;
    this.current = { build, bounds: box, tileSize: descriptor.tileSize, fineTileSize: descriptor.fineTileSize, native: native.grid, fineGrid: fine.grid, nativeGeometry: prepareGridGeometry(native.grid), fineGeometry: prepareGridGeometry(fine.grid), wind, fine: fineData, windMask, fineMask, overview };
    return 'ready';
  }

  sample(lat: number, lon: number, height: 'surface' | number | 'lift'): WindSample {
    const current = this.current;
    if (!current || current.build.expiresAtMs <= Date.now()) { this.current = undefined; return empty('unavailable'); }
    if (!withinGeographicBounds(lat, lon, current.bounds) || !withinGeographicBounds(lat, lon, current.build.manifest.descriptors.bounds)) return empty('outside');
    if (current.overview) return this.sampleOverview(current, lat, lon, height);
    const windPlan = samplingPlan(current.native, current.nativeGeometry, lat, lon, 0), finePlan = samplingPlan(current.fineGrid, current.fineGeometry, lat, lon, 1);
    if (!windPlan || !finePlan) return empty('outside');
    let nearest = 0, nearestOutput = 0;
    for (let i = 0; i < finePlan.contributors.length; i++) {
      const item = finePlan.contributors[i], best = finePlan.contributors[nearest], size = current.fineTileSize;
      const logical = Math.floor(item.row / size) * Math.ceil(current.fineGrid.width / size) + Math.floor(item.column / size);
      const slot = current.fineMask ? current.fineMask.slot(logical) : logical;
      let packed = STATUS_OUTSIDE | (STATUS_OUTSIDE << 2), support = 0, val = 0;
      if (slot >= 0) {
        const view = current.fine.get(slot);
        if (!view) return empty('unavailable');
        const pos = ((item.row % size) * size + item.column % size) * WIND_FINE_CELL_BYTES;
        packed = view.getUint8(pos + 8); support = view.getUint8(pos + 9);
        val = view.getFloat32(pos + (height === 'lift' ? 4 : 0), true);
      }
      values[i] = val;
      flags[i] = height === 'lift' ? ((packed >> 2) & STATUS_MASK) | support : packed & STATUS_MASK;
      if (i === 0 || nearerContributor(item.weight, item.row, item.column, best.weight, best.row, best.column)) { nearest = i; nearestOutput = (packed >> 4) & 1; }
    }
    if (!nearestOutput) return empty('outside');
    let target: number | 'surface' = 'surface';
    if (height !== 'surface') {
      const selected = targetHeight(finePlan, height);
      if (selected.status !== STATUS_VALID || selected.value === null) return empty(selected.status === STATUS_NO_LIFT ? 'no-lift' : selected.status === STATUS_OUTSIDE ? 'outside' : 'unavailable');
      target = selected.value;
    }
    chunks.length = windPlan.contributors.length;
    for (let i = 0; i < windPlan.contributors.length; i++) {
      const item = windPlan.contributors[i], size = current.tileSize;
      const logical = Math.floor(item.row / size) * Math.ceil(current.native.width / size) + Math.floor(item.column / size);
      const slot = current.windMask ? current.windMask.slot(logical) : logical;
      if (slot < 0) { chunks[i] = OUTSIDE_WIND; offsets[i] = 0; continue; }
      chunks[i] = current.wind.get(slot);
      offsets[i] = (item.row % size) * size + item.column % size;
      if (!chunks[i]) { chunks.length = 0; return empty('unavailable'); }
    }
    offsets.length = chunks.length;
    const result = samplePackedWindColumns(windPlan, chunks, offsets, target);
    chunks.length = 0;
    return { u: result.u, v: result.v, status: result.status === STATUS_VALID ? 'valid' : result.status === STATUS_OUTSIDE ? 'outside' : 'unavailable' };
  }

  private sampleOverview(current: NonNullable<WindDataSource['current']>, lat: number, lon: number, height: 'surface' | number | 'lift'): WindSample {
    const { stride, data, width, height: rows, tilesAcross } = current.overview!, point = current.nativeGeometry.geographicToGrid(lat, lon);
    if (!point || point.x < 0 || point.y < 0 || (!current.native.wrapLongitude && point.x > current.native.width - 1) || point.y > current.native.height - 1) return empty('outside');
    const mode = height === 'surface' ? 0 : height === 'lift' ? WIND_OVERVIEW_VALUES - 1 : WIND_HEIGHTS.indexOf(height as typeof WIND_HEIGHTS[number]) + 1;
    if (typeof height === 'number' && !mode) return empty('unavailable');
    const size = WIND_OVERVIEW_TILE_SIZE, ox = current.native.wrapLongitude ? Math.floor((point.x + 0.5) / stride) % width : Math.min(width - 1, Math.floor((point.x + 0.5) / stride)), oy = Math.min(rows - 1, Math.floor((point.y + 0.5) / stride));
    const owner = data.get(Math.floor(oy / size) * tilesAcross + Math.floor(ox / size));
    if (!owner) return empty('unavailable');
    const offset = ((oy % size) * size + ox % size) * WIND_OVERVIEW_CELL_BYTES + mode * 9, status = owner.getUint8(offset + 8);
    if (status !== STATUS_VALID) return empty(status === STATUS_NO_LIFT ? 'no-lift' : status === STATUS_OUTSIDE ? 'outside' : 'unavailable');
    const x = overviewCoordinate(point.x, current.native.width, stride, current.native.wrapLongitude), y = overviewCoordinate(point.y, current.native.height, stride), x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    let u = 0, v = 0;
    for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (!weight) continue;
      const column = current.native.wrapLongitude ? ((x0 + dx) % width + width) % width : Math.max(0, Math.min(width - 1, x0 + dx)), row = Math.max(0, Math.min(rows - 1, y0 + dy));
      const donor = data.get(Math.floor(row / size) * tilesAcross + Math.floor(column / size));
      const pos = ((row % size) * size + column % size) * WIND_OVERVIEW_CELL_BYTES + mode * 9;
      if (!donor || donor.getUint8(pos + 8) !== STATUS_VALID) return { status: 'valid', u: owner.getFloat32(offset, true), v: owner.getFloat32(offset + 4, true) };
      u += donor.getFloat32(pos, true) * weight; v += donor.getFloat32(pos + 4, true) * weight;
    }
    return { status: 'valid', u, v };
  }

  dispose(): void {
    this.disposed = true; this.controller?.abort(); this.current = undefined; this.horizonResources = undefined; this.clearPrepared(); this.generation++;
    for (const entry of this.fields.values()) entry.dispose();
    this.fields.clear();
    if (!this.active) this.release();
  }
}
