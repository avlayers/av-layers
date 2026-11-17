import type { PreparationBudget, PreparationLease } from './client-preparation-budget.ts';

interface SchedulerOptions {
  fetchImpl?: typeof fetch;
  budget?: PreparationBudget;
  maxActive?: number;
  maxQueued?: number;
  /** When set, each request reserves bytes until its body settles. */
  maxInFlightBytes?: number;
  /** Maximum simultaneous speculative bodies. */
  maxBackgroundActive?: number;
  /** Maximum speculative body reservations. */
  maxBackgroundBytes?: number;
}

export type RequestPriority = 'foreground' | 'background';

export interface ForecastRequestSpec {
  url: string;
  priority: RequestPriority;
  kind: 'raster' | 'wind' | 'json';
  /** Hard ceiling for the response body. */
  maxResponseBytes: number;
  /** Known numeric size; the response must match exactly. */
  exactResponseBytes?: number;
  /** Admission reservation until the declared length or streamed bytes grow it. */
  initialReserveBytes?: number;
  init?: RequestInit;
  responseLease?: { budget: PreparationBudget; lease: PreparationLease };
}

export interface ForecastRequestHandle {
  readonly started?: boolean;
  /** One physical owner's body. */
  response: Promise<Response>;
  /** Resolves after cleanup on success, failure or cancellation. */
  settled: Promise<void>;
  /** Monotonic and idempotent. */
  promote(): void;
  cancel(reason?: unknown): void;
}

const HEADER_RESERVE_BYTES = 1024 * 1024;
const INITIAL_RESERVE_BYTES = 16 * 1024;
const MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const BACKGROUND_BYTES = 2 * 1024 * 1024;
const FOREGROUND_RESERVE_ACTIVE = 2;
const FOREGROUND_RESERVE_BYTES = 2 * 1024 * 1024;

export type CapacityCode = 'capacity' | 'configuration';

export class ForecastCapacityError extends Error {
  constructor(readonly code: CapacityCode, message: string) {
    super(message);
    this.name = 'ForecastCapacityError';
  }
}

const fetchBudgets = new WeakMap<typeof fetch, PreparationBudget>();
export function schedulerFetchBudget(fetchImpl: typeof fetch): PreparationBudget | undefined { return fetchBudgets.get(fetchImpl); }

export function createForecastRequestScheduler(options: SchedulerOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxActive = options.maxActive ?? 24, maxQueued = options.maxQueued ?? 64, maxInFlightBytes = options.maxInFlightBytes ?? 24 * 1024 * 1024;
  const reserveActive = Math.min(maxActive >= 16 ? 4 : FOREGROUND_RESERVE_ACTIVE, Math.max(0, maxActive - 1));
  const desiredReserveBytes = maxActive >= 16 ? 4 * 1024 * 1024 : FOREGROUND_RESERVE_BYTES;
  const maxBackgroundActive = options.maxBackgroundActive ?? Math.max(1, maxActive - reserveActive);
  const maxBackgroundBytes = options.maxBackgroundBytes ?? (maxActive >= 16 ? Math.max(1024, maxInFlightBytes - desiredReserveBytes) : Math.min(BACKGROUND_BYTES, maxInFlightBytes));
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 32
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 64
    || (maxInFlightBytes !== undefined && (!Number.isSafeInteger(maxInFlightBytes) || maxInFlightBytes < 1024 || maxInFlightBytes > MAX_IN_FLIGHT_BYTES))
    || !Number.isSafeInteger(maxBackgroundActive) || maxBackgroundActive < 1 || maxBackgroundActive > maxActive
    || !Number.isSafeInteger(maxBackgroundBytes) || maxBackgroundBytes < 1024 || maxBackgroundBytes > (maxInFlightBytes ?? MAX_IN_FLIGHT_BYTES)) throw new Error('Invalid forecast request limits');

  const reserveBytes = Math.min(desiredReserveBytes, Math.max(0, maxInFlightBytes - maxBackgroundBytes));

  interface Task {
    start(): void;
    controller: AbortController;
    isForeground(): boolean;
    reserve(): number;
    precharged(): boolean;
    promote(): void;
  }
  const queued: Task[] = [], active = new Set<AbortController>(), live = new Set<AbortController>();
  let disposed = false, bodyBytes = 0, backgroundBytes = 0, backgroundActive = 0, foregroundPending = false, foregroundEpoch = -1;
  const abortError = () => new DOMException('Forecast request cancelled', 'AbortError');

  function admits(foreground: boolean, reserve: number, precharged = false): boolean {
    if (active.size >= maxActive) return false;
    if (maxInFlightBytes !== undefined && bodyBytes + reserve > maxInFlightBytes) return false;
    if (options.budget && !precharged && !options.budget.canReserve(reserve, foreground ? 'foreground' : 'background')) return false;
    if (foreground) return true;
    return !foregroundPending && backgroundActive < maxBackgroundActive
      && active.size < maxActive - reserveActive
      && backgroundBytes + reserve <= maxBackgroundBytes
      && (maxInFlightBytes === undefined || bodyBytes + reserve + reserveBytes <= maxInFlightBytes);
  }

  function pump() {
    while (!disposed && queued.length) {
      let picked = -1;
      for (let index = 0; index < queued.length && picked < 0; index++) {
        const task = queued[index]!;
        if (task.isForeground() && admits(true, task.reserve(), task.precharged())) picked = index;
      }
      for (let index = 0; index < queued.length && picked < 0; index++) {
        const task = queued[index]!;
        if (!task.isForeground() && admits(false, task.reserve(), task.precharged())) picked = index;
      }
      if (picked < 0) return;
      queued.splice(picked, 1)[0]!.start();
    }
  }

  function schedule(input: RequestInfo | URL, init: RequestInit | undefined, spec?: { foreground: boolean; maxResponseBytes: number; exactResponseBytes?: number; initialReserveBytes?: number; responseLease?: PreparationLease }): ForecastRequestHandle {
    const signal = init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
    let settleResponse!: () => void, resolveResponse!: (value: Response) => void, rejectResponse!: (reason: unknown) => void;
    const settled = new Promise<void>(resolve => { settleResponse = resolve; });
    const response = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const controller = new AbortController();
    const bodyLimit = spec ? spec.maxResponseBytes : maxInFlightBytes;
    const exact = spec?.exactResponseBytes;
    const taskReserve = spec ? Math.min(spec.responseLease?.bytes ?? exact ?? spec.initialReserveBytes ?? INITIAL_RESERVE_BYTES, bodyLimit) : options.budget ? 1024 : HEADER_RESERVE_BYTES;
    let foreground = spec?.foreground ?? (init as RequestInit & { priority?: string } | undefined)?.priority !== 'low';
    let started = false, finished = false, delivered = false, heldBytes = 0, backgroundHeld = false;
    let lease: PreparationLease | null = spec?.responseLease ?? null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let consumed = 0;
    let cancellation: Promise<void> | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    const charge = (next: number) => {
      const capped = spec ? Math.min(next, bodyLimit) : next;
      const delta = capped - heldBytes;
      if (bodyBytes + delta > maxInFlightBytes) throw new ForecastCapacityError('capacity', 'Response exceeds in-flight budget');
      if (backgroundHeld && (backgroundBytes + delta > maxBackgroundBytes || bodyBytes + delta + reserveBytes > maxInFlightBytes)) throw new ForecastCapacityError('capacity', 'Background response exceeds in-flight budget');
      if (lease && !lease.resize(capped)) throw new ForecastCapacityError('capacity', 'Preparation budget exhausted');
      bodyBytes += delta;
      if (backgroundHeld) backgroundBytes += delta;
      heldBytes = capped;
    };
    const releaseCharge = () => {
      bodyBytes -= heldBytes;
      if (backgroundHeld) backgroundBytes -= heldBytes;
      heldBytes = 0; backgroundHeld = false;
      if (lease) { lease.release(); lease = null; }
    };
    function finish() {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', externalAbort);
      controller.signal.removeEventListener('abort', abort);
      live.delete(controller);
      if (started) {
        active.delete(controller);
        if (backgroundHeld) backgroundActive--;
      } else {
        const index = queued.indexOf(task);
        if (index >= 0) queued.splice(index, 1);
      }
      releaseCharge();
      settleResponse();
      pump();
    }
    function cancelReader(reason: unknown): Promise<void> {
      cancellation ??= reader!.cancel(reason).catch(() => {}).finally(() => { reader!.releaseLock(); finish(); });
      return cancellation;
    }
    function abort() {
      const reason = controller.signal.reason;
      if (delivered) streamController?.error(reason);
      else rejectResponse(reason);
      if (!started) finish();
      else if (reader) void cancelReader(reason);
    }
    function externalAbort() { controller.abort(signal?.reason); }
    function promote() {
      if (foreground || finished) return;
      foreground = true; lease?.promote?.();
      if (backgroundHeld) {
        backgroundActive--; backgroundBytes -= heldBytes; backgroundHeld = false;
      }
      pump();
    }
    const task: Task = { controller, start, promote, isForeground: () => foreground, reserve: () => taskReserve, precharged: () => !!lease };

    function start() {
      lease ??= options.budget?.reserve('response', taskReserve, foreground ? 'foreground' : 'background') ?? null;
      if (options.budget && !lease) throw new ForecastCapacityError('capacity', 'Preparation budget exhausted');
      started = true;
      active.add(controller);
      live.add(controller);
      if (!foreground) { backgroundActive++; backgroundHeld = true; }
      charge(taskReserve);
      void (async () => {
        try {
          const fetched = await fetchImpl(input, { ...init, signal: controller.signal });
          if (controller.signal.aborted) {
            await fetched.body?.cancel(controller.signal.reason).catch(() => {});
            finish(); return;
          }
          const declared = fetched.headers.get('content-length');
          const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
          const encoding = fetched.headers.get('content-encoding'), identity = encoding === 'identity';
          let successful = false;
          try {
            if (length !== null && spec && identity && length > bodyLimit) {
              if (fetched.ok) throw new ForecastCapacityError('capacity', 'Response exceeds its admitted size');
              await fetched.body?.cancel(controller.signal.reason).catch(() => {});
              finish();
              const empty = new Response(null, { status: fetched.status, statusText: fetched.statusText, headers: fetched.headers });
              Object.defineProperties(empty, { url: { value: fetched.url }, redirected: { value: fetched.redirected }, type: { value: fetched.type } });
              resolveResponse(empty); return;
            }
            successful = fetched.ok;
            if (spec && exact !== undefined && successful) {
              if (length !== null && identity && length !== exact) throw new ForecastCapacityError('capacity', 'Response does not match its exact size');
              charge(exact);
            } else if (spec) {
              if (length !== null && identity && successful) charge(length);
            } else if (length !== null && identity) charge(Math.min(length, taskReserve));
          } catch (error) {
            await fetched.body?.cancel(error).catch(() => {});
            throw error;
          }
          pump();
          if (controller.signal.aborted) {
            await fetched.body?.cancel(controller.signal.reason).catch(() => {});
            finish(); return;
          }
          if (!fetched.body) {
            if (successful && exact !== undefined && exact > 0) {
              const error = new ForecastCapacityError('capacity', 'Response does not match its exact size');
              finish(); rejectResponse(error); return;
            }
            finish(); resolveResponse(fetched); return;
          }
          reader = fetched.body.getReader();
          const body = new ReadableStream<Uint8Array>({
            start(value) { streamController = value; },
            async pull(value) {
              try {
                const result = await reader!.read();
                if (finished || cancellation || controller.signal.aborted) return;
                if (result.done) {
                  if (successful && exact !== undefined && consumed !== exact) {
                    const error = new ForecastCapacityError('capacity', 'Response does not match its exact size');
                    value.error(error);
                    await cancelReader(error);
                    return;
                  }
                  reader!.releaseLock(); finish(); value.close(); return;
                }
                consumed += result.value.length;
                if (consumed > bodyLimit) {
                  const error = new ForecastCapacityError('capacity', 'Response body exceeds its admitted size');
                  value.error(error);
                  await cancelReader(error);
                  return;
                }
                if (successful && exact !== undefined && consumed > exact) {
                  const error = new ForecastCapacityError('capacity', 'Response body exceeds its admitted size');
                  value.error(error);
                  await cancelReader(error);
                  return;
                }
                if (consumed > heldBytes) {
                  try { charge(consumed); }
                  catch (error) { value.error(error); await cancelReader(error); return; }
                }
                value.enqueue(result.value);
              } catch (error) {
                if (!finished && !cancellation) { reader!.releaseLock(); finish(); value.error(error); }
              }
            },
            cancel(reason) { return cancelReader(reason); }
          }, { highWaterMark: 0 });
          const wrapped = new Response(body, { status: fetched.status, statusText: fetched.statusText, headers: fetched.headers });
          Object.defineProperties(wrapped, {
            url: { value: fetched.url }, redirected: { value: fetched.redirected }, type: { value: fetched.type }
          });
          delivered = true;
          resolveResponse(wrapped);
        } catch (error) {
          if (!finished) {
            if (reader) await cancelReader(error);
            else finish();
            rejectResponse(error);
          }
        }
      })();
    }

    controller.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (disposed || signal?.aborted) {
      const reason = disposed ? abortError() : signal!.reason;
      signal?.removeEventListener('abort', externalAbort);
      controller.signal.removeEventListener('abort', abort);
      releaseCharge();
      rejectResponse(reason);
      settleResponse();
      return { response, settled, get started() { return started; }, promote() {}, cancel() {} };
    }
    if (options.budget && taskReserve > options.budget.limit) {
      signal?.removeEventListener('abort', externalAbort);
      controller.signal.removeEventListener('abort', abort);
      releaseCharge();
      rejectResponse(new ForecastCapacityError('capacity', 'Forecast request exceeds preparation budget'));
      settleResponse();
      return { response, settled, get started() { return started; }, promote() {}, cancel() {} };
    }
    if (!admits(foreground, taskReserve, !!lease) && queued.length >= maxQueued) {
      const evict = foreground ? queued.findIndex(item => !item.isForeground()) : -1;
      if (evict < 0) {
        const error = new Error('Forecast request queue is full');
        signal?.removeEventListener('abort', externalAbort);
        controller.signal.removeEventListener('abort', abort);
        releaseCharge();
        rejectResponse(error); settleResponse();
        return { response, settled, get started() { return started; }, promote() {}, cancel() {} };
      }
      queued[evict]!.controller.abort(abortError());
    }
    queued.push(task);
    pump();
    return {
      response, settled, promote,
      get started() { return started; },
      cancel(reason) { controller.abort(reason ?? abortError()); }
    };
  }

  const scheduledFetch: typeof fetch = (input, init) => schedule(input, init).response;
  if (options.budget) fetchBudgets.set(scheduledFetch, options.budget);
  const unsubscribe = options.budget?.onRelease(pump);

  return {
    fetch: scheduledFetch,
    request(spec: ForecastRequestSpec): ForecastRequestHandle {
      if (!Number.isSafeInteger(spec.maxResponseBytes) || spec.maxResponseBytes <= 0
        || (spec.exactResponseBytes !== undefined && (!Number.isSafeInteger(spec.exactResponseBytes) || spec.exactResponseBytes < 0 || spec.exactResponseBytes > spec.maxResponseBytes))
        || (spec.initialReserveBytes !== undefined && (!Number.isSafeInteger(spec.initialReserveBytes) || spec.initialReserveBytes <= 0 || spec.initialReserveBytes > spec.maxResponseBytes))) {
        throw new ForecastCapacityError('configuration', 'Invalid forecast request size');
      }
      const bound = spec.priority === 'foreground' ? (maxInFlightBytes ?? MAX_IN_FLIGHT_BYTES)
        : Math.min(maxBackgroundBytes, maxInFlightBytes === undefined ? maxBackgroundBytes : Math.max(0, maxInFlightBytes - reserveBytes));
      const precharged = spec.responseLease?.lease.bytes;
      const taskReserve = precharged ?? Math.min(spec.exactResponseBytes ?? spec.initialReserveBytes ?? INITIAL_RESERVE_BYTES, spec.maxResponseBytes);
      if (taskReserve > bound) throw new ForecastCapacityError('capacity', 'Forecast request exceeds its class bound');
      if (precharged !== undefined && precharged !== (spec.exactResponseBytes ?? spec.maxResponseBytes)) throw new ForecastCapacityError('configuration', 'Invalid forecast response lease');
      if (options.budget && taskReserve > options.budget.limit) throw new ForecastCapacityError('capacity', 'Forecast request exceeds preparation budget');
      let responseLease: PreparationLease | undefined;
      if (spec.responseLease) {
        if (!options.budget || spec.responseLease.budget !== options.budget) throw new ForecastCapacityError('configuration', 'Invalid forecast response lease');
        responseLease = options.budget.transfer(spec.responseLease.lease) ?? undefined;
        if (!responseLease) throw new ForecastCapacityError('configuration', 'Invalid forecast response lease');
      }
      return schedule(spec.url, { ...spec.init, priority: spec.priority === 'background' ? 'low' : 'high' } as RequestInit,
        { foreground: spec.priority === 'foreground', maxResponseBytes: spec.maxResponseBytes, exactResponseBytes: spec.exactResponseBytes, initialReserveBytes: spec.initialReserveBytes, responseLease });
    },
    setForegroundPending(epoch: number, pending: boolean) {
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('Invalid foreground epoch');
      if (epoch < foregroundEpoch) return;
      foregroundEpoch = epoch; foregroundPending = pending;
      if (!pending) pump();
    },
    stats: () => ({ active: active.size, queued: queued.length }),
    detail: () => ({ active: active.size, queued: queued.length, live: live.size, bodyBytes, backgroundBytes, backgroundActive }),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      for (const controller of [...live]) controller.abort(abortError());
      for (const task of [...queued]) task.controller.abort(abortError());
    }
  };
}
