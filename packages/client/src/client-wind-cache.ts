import { WIND_FRAME_LIMIT } from '@av/contracts/wind-data';
import type { PackedWindChunk } from '@av/forecast/wind';
import type { PreparationBudget, PreparationLease } from './client-preparation-budget.ts';
import type { ForecastRequestHandle } from './client-request-scheduler.ts';
import type { WindDataSource } from './client-wind.ts';

export const WIND_NUMERIC_BYTES = 8 * 1024 * 1024;
export const WIND_WINDOW_BYTES = 128 * 1024 * 1024;
export const WIND_WINDOW_ENTRIES = 4096;
const UNAVAILABLE_BUILD_TTL_MS = 30_000;

/** Typed capacity outcome, separate from validation RangeErrors. */
export class WindCapacityError extends Error {
  readonly code = 'capacity';
  constructor(message = 'Wind cache exceeds byte budget', readonly resource: 'numeric' | 'preparation' = 'preparation') { super(message); this.name = 'WindCapacityError'; }
}

export interface CachedBytes {
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

export interface PendingBytes {
  controller: AbortController;
  promise: Promise<number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single'>;
  handles: Set<ForecastRequestHandle>;
  revoke: Map<ForecastRequestHandle, () => void>;
  wake: Set<() => void>;
  entries: CachedBytes[];
  responseLease?: PreparationLease;
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

  horizonCost(root: string, resources: readonly { kind: string; tile: number; bytes: number }[], horizon: number, responseBytes = 0): { remaining: number; fits: boolean; resource: 'numeric' | 'preparation' | null } {
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
    const resource = required > numericAvailable ? 'numeric' : required + responseBytes > sharedAvailable ? 'preparation' : null;
    return { remaining: required, fits: resource === null, resource };
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
      if (e.pending?.controller.signal.aborted) throw new WindCapacityError(undefined, 'numeric');
      e.references++; e.expiresAt = Math.min(e.expiresAt, expiresAt);
      this.entries.delete(e); this.entries.add(e);
      return e;
    }
    for (const e of this.entries) {
      if ((lazy || this.bytes + limit <= this.budgetBytes) && this.entries.size < this.entryLimit) break;
      if (!e.references && !e.pending) this.remove(e);
    }
    if ((!lazy && this.bytes + limit > this.budgetBytes) || this.entries.size >= this.entryLimit) throw new WindCapacityError(undefined, 'numeric');
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
    if (this.bytes + limit > this.budgetBytes) throw new WindCapacityError(undefined, 'numeric');
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
