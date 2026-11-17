import { normalizeLon, prepareGridGeometry, snapGridCoordinate, withinGeographicBounds, type GeographicBounds, type Grid, type GridGeometry } from '@av/contracts/geometry';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from '@av/contracts/layers';
import { WIND_CHUNK_LIMIT, WIND_FINE_CELL_BYTES, WIND_FRAME_LIMIT, WIND_HEIGHTS, WIND_INDEX_ENTRIES, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_TILE_SIZE, WIND_OVERVIEW_VALUES, assertWindFrameLayout, decodeTileMask, encodeWindByte, parseWindFrame, windLayout, windOverviewLayout, type TileMask } from '@av/contracts/wind-data';
import { nearerContributor, type SamplePlan } from '@av/forecast/sampler';
import { decodePackedWindChunk, encodeWindColumns, samplePackedWindColumns, type PackedWindChunk } from '@av/forecast/wind';
import type { PinnedBuild } from './client-types.ts';
import type { PreparationBudget, PreparationLease } from './client-preparation-budget.ts';
import type { ForecastRequestHandle, ForecastRequestSpec, RequestPriority } from './client-request-scheduler.ts';

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
export interface WindSample { status: WindStatus; u: number | null; v: number | null }
interface Overview { stride: number; width: number; height: number; tilesAcross: number; data: Map<number, DataView> }
const empty = (status: WindStatus): WindSample => ({ status, u: null, v: null });
export const WIND_NUMERIC_BYTES = 8 * 1024 * 1024;
export const WIND_WINDOW_BYTES = 128 * 1024 * 1024;
export const WIND_WINDOW_ENTRIES = 4096;
const MAX_CHUNKS = 64, DETAIL_MAX_BYTES = WIND_NUMERIC_BYTES / 2 - WIND_FRAME_LIMIT, SINGLE_VIEW_MAX_BYTES = WIND_NUMERIC_BYTES - WIND_FRAME_LIMIT;
const MAX_SPAN_BYTES = 1024 * 1024, SPAN_STRIPE = 8, UNAVAILABLE_BUILD_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000, FIELD_SLOTS = 8192;
const DEMOTED_REQUEST = Symbol('demoted wind request');
const DEFAULT_PREPARED_GRID_SIZE = 128;
export const WIND_FIELD_SAMPLER_BYTES = FIELD_SLOTS * 17;
export const WIND_PREPARED_GRID_BYTES = DEFAULT_PREPARED_GRID_SIZE * DEFAULT_PREPARED_GRID_SIZE * 4;
const OUTSIDE_WIND = decodePackedWindChunk(encodeWindColumns([null], 1));
const plans: SamplePlan[] = Array.from({ length: 2 }, () => ({ contributors: Array.from({ length: 4 }, () => ({ index: 0, row: 0, column: 0, weight: 0 })), byteRange: { offset: 0, length: 0 } }));
const planContributors = plans.map(plan => [...plan.contributors]);
const chunks: (PackedWindChunk | undefined)[] = [], offsets: number[] = [], values = new Float64Array(4), flags = new Uint8Array(4);

/** Typed capacity outcome, separate from validation RangeErrors. */
export class WindCapacityError extends Error {
  readonly code = 'capacity';
  constructor(message = 'Wind cache exceeds byte budget') { super(message); this.name = 'WindCapacityError'; }
}

interface CachedBytes {
  url: string;
  bytes: Uint8Array;
  capacity: number;
  used: number | null;
  references: number;
  owners: Set<WindDataSource>;
  expiresAt: number;
  decoded?: PackedWindChunk | DataView;
  lease?: PreparationLease;
  pending?: PendingBytes;
}

interface PendingBytes {
  controller: AbortController;
  promise: Promise<number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single'>;
  handles: Set<ForecastRequestHandle>;
  revoke: Map<ForecastRequestHandle, () => void>;
  wake: Set<() => void>;
  entries: CachedBytes[];
  responseLease?: PreparationLease;
}

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
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Share immutable buffers and decoded views across viewports within a strict byte limit. */
export class WindDataCache {
  private readonly entries = new Set<CachedBytes>();
  private readonly unavailableBuilds = new Map<string, number>();
  private bytes = 0;
  private spanFailures = 0;
  private readonly failures = new Map<string, { until: number; attempts: number }>();
  private readonly availability = new Set<() => void>();
  /** Called when a retain count reaches zero; capacity owners may re-plan. */
  onRelease: (() => void) | null = null;

  constructor(private readonly budgetBytes = WIND_NUMERIC_BYTES, private readonly entryLimit = WIND_WINDOW_ENTRIES, private budget?: PreparationBudget) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < WIND_FRAME_LIMIT || budgetBytes > WIND_WINDOW_BYTES
      || !Number.isSafeInteger(entryLimit) || entryLimit < 1 || entryLimit > WIND_WINDOW_ENTRIES) throw new RangeError('Invalid wind cache budget');
  }

  bindBudget(budget: PreparationBudget): void {
    if (this.budget === budget) return;
    if (this.budget || this.entries.size) throw new Error('Wind cache budget must be bound before use');
    this.budget = budget;
  }

  get allocatedBytes(): number {
    return this.bytes;
  }

  get capacityBytes(): number { return this.budgetBytes; }
  get preparationBudget(): PreparationBudget | undefined { return this.budget; }

  onAvailable(listener: () => void): () => void {
    this.availability.add(listener);
    return () => { this.availability.delete(listener); };
  }

  private available(): void { for (const listener of [...this.availability]) listener(); }

  reserveResponse(bytes: number, foreground = true): PreparationLease | undefined {
    if (!this.budget) return undefined;
    let lease = this.budget.reserve('response', bytes, foreground ? 'foreground' : 'background');
    if (!lease) for (const entry of this.entries) {
      if (!entry.references && !entry.pending) {
        this.remove(entry);
        lease = this.budget.reserve('response', bytes, foreground ? 'foreground' : 'background');
        if (lease) break;
      }
    }
    if (!lease) throw new WindCapacityError();
    return lease;
  }

  horizonCost(root: string, resources: readonly { kind: string; tile: number; bytes: number }[], horizon: number): { remaining: number; fits: boolean } {
    const split = root.lastIndexOf('/'), prefix = root.slice(0, split + 1), frame = root.slice(split + 1);
    const expected = new Map<string, number>([['', WIND_FRAME_LIMIT]]);
    for (const resource of resources) expected.set(`/${resource.kind}/${resource.tile}`, resource.bytes);
    const frames = new Map<string, CachedBytes[]>();
    for (const entry of this.entries) {
      if (!entry.url.startsWith(prefix) || entry.expiresAt <= Date.now() || entry.pending?.controller.signal.aborted) continue;
      const suffix = entry.url.slice(prefix.length), slash = suffix.indexOf('/');
      const id = slash < 0 ? suffix : suffix.slice(0, slash), path = slash < 0 ? '' : suffix.slice(slash);
      if (expected.get(path) !== entry.capacity) continue;
      const group = frames.get(id) ?? [];
      if (!group.some(item => item.url === entry.url)) { group.push(entry); frames.set(id, group); }
    }
    const kept = new Set<CachedBytes>();
    const groups = [...frames.entries()].sort(([a], [b]) => Number(b === frame) - Number(a === frame));
    for (const [, entries] of groups.slice(0, horizon)) for (const entry of entries) kept.add(entry);
    let backed = 0, reclaimable = 0;
    for (const entry of this.entries) {
      if (kept.has(entry)) backed += entry.bytes.length;
      else if (!entry.references && !entry.pending) reclaimable += entry.bytes.length;
    }
    const required = horizon * [...expected.values()].reduce((sum, bytes) => sum + bytes, 0) - backed;
    const numericAvailable = this.budgetBytes - this.bytes + reclaimable;
    const sharedAvailable = this.budget ? this.budget.limit - this.budget.used + reclaimable : Infinity;
    return { remaining: required, fits: required <= Math.min(numericAvailable, sharedAvailable) };
  }

  get spansUnsupported(): boolean {
    return this.spanFailures >= 2;
  }

  set spansUnsupported(value: boolean) {
    this.spanFailures = value ? 2 : 0;
  }

  recordSpanResult(supported: boolean): void {
    this.spanFailures = supported ? 0 : Math.min(2, this.spanFailures + 1);
  }

  isBuildUnavailable(buildId: string, now = Date.now()): boolean {
    const until = this.unavailableBuilds.get(buildId);
    if (until === undefined) return false;
    if (until <= now) { this.unavailableBuilds.delete(buildId); return false; }
    return true;
  }

  markBuildUnavailable(buildId: string, now = Date.now()): void {
    if (!this.unavailableBuilds.has(buildId) && this.unavailableBuilds.size >= 64) {
      const oldest = this.unavailableBuilds.keys().next().value;
      if (oldest !== undefined) this.unavailableBuilds.delete(oldest);
    }
    this.unavailableBuilds.delete(buildId);
    this.unavailableBuilds.set(buildId, now + UNAVAILABLE_BUILD_TTL_MS);
  }

  failureRemaining(url: string, now = Date.now()): number {
    const entry = this.failures.get(url);
    if (!entry) return 0;
    if (entry.until <= now) { this.failures.delete(url); return 0; }
    return entry.until - now;
  }

  recordFailure(url: string, now = Date.now()): void {
    this.failures.set(url, { until: now + 30_000, attempts: Math.min(3, (this.failures.get(url)?.attempts ?? 0) + 1) });
  }

  clearFailure(url: string): void { this.failures.delete(url); }

  get failedResources(): number { return this.failures.size; }

  hasReady(url: string, limit: number, now = Date.now()): boolean {
    for (const e of this.entries) if (e.url === url && e.used !== null && e.expiresAt > now && e.capacity === limit) return true;
    return false;
  }

  take(url: string, limit: number, expiresAt: number, foreground = true, lazy = false): CachedBytes {
    for (const e of this.entries) {
      if (e.url !== url || e.expiresAt <= Date.now() || e.capacity !== limit) continue;
      if (e.pending?.controller.signal.aborted) throw new WindCapacityError();
      e.references++; e.expiresAt = Math.min(e.expiresAt, expiresAt);
      this.entries.delete(e); this.entries.add(e);
      return e;
    }
    for (const e of this.entries) {
      if ((lazy || this.bytes + limit <= this.budgetBytes) && this.entries.size < this.entryLimit) break;
      if (!e.references && !e.pending) this.remove(e);
    }
    if ((!lazy && this.bytes + limit > this.budgetBytes) || this.entries.size >= this.entryLimit) throw new WindCapacityError();
    const entry: CachedBytes = { url, bytes: new Uint8Array(0), capacity: limit, used: null, references: 1, owners: new Set(), expiresAt };
    this.entries.add(entry);
    try { if (!lazy) this.allocate(entry, foreground); } catch (error) { this.entries.delete(entry); throw error; }
    return entry;
  }

  allocate(entry: CachedBytes, foreground: boolean): void {
    if (entry.bytes.length === entry.capacity) return;
    const limit = entry.capacity;
    for (const e of this.entries) {
      if (this.bytes + limit <= this.budgetBytes) break;
      if (!e.references && !e.pending) this.remove(e);
    }
    if (this.bytes + limit > this.budgetBytes) throw new WindCapacityError();
    let lease = this.budget?.reserve('wind-numeric', limit, foreground ? 'foreground' : 'background');
    if (this.budget && !lease) for (const entry of this.entries) {
      if (!entry.references && !entry.pending) {
        this.remove(entry);
        lease = this.budget.reserve('wind-numeric', limit, foreground ? 'foreground' : 'background');
        if (lease) break;
      }
    }
    if (this.budget && !lease) throw new WindCapacityError();
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(limit); } catch (error) { lease?.release(); throw error; }
    entry.bytes = bytes; entry.lease = lease ?? undefined; this.bytes += limit;
  }

  unallocate(entry: CachedBytes): void {
    this.bytes -= entry.bytes.length; entry.bytes = new Uint8Array(0);
    entry.lease?.release(); entry.lease = undefined;
  }

  release(entry: CachedBytes): void {
    if (--entry.references) return;
    if (entry.pending) {
      if (entry.pending.entries.every(item => !item.references)) entry.pending.controller.abort();
    } else if (entry.used === null || entry.expiresAt <= Date.now()) this.remove(entry);
    else this.onRelease?.();
    this.available();
  }

  /** Drop validated entries no owner references and return the freed bytes. */
  evictUnreferenced(): number {
    let freed = 0;
    for (const entry of [...this.entries]) if (!entry.references && !entry.pending) { freed += entry.bytes.length; this.remove(entry); }
    return freed;
  }

  clear(): void {
    this.unavailableBuilds.clear();
    this.failures.clear();
    this.spanFailures = 0;
    for (const e of this.entries) { e.expiresAt = 0; if (!e.references && !e.pending) this.remove(e); }
  }

  private remove(entry: CachedBytes): void {
    if (this.entries.delete(entry)) { this.bytes -= entry.bytes.length; entry.lease?.release(); }
  }

  start(entries: CachedBytes[], run: (pending: PendingBytes) => Promise<number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single'>, responseLease?: PreparationLease): PendingBytes {
    const pending: PendingBytes = { controller: new AbortController(), handles: new Set(), revoke: new Map(), wake: new Set(), entries, responseLease, promise: undefined! };
    for (const entry of entries) entry.pending = pending;
    pending.promise = Promise.resolve().then(() => run(pending)).finally(() => {
      pending.responseLease?.release(); pending.responseLease = undefined;
      for (const entry of entries) {
        entry.pending = undefined;
        if (!entry.references && (entry.used === null || entry.expiresAt <= Date.now())) { this.remove(entry); this.onRelease?.(); }
        else if (!entry.references) this.onRelease?.();
      }
      this.available();
    });
    return pending;
  }
}

function samplingPlan(grid: Grid, geometry: GridGeometry, lat: number, lon: number, slot: number): SamplePlan | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width <= 0 || grid.height <= 0) return null;
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    if (!Number.isFinite(grid.lon0) || !Number.isFinite(grid.lat0) || !Number.isFinite(grid.dx) || !Number.isFinite(grid.dy) || !grid.dx || !grid.dy || lat < -90 || lat > 90) return null;
    x = snapGridCoordinate((lon - grid.lon0) / grid.dx); y = snapGridCoordinate((lat - grid.lat0) / grid.dy);
    if (grid.wrapLongitude) x = snapGridCoordinate(((x % grid.width) + grid.width) % grid.width);
  } else {
    const point = geometry.geographicToGrid(lat, lon);
    if (!point) return null;
    x = point.x; y = point.y;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!grid.wrapLongitude && (x < 0 || x > grid.width - 1)) || y < 0 || y > grid.height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, plan = plans[slot];
  let count = 0;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    if ((dx && fx === 0) || (dy && fy === 0)) continue;
    const item = planContributors[slot][count++];
    item.row = y0 + dy; item.column = (x0 + dx) % grid.width; item.index = item.row * grid.width + item.column;
    item.weight = (dy ? fy : 1 - fy) * (dx ? fx : 1 - fx);
    plan.contributors[count - 1] = item;
  }
  plan.contributors.length = count;
  return plan;
}

function targetHeight(plan: SamplePlan, height: number | 'lift', useStoredMslNoLift: boolean): { value: number | null; status: number } {
  if (height !== 'lift' && (!Number.isFinite(height) || height < 0)) throw new RangeError('Invalid AGL height');
  let missing = false, allNoLift = true, noLiftWeight = 0, nearest = 0;
  for (let i = 0; i < plan.contributors.length; i++) {
    const status = flags[i] & STATUS_MASK, item = planContributors[1][i], best = plan.contributors[nearest];
    if (height !== 'lift' && (status === STATUS_NO_LIFT || (flags[i] & SUPPORT_MASK) !== 0)) throw new RangeError('Terrain cell has lift status or support');
    missing ||= status >= STATUS_UNAVAILABLE; allNoLift &&= status === STATUS_NO_LIFT;
    if (status === STATUS_NO_LIFT) noLiftWeight += item.weight;
    if (nearerContributor(item.weight, item.row, item.column, best.weight, best.row, best.column)) nearest = i;
  }
  if (missing || plan.contributors.length === 1) {
    const idx = missing ? nearest : 0, status = flags[idx] & STATUS_MASK;
    return { value: status === STATUS_VALID ? height === 'lift' ? values[idx] : values[idx] + height : null, status };
  }
  if (height === 'lift' && (allNoLift || noLiftWeight > 0.5)) return { value: null, status: STATUS_NO_LIFT };
  const renormalize = height === 'lift' && !useStoredMslNoLift && plan.contributors.length === 4 && noLiftWeight > 0;
  let value = 0;
  for (let i = 0; i < plan.contributors.length; i++) {
    value += renormalize ? (flags[i] & STATUS_MASK) === STATUS_NO_LIFT ? 0 : values[i] * (plan.contributors[i].weight / (1 - noLiftWeight)) : values[i] * plan.contributors[i].weight;
  }
  return { value: height === 'lift' ? value : value + height, status: STATUS_VALID };
}

function tilesForBounds(grid: Grid, bounds: GeographicBounds, size: number, padding = 2, mask?: TileMask): number[] | null {
  const geometry = prepareGridGeometry(grid), [west, south, east, north] = bounds;
  const span = west <= east ? east - west : east + 360 - west;
  if (span > 180) {
    const count = mask ? mask.count : Math.ceil(grid.width / size) * Math.ceil(grid.height / size);
    return count <= MAX_CHUNKS ? Array.from({ length: count }, (_, i) => i) : null;
  }
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y <= 32; y++) for (let x = 0; x <= 32; x++) {
    const point = geometry.geographicToGrid(south + (north - south) * y / 32, normalizeLon(west + span * x / 32));
    if (point) points.push(point);
  }
  for (const x of [0, (grid.width - 1) / 2, grid.width - 1]) for (const y of [0, (grid.height - 1) / 2, grid.height - 1]) {
    const point = geometry.gridToGeographic(x, y);
    if (point && withinGeographicBounds(point.lat, point.lon, bounds)) points.push({ x, y });
  }
  if (!points.length) return [];
  const w = Math.ceil(grid.width / size), h = Math.ceil(grid.height / size);
  const xs = points.map(p => p.x), ys = points.map(p => p.y), minX = Math.min(...xs), maxX = Math.max(...xs);
  const y0 = Math.max(0, Math.floor((Math.min(...ys) - padding) / size)), y1 = Math.min(h - 1, Math.floor((Math.max(...ys) + padding) / size));
  const intervals = grid.wrapLongitude && maxX - minX > grid.width / 2
    ? [[0, Math.max(...xs.filter(x => x < grid.width / 2)) + padding], [Math.min(...xs.filter(x => x >= grid.width / 2)) - padding, grid.width - 1]]
    : [[minX - padding, maxX + padding]];
  if (grid.wrapLongitude) for (const [s, e] of [...intervals]) {
    if (s < 0) intervals.push([grid.width + s, grid.width - 1]);
    if (e >= grid.width) intervals.push([0, e - grid.width]);
  }
  const result = new Set<number>();
  for (const [s, e] of intervals) {
    const x0 = Math.max(0, Math.floor(s / size)), x1 = Math.min(w - 1, Math.floor(e / size));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const logical = y * w + x, slot = mask ? mask.slot(logical) : logical;
      if (slot >= 0 && result.add(slot).size > MAX_CHUNKS) return null;
    }
  }
  return [...result];
}

function overviewCoordinate(point: number, length: number, stride: number, wrap = false): number {
  const last = Math.ceil(length / stride) - 1, center = (stride - 1) / 2, tail = length - last * stride;
  if (!last) return 0;
  if (tail < stride) {
    if (point > (last - 1) * stride + center) return last - 1 + (point - (last - 1) * stride - center) / ((stride + tail) / 2);
    if (wrap && point < center) return (point - center) / ((stride + tail) / 2);
  }
  return (point - center) / stride;
}

function validateChunk(kind: string, bytes: Uint8Array, tileSize: number, levels: number, isOverview: boolean): PackedWindChunk | DataView {
  if (kind === 'wind') {
    const columns = decodePackedWindChunk(bytes);
    if (columns.count !== tileSize ** 2 || columns.levels !== levels) throw new Error('Numeric chunk dimensions mismatch');
    return columns;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isOverview) {
    for (let i = 0; i < bytes.length; i += 9) {
      const u = view.getFloat32(i, true), v = view.getFloat32(i + 4, true), status = view.getUint8(i + 8);
      if (status > STATUS_OUTSIDE || !Number.isFinite(u) || !Number.isFinite(v) || (status !== STATUS_VALID && (u !== 0 || v !== 0))) throw new Error('Invalid numeric overview');
    }
    return view;
  }
  for (let i = 0; i < bytes.length; i += WIND_FINE_CELL_BYTES) {
    const packed = view.getUint8(i + 8), support = view.getUint8(i + 9), terrain = packed & STATUS_MASK, lift = (packed >> 2) & STATUS_MASK;
    if ((packed & 0xe0) !== 0 || (support & ~SUPPORT_MASK) !== 0 || terrain === STATUS_NO_LIFT
      || (terrain === STATUS_VALID && !Number.isFinite(view.getFloat32(i, true)))
      || (lift <= STATUS_NO_LIFT && !Number.isFinite(view.getFloat32(i + 4, true)))) throw new Error('Invalid numeric companion');
  }
  return view;
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
    const current = this.current;
    if (!current || current.build.expiresAtMs <= Date.now()) return null;
    if (!Number.isSafeInteger(size) || size < 1 || size > 1024) throw new RangeError('Invalid wind preparation size');
    if (height !== 'surface' && height !== 'lift' && (!Number.isFinite(height) || height < 0)) throw new RangeError('Invalid AGL height');
    const key = `${this.generation}:${height}:${size}`;
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
    const span = east - west;
    try { for (let y = 0; y < size; y++) {
      const lat = south + (north - south) * (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const sample = this.sample(lat, normalizeLon(west + span * (x + 0.5) / size), height);
        if (sample.status !== 'valid' || sample.u === null || sample.v === null) continue;
        const offset = (y * size + x) * 4;
        data[offset] = encodeWindByte(sample.u); data[offset + 1] = encodeWindByte(sample.v); data[offset + 3] = 255;
      }
    } } catch (error) { release(); throw error; }
    const grid: WindPreparedGrid = { bounds: [west, south, east, north], data, size, height, key, retain: () => {
      if (!references) throw new Error('Wind prepared grid is released');
      references++;
      let retained = true;
      return () => { if (retained) { retained = false; release(); } };
    } };
    this.preparedGrids.set(key, { grid, release });
    return grid;
  }

  private clearPrepared(): void {
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

  async load({ build, frame, bounds, core, signal }: { build: PinnedBuild; frame: string; bounds: GeographicBounds; core?: GeographicBounds; signal?: AbortSignal }): Promise<'ready' | 'unavailable'> {
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
      try { return await this.loadView(build, frame, bounds, controller, signal, core); }
      finally { waiting.removeEventListener('abort', abort); }
    } finally {
      if (this.active === controller) {
        this.active = undefined;
        if (this.disposed || controller.signal.aborted || !this.current) { this.horizonResources = undefined; this.release(); }
      }
      release();
    }
  }

  private async loadView(build: PinnedBuild, frame: string, bounds: GeographicBounds, controller: AbortController, signal?: AbortSignal, core?: GeographicBounds): Promise<'ready' | 'unavailable'> {
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
      const delays = this.options.retryDelaysMs ?? [250, 1000];
      const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
      for (let attempt = 0; ; attempt++) try {
        return await readOnce(url, type, targets, pending);
      } catch (error) {
        if (error === DEMOTED_REQUEST) { attempt--; attemptSignal.throwIfAborted(); continue; }
        const transient = error instanceof WindTransientError || (error instanceof TypeError && !attemptSignal.aborted);
        if (!transient) { if (error instanceof WindTransientError) this.cache.recordFailure(url); throw error; }
        if (attempt >= delays.length || attemptSignal.aborted) { this.cache.recordFailure(url); throw error; }
        const jitter = 0.85 + (this.options.random?.() ?? Math.random()) * 0.3;
        await sleep(delays[attempt]! * jitter);
        attemptSignal.throwIfAborted();
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
            ...(type === 'application/json' ? {} : { expectedResponseBytes: limit }),
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
        const declared = res.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await res.body?.cancel(); throw new Error('Numeric response exceeds budget'); }
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
        if (declared !== null && used !== Number(declared)) throw new Error('Numeric response length mismatch');
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
    let capacityLimited = false;
    const horizonCost = (tasks: Array<{ kind: string; tile: number; bytes: number }>) => {
      const result = this.cache.horizonCost(root, tasks, this.options.horizon ?? 1);
      if (!result.fits) capacityLimited = true;
      return result.fits ? result.remaining : Infinity;
    };

    const selectOverview = () => {
      let selected: { overview: Overview; tasks: Array<{ kind: string; tile: number; bytes: number }> } | undefined;
      let cost = Infinity;
      for (const level of descriptor.overview ?? []) {
        const layout = windOverviewLayout(native.grid, level.stride), tiles = tilesForBounds(native.grid, box, WIND_OVERVIEW_TILE_SIZE * level.stride, level.stride * 2);
        if (!tiles || tiles.length * layout.chunkBytes > DETAIL_MAX_BYTES) continue;
        const tasks = tiles.map(tile => ({ kind: `overview-${level.stride}`, tile, bytes: layout.chunkBytes }));
        const total = horizonCost(tasks);
        if (total >= cost) continue;
        cost = total;
        selected = {
          overview: { stride: level.stride, width: layout.width, height: layout.height, tilesAcross: Math.ceil(layout.width / WIND_OVERVIEW_TILE_SIZE), data: new Map<number, DataView>() },
          tasks
        };
      }
      return selected;
    };

    const fetchTasks = async (rawTasks: Array<{ kind: string; tile: number; bytes: number }>, targetOverview?: Overview) => {
      if (!this.cache.horizonCost(root, rawTasks, 1).fits) throw new WindCapacityError();
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
      if (!selected) { if (capacityLimited) throw new WindCapacityError(); return 'unavailable'; }
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
      const selected = targetHeight(finePlan, height, current.build.manifest.tool.useStoredMslNoLift === true);
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
