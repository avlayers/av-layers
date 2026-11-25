import pRetry from 'p-retry';
import { WIND_INDEX_ENTRIES } from '@av/contracts/wind-data';
import type { PackedWindChunk } from '@av/forecast/wind';
import type { PreparationBudget, PreparationLease } from './client-preparation-budget.ts';
import type { ForecastRequestHandle, ForecastRequestSpec, RequestPriority } from './client-request-scheduler.ts';
import { WindCapacityError, type CachedBytes, type PendingBytes, type WindDataCache, type WindOwner, type WindReadResult } from './client-wind-cache.ts';

export interface WindChunkTask { kind: string; tile: number; bytes: number }
export interface WindTransportOptions {
  fetchImpl?: typeof fetch;
  request?: (spec: ForecastRequestSpec & { init?: RequestInit }) => ForecastRequestHandle;
  coalesceSpans?: boolean;
  /** Transient failures retry with p-retry backoff: `retryMinTimeoutMs`, then ×4, jittered ×1–2. */
  retries?: number;
  retryMinTimeoutMs?: number;
}

const MAX_SPAN_BYTES = 1024 * 1024, SPAN_STRIPE = 8, LANES = 4;
const REQUEST_TIMEOUT_MS = 15_000;
/** Cancel reason for a queued request moved behind newer work; it re-runs without spending a retry. */
const DEMOTED_REQUEST = new Error('Demoted wind request');

class WindTransientError extends Error {
  constructor(message: string) { super(message); this.name = 'WindTransientError'; }
}

const pendingForeground = (pending: PendingBytes): boolean => pending.entries.some(entry => [...entry.owners].some(owner => owner.foreground));

/**
 * One wind source's claim on shared cache entries and the requests that fill them: priority,
 * held entries, span coalescing into four lanes, streamed reads into cache bytes, retries and demotion.
 */
export class WindTransport implements WindOwner {
  foreground: boolean;
  readonly held = new Set<CachedBytes>();
  constructor(private readonly cache: WindDataCache, private readonly budget: PreparationBudget | undefined, private readonly options: WindTransportOptions, priority?: RequestPriority) {
    this.foreground = priority !== 'background';
  }

  setPriority(priority: RequestPriority): void {
    this.foreground = priority === 'foreground';
    for (const entry of this.held) if (entry.pending) {
      if (this.foreground) for (const handle of entry.pending.handles) handle.promote();
      else if (!pendingForeground(entry.pending)) for (const handle of entry.pending.handles) if (handle.started === false) { handle.cancel(DEMOTED_REQUEST); entry.pending.revoke.get(handle)?.(); }
      for (const wake of entry.pending.wake) wake();
    }
  }

  hold(entry: CachedBytes): CachedBytes {
    if (this.held.has(entry)) this.cache.release(entry);
    else { this.held.add(entry); entry.owners.add(this); }
    return entry;
  }

  release(entry: CachedBytes): void {
    if (!this.held.delete(entry)) return;
    entry.owners.delete(this);
    this.cache.release(entry);
  }

  releaseAll(): void {
    for (const entry of [...this.held]) this.release(entry);
  }

  /** Await a shared fill; an aborted caller drains the fill when no other owner references it. */
  async wait(pending: PendingBytes, signal: AbortSignal): Promise<WindReadResult> {
    if (this.foreground) for (const handle of pending.handles) handle.promote();
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([pending.promise, cancelled]); }
    catch (error) {
      if (signal.aborted && pending.entries.every(entry => !entry.references)) await pending.promise.catch(() => {});
      throw error;
    } finally { signal.removeEventListener('abort', abort); }
  }

  /** Stream `url` into `targets` in order, retrying transient failures and demotions. */
  async read(url: string, type: string, targets: CachedBytes[], pending: PendingBytes): Promise<WindReadResult> {
    const attemptSignal = pending.controller.signal;
    attemptSignal.throwIfAborted();
    if (this.cache.failureRemaining(url) > 0) throw new Error('Numeric resource is cooling down');
    const transient = (error: unknown) => error instanceof WindTransientError || (error instanceof TypeError && !attemptSignal.aborted);
    // A demotion re-runs at once and never spends a retry, even after the last one; p-retry
    // checks its retry budget before any predicate, so demotions are looped here instead.
    const retries = this.options.retries ?? 2;
    let spent = 0;
    for (;;) {
      try {
        // p-retry gives up at once on a TypeError it does not recognise as a network failure.
        return await pRetry(() => this.readOnce(url, type, targets, pending).catch((error: unknown) => {
          throw error instanceof TypeError && !attemptSignal.aborted ? Object.assign(new WindTransientError(error.message), { cause: error }) : error;
        }), {
          retries: Math.max(0, retries - spent), minTimeout: this.options.retryMinTimeoutMs ?? 250, factor: 4, randomize: true, signal: attemptSignal,
          shouldRetry: ({ error }) => transient(error),
          onFailedAttempt: ({ error }) => { if (transient(error)) spent++; }
        });
      } catch (error) {
        if (error === DEMOTED_REQUEST) { attemptSignal.throwIfAborted(); continue; }
        if (transient(error)) this.cache.recordFailure(url);
        throw error;
      }
    }
  }

  /**
   * Hold, fetch and decode `rawTasks` under `root`. Adjacent tiles coalesce into span requests
   * when the server supports them. Returns every task's decoded chunk once all fills settle.
   */
  async fetchChunks(root: string, expiresAtMs: number, rawTasks: WindChunkTask[], signal: AbortSignal, decode: (kind: string, bytes: Uint8Array) => PackedWindChunk | DataView): Promise<Array<WindChunkTask & { decoded: PackedWindChunk | DataView }>> {
    const admission = this.cache.horizonCost(root, rawTasks, 1);
    if (admission.resource) throw new WindCapacityError(undefined, admission.resource);
    const coalesce = (this.options.coalesceSpans ?? !this.options.fetchImpl) && !this.cache.spansUnsupported;
    const tasks: Array<WindChunkTask & { entry: CachedBytes }> = [];
    try {
      for (const item of rawTasks) tasks.push({ ...item, entry: this.hold(this.cache.take(`${root}/${item.kind}/${item.tile}`, item.bytes, expiresAtMs, this.foreground, true)) });
    } catch (error) {
      for (const { entry } of tasks) this.release(entry);
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
    const check = (used: WindReadResult, expected: number) => {
      if (typeof used !== 'number') throw new Error('Numeric chunk missing');
      if (used !== expected) throw new Error('Numeric chunk length mismatch');
    };
    const lanes: Promise<unknown>[] = Array.from({ length: LANES }, () => Promise.resolve());
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
          let used: WindReadResult = 'retry-single';
          if (batch.length > 1 && !this.cache.spansUnsupported) {
            used = await this.read(`${root}/${first.kind}/${first.tile}-${batch.at(-1)!.tile}`, 'application/octet-stream', entries, owner);
            if (used === 'unsupported-span') this.cache.recordSpanResult(false);
            else if (used !== 'retry-single') this.cache.recordSpanResult(true);
          }
          if (used === 'unsupported-span' || used === 'retry-single') {
            for (const item of batch) check(await this.read(`${root}/${item.kind}/${item.tile}`, 'application/octet-stream', [item.entry], owner), item.bytes);
          } else check(used, entries.length * first.bytes);
          for (const item of batch) item.entry.decoded = decode(item.kind, item.entry.bytes);
          for (const item of batch) item.entry.used = item.bytes;
          return entries.length * first.bytes;
        } catch (error) { failure ??= error; throw error; }
      });
      lanes[lane] = pending.promise;
    }
    const pending = new Set(tasks.flatMap(item => item.entry.pending ? [item.entry.pending] : []));
    try { await Promise.all([...pending].map(item => this.wait(item, signal))); }
    catch (error) {
      for (const { entry } of tasks) this.release(entry);
      const drained = new Set<PendingBytes>();
      for (;;) {
        const aborted = [...pending].filter(item => item.controller.signal.aborted && !drained.has(item));
        if (!aborted.length) break;
        for (const item of aborted) drained.add(item);
        await Promise.all(aborted.map(item => item.promise.catch(() => {})));
      }
      throw error;
    }
    signal.throwIfAborted();
    return tasks.map(({ kind, tile, bytes, entry }) => {
      entry.decoded ??= decode(kind, entry.bytes);
      entry.used = entry.bytes.length;
      return { kind, tile, bytes, decoded: entry.decoded };
    });
  }

  private async readOnce(url: string, type: string, targets: CachedBytes[], pending: PendingBytes): Promise<WindReadResult> {
    const attemptSignal = pending.controller.signal;
    attemptSignal.throwIfAborted();
    const limit = targets.reduce((sum, item) => sum + item.capacity, 0);
    let foreground: boolean, responseLease: PreparationLease | undefined;
    for (;;) {
      foreground = pendingForeground(pending);
      const required = (pending.responseLease ? 0 : limit) + targets.reduce((sum, item) => sum + (item.bytes.length ? 0 : item.capacity), 0);
      if (!foreground && this.budget && required > this.budget.backgroundLimit) throw new WindCapacityError();
      if (!foreground && this.budget && !this.budget.canReserve(required, 'background')) this.cache.evictUnreferenced();
      if (!foreground && this.budget && !this.budget.canReserve(required, 'background')) {
        const budget = this.budget;
        await new Promise<void>((resolve, reject) => {
          const finish = () => { unsubscribe(); cacheUnsubscribe(); pending.wake.delete(finish); attemptSignal.removeEventListener('abort', abort); resolve(); };
          const abort = () => { unsubscribe(); cacheUnsubscribe(); pending.wake.delete(finish); attemptSignal.removeEventListener('abort', abort); reject(attemptSignal.reason); };
          const unsubscribe = budget.onRelease(finish);
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
  }
}
