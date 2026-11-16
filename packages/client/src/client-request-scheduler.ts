interface SchedulerOptions {
  fetchImpl?: typeof fetch;
  maxActive?: number;
  maxQueued?: number;
  /** When set, the concurrency slot frees at headers. Each request reserves 1 MiB until content-length arrives. */
  maxInFlightBytes?: number;
}

const HEADER_RESERVE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;

export function createForecastRequestScheduler(options: SchedulerOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxActive = options.maxActive ?? 6, maxQueued = options.maxQueued ?? 64, maxInFlightBytes = options.maxInFlightBytes;
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 12
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 64
    || (maxInFlightBytes !== undefined && (!Number.isSafeInteger(maxInFlightBytes) || maxInFlightBytes < 1024 || maxInFlightBytes > MAX_IN_FLIGHT_BYTES))) throw new Error('Invalid forecast request limits');

  const queued: Array<{ start(): void; controller: AbortController; low: boolean }> = [], active = new Set<AbortController>(), live = new Set<AbortController>();
  let disposed = false, bodyBytes = 0;
  const abortError = () => new DOMException('Forecast request cancelled', 'AbortError');
  const fits = () => maxInFlightBytes === undefined || bodyBytes + HEADER_RESERVE_BYTES <= maxInFlightBytes;

  function pump() {
    while (!disposed && active.size < maxActive && queued.length && fits()) {
      const foreground = queued.findIndex(task => !task.low);
      queued.splice(foreground < 0 ? 0 : foreground, 1)[0].start();
    }
  }

  const scheduledFetch: typeof fetch = (input, init) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
    if (disposed) { reject(abortError()); return; }
    if (signal?.aborted) { reject(signal.reason); return; }
    const low = (init as RequestInit & { priority?: string } | undefined)?.priority === 'low';
    if (active.size >= maxActive && queued.length >= maxQueued) {
      const evict = !low ? queued.findIndex(item => item.low) : -1;
      if (evict < 0) { reject(new Error('Forecast request queue is full')); return; }
      queued[evict]!.controller.abort(abortError());
    }

    const controller = new AbortController();
    const task = { start, controller, low };
    let started = false, finished = false, delivered = false, heldBytes = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const charge = (next: number) => { bodyBytes += next - heldBytes; heldBytes = next; };
    const releaseCharge = () => { bodyBytes -= heldBytes; heldBytes = 0; };
    function finish() {
      if (finished) return;
      finished = true;
      releaseCharge();
      signal?.removeEventListener('abort', externalAbort);
      controller.signal.removeEventListener('abort', abort);
      live.delete(controller);
      if (started) active.delete(controller);
      else {
        const index = queued.indexOf(task);
        if (index >= 0) queued.splice(index, 1);
      }
      pump();
    }
    function cancelReader(reason: unknown): Promise<void> {
      cancellation ??= reader!.cancel(reason).catch(() => {}).finally(() => { reader!.releaseLock(); finish(); });
      return cancellation;
    }
    function abort() {
      const reason = controller.signal.reason;
      if (delivered) streamController?.error(reason);
      else reject(reason);
      // A body-gated request keeps its slot until the fetch or body settles. A byte-budget
      // request releases its reserve here so a cancel does not keep the cap full.
      if (reader) void cancelReader(reason);
      else if (!started || maxInFlightBytes !== undefined) finish();
    }
    function externalAbort() { controller.abort(signal?.reason); }
    controller.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', externalAbort, { once: true });
    function start() {
      started = true;
      active.add(controller);
      live.add(controller);
      void (async () => {
        if (maxInFlightBytes !== undefined) charge(HEADER_RESERVE_BYTES);
        try {
          const response = await fetchImpl(input, { ...init, signal: controller.signal });
          if (controller.signal.aborted) {
            await response.body?.cancel(controller.signal.reason).catch(() => {});
            finish(); return;
          }
          if (maxInFlightBytes !== undefined) {
            const declared = Number(response.headers.get('content-length'));
            charge(Number.isFinite(declared) && declared >= 0 ? declared : heldBytes);
            active.delete(controller);
            pump();
          }
          if (controller.signal.aborted) {
            await response.body?.cancel(controller.signal.reason).catch(() => {});
            finish(); return;
          }
          if (!response.body) { finish(); resolve(response); return; }
          reader = response.body.getReader();
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
            cancel(reason) {
              return cancelReader(reason);
            }
          }, { highWaterMark: 0 });
          const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
          Object.defineProperties(wrapped, {
            url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type }
          });
          delivered = true;
          resolve(wrapped);
        } catch (error) {
          if (!finished) {
            if (reader) await cancelReader(error);
            else finish();
            reject(error);
          }
        }
      })();
    }
    queued.push(task);
    pump();
  });

  return {
    fetch: scheduledFetch,
    stats: () => ({ active: active.size, queued: queued.length }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of [...live]) controller.abort(abortError());
      for (const task of [...queued]) task.controller.abort(abortError());
    }
  };
}
