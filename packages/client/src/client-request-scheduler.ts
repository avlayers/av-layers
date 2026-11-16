interface SchedulerOptions {
  fetchImpl?: typeof fetch;
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
  maxResponseBytes: number;
  expectedResponseBytes?: number;
}

export interface ForecastRequestHandle {
  /** One physical owner's body. */
  response: Promise<Response>;
  /** Resolves after cleanup on success, failure or cancellation. */
  settled: Promise<void>;
  /** Monotonic and idempotent. */
  promote(): void;
  cancel(reason?: unknown): void;
}

const HEADER_RESERVE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;
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

export function createForecastRequestScheduler(options: SchedulerOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxActive = options.maxActive ?? 6, maxQueued = options.maxQueued ?? 64, maxInFlightBytes = options.maxInFlightBytes;
  const maxBackgroundActive = options.maxBackgroundActive ?? Math.min(6, maxActive);
  const maxBackgroundBytes = options.maxBackgroundBytes ?? Math.min(BACKGROUND_BYTES, maxInFlightBytes ?? BACKGROUND_BYTES);
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 12
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 64
    || (maxInFlightBytes !== undefined && (!Number.isSafeInteger(maxInFlightBytes) || maxInFlightBytes < 1024 || maxInFlightBytes > MAX_IN_FLIGHT_BYTES))
    || !Number.isSafeInteger(maxBackgroundActive) || maxBackgroundActive < 1 || maxBackgroundActive > maxActive
    || !Number.isSafeInteger(maxBackgroundBytes) || maxBackgroundBytes < 1024 || maxBackgroundBytes > (maxInFlightBytes ?? MAX_IN_FLIGHT_BYTES)) throw new Error('Invalid forecast request limits');

  const reserveActive = Math.min(FOREGROUND_RESERVE_ACTIVE, Math.max(0, maxActive - 1));
  const reserveBytes = maxInFlightBytes === undefined ? 0 : Math.min(FOREGROUND_RESERVE_BYTES, maxInFlightBytes);

  interface Task {
    start(): void;
    controller: AbortController;
    isForeground(): boolean;
    reserve(): number;
    promote(): void;
  }
  const queued: Task[] = [], active = new Set<AbortController>(), live = new Set<AbortController>();
  let disposed = false, bodyBytes = 0, backgroundBytes = 0, backgroundActive = 0;
  const abortError = () => new DOMException('Forecast request cancelled', 'AbortError');

  function admits(foreground: boolean, reserve: number): boolean {
    if (active.size >= maxActive) return false;
    if (maxInFlightBytes !== undefined && bodyBytes + reserve > maxInFlightBytes) return false;
    if (foreground) return true;
    return backgroundActive < maxBackgroundActive
      && active.size < maxActive - reserveActive
      && backgroundBytes + reserve <= maxBackgroundBytes
      && (maxInFlightBytes === undefined || bodyBytes + reserve + reserveBytes <= maxInFlightBytes);
  }

  function pump() {
    while (!disposed && queued.length) {
      let picked = -1;
      for (let index = 0; index < queued.length && picked < 0; index++) {
        const task = queued[index]!;
        if (task.isForeground() && admits(true, task.reserve())) picked = index;
      }
      for (let index = 0; index < queued.length && picked < 0; index++) {
        const task = queued[index]!;
        if (admits(false, task.reserve())) picked = index;
      }
      if (picked < 0) return;
      queued.splice(picked, 1)[0]!.start();
    }
  }

  function schedule(input: RequestInfo | URL, init: RequestInit | undefined, spec?: { foreground: boolean; maxResponseBytes: number; expectedResponseBytes?: number }): ForecastRequestHandle {
    const signal = init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
    let settleResponse!: () => void, resolveResponse!: (value: Response) => void, rejectResponse!: (reason: unknown) => void;
    const settled = new Promise<void>(resolve => { settleResponse = resolve; });
    const response = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const controller = new AbortController();
    const taskReserve = spec ? (spec.expectedResponseBytes && spec.expectedResponseBytes > 0 ? spec.expectedResponseBytes : spec.maxResponseBytes) : HEADER_RESERVE_BYTES;
    let foreground = spec?.foreground ?? (init as RequestInit & { priority?: string } | undefined)?.priority !== 'low';
    let started = false, finished = false, delivered = false, heldBytes = 0, backgroundHeld = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    const charge = (next: number) => {
      const capped = Math.min(next, taskReserve);
      const delta = capped - heldBytes;
      bodyBytes += delta;
      if (backgroundHeld) backgroundBytes += delta;
      heldBytes = capped;
    };
    const releaseCharge = () => {
      bodyBytes -= heldBytes;
      if (backgroundHeld) backgroundBytes -= heldBytes;
      heldBytes = 0; backgroundHeld = false;
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
      foreground = true;
      if (backgroundHeld) {
        backgroundActive--; backgroundBytes -= heldBytes; backgroundHeld = false;
      }
      pump();
    }
    const task: Task = { controller, start, promote, isForeground: () => foreground, reserve: () => taskReserve };

    function start() {
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
          if (length !== null && spec && length > spec.maxResponseBytes) {
            await fetched.body?.cancel(controller.signal.reason).catch(() => {});
            throw new ForecastCapacityError('capacity', 'Response exceeds its admitted size');
          }
          const encoding = fetched.headers.get('content-encoding');
          if (length !== null && encoding === 'identity') charge(length);
          pump();
          if (controller.signal.aborted) {
            await fetched.body?.cancel(controller.signal.reason).catch(() => {});
            finish(); return;
          }
          if (!fetched.body) { finish(); resolveResponse(fetched); return; }
          reader = fetched.body.getReader();
          const body = new ReadableStream<Uint8Array>({
            start(value) { streamController = value; },
            async pull(value) {
              try {
                const result = await reader!.read();
                if (finished || cancellation || controller.signal.aborted) return;
                if (result.done) { reader!.releaseLock(); finish(); value.close(); }
                else value.enqueue(result.value);
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
      rejectResponse(reason);
      settleResponse();
      return { response, settled, promote() {}, cancel() {} };
    }
    if (!admits(foreground, taskReserve) && queued.length >= maxQueued) {
      const evict = foreground ? queued.findIndex(item => !item.isForeground()) : -1;
      if (evict < 0) {
        const error = new Error('Forecast request queue is full');
        rejectResponse(error); settleResponse();
        return { response, settled, promote() {}, cancel() {} };
      }
      queued[evict]!.controller.abort(abortError());
    }
    queued.push(task);
    pump();
    return {
      response, settled, promote,
      cancel(reason) { controller.abort(reason ?? abortError()); }
    };
  }

  const scheduledFetch: typeof fetch = (input, init) => schedule(input, init).response;

  return {
    fetch: scheduledFetch,
    request(spec: ForecastRequestSpec): ForecastRequestHandle {
      if (!Number.isSafeInteger(spec.maxResponseBytes) || spec.maxResponseBytes <= 0
        || (spec.expectedResponseBytes !== undefined && (!Number.isSafeInteger(spec.expectedResponseBytes) || spec.expectedResponseBytes < 0 || spec.expectedResponseBytes > spec.maxResponseBytes))) {
        throw new ForecastCapacityError('configuration', 'Invalid forecast request size');
      }
      const bound = spec.priority === 'foreground' ? (maxInFlightBytes ?? MAX_IN_FLIGHT_BYTES) : Math.min(maxBackgroundBytes, maxInFlightBytes ?? maxBackgroundBytes);
      if (spec.maxResponseBytes > bound) throw new ForecastCapacityError('capacity', 'Forecast request exceeds its class bound');
      return schedule(spec.url, { priority: spec.priority === 'background' ? 'low' : 'high' } as RequestInit,
        { foreground: spec.priority === 'foreground', maxResponseBytes: spec.maxResponseBytes, expectedResponseBytes: spec.expectedResponseBytes });
    },
    stats: () => ({ active: active.size, queued: queued.length }),
    detail: () => ({ active: active.size, queued: queued.length, live: live.size, bodyBytes, backgroundBytes, backgroundActive }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of [...live]) controller.abort(abortError());
      for (const task of [...queued]) task.controller.abort(abortError());
    }
  };
}
