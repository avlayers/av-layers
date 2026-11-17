import { expect, it, vi } from 'vitest';
import { createForecastRequestScheduler, createSourceRasterTileProtocol } from './client-raster';
import { createPreparationBudget } from './client-preparation-budget';

function streamResponse() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel }));
  return { response, stream, cancel };
}

it('shares six slots until mixed response bodies finish', async () => {
  const streams = Array.from({ length: 12 }, streamResponse);
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => streams[index++].response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 6 });
  const requests = streams.map((_, i) => scheduler.fetch(`https://example.test/${i % 2 ? 'raster' : 'numeric'}/${i}`));
  expect(fetchImpl).toHaveBeenCalledTimes(6);
  const responses = await Promise.all(requests.slice(0, 6));
  expect(scheduler.stats()).toEqual({ active: 6, queued: 6 });
  const reads = responses.map(response => response.arrayBuffer());
  for (let i = 0; i < 6; i++) {
    streams[i].stream.enqueue(new Uint8Array([i]));
    streams[i].stream.close();
    await reads[i];
    expect(fetchImpl).toHaveBeenCalledTimes(7 + i);
  }
  const rest = await Promise.all(requests.slice(6));
  const remaining = rest.map(response => response.arrayBuffer());
  streams.slice(6).forEach(item => item.stream.close());
  await Promise.all(remaining);
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
});

it('removes queued aborts and keeps the caller abort reason', async () => {
  const first = streamResponse(), fetchImpl = vi.fn<typeof fetch>(async () => first.response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 1, maxQueued: 1 });
  const response = await scheduler.fetch('https://example.test/first');
  const controller = new AbortController(), reason = new Error('deadline');
  const pending = scheduler.fetch('https://example.test/queued', { signal: controller.signal });
  await expect(scheduler.fetch('https://example.test/full')).rejects.toThrow('queue is full');
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(scheduler.stats()).toEqual({ active: 1, queued: 0 });
  await response.body!.cancel();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  scheduler.dispose();
});

it('cancels the active body on abort and admits waiting work', async () => {
  const first = streamResponse();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(first.response).mockResolvedValueOnce(new Response('next'));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 1 });
  const controller = new AbortController(), response = await scheduler.fetch('https://example.test/first', { signal: controller.signal });
  const reading = response.text();
  const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  const next = scheduler.fetch('https://example.test/next');
  controller.abort();
  await rejected;
  expect(first.cancel).toHaveBeenCalledOnce();
  expect(await (await next).text()).toBe('next');
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
});

it('disposes active and queued work without dispatching it', async () => {
  const first = streamResponse(), fetchImpl = vi.fn<typeof fetch>(async () => first.response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 1 });
  const response = await scheduler.fetch('https://example.test/first');
  const pending = scheduler.fetch('https://example.test/queued');
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  scheduler.dispose();
  await rejected;
  await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
  await expect(scheduler.fetch('https://example.test/later')).rejects.toMatchObject({ name: 'AbortError' });
  expect(first.cancel).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
});

it('prefers queued foreground requests over speculative requests', async () => {
  const first = streamResponse(), fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(first.response).mockImplementation(async () => new Response(null));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 1 });
  const response = await scheduler.fetch('https://example.test/first');
  const prefetch = scheduler.fetch('https://example.test/prefetch', { priority: 'low' } as RequestInit);
  const foreground = scheduler.fetch('https://example.test/foreground');
  await response.body!.cancel();
  await Promise.all([prefetch, foreground]);
  expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
    'https://example.test/first', 'https://example.test/foreground', 'https://example.test/prefetch'
  ]);
  scheduler.dispose();
});

it('prioritizes visible raster work over queued raster prefetch while numeric bodies occupy slots', async () => {
  const numeric = Array.from({ length: 6 }, streamResponse);
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async input => String(input).includes('/numeric/')
    ? numeric[index++].response
    : new Response(Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]), { headers: { 'content-type': 'image/webp' } }));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 6 });
  const protocol = createSourceRasterTileProtocol('https://example.test', { fetchImpl: scheduler.fetch });
  const active = await Promise.all(numeric.map((_, i) => scheduler.fetch(`https://example.test/numeric/${i}`)));
  const tile = (x: number) => `https://example.test/tiles/gfs/build/layer/f003/7/${x}/50.webp`;
  const prefetch = protocol.prefetch(tile(1));
  const visible = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  expect(scheduler.stats()).toEqual({ active: 6, queued: 2 });
  await active[0].body!.cancel();
  await visible;
  await Promise.all(active.slice(1).map(response => response.body!.cancel()));
  await prefetch;
  expect(fetchImpl.mock.calls.slice(6).map(call => call[0])).toEqual([tile(2), tile(1)]);
  protocol.dispose();
  scheduler.dispose();
});

it('releases slots after fetch and body failures', async () => {
  const broken = streamResponse();
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce(broken.response).mockResolvedValueOnce(new Response('ok'));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 1 });
  await expect(scheduler.fetch('https://example.test/error')).rejects.toThrow('network');
  const response = await scheduler.fetch('https://example.test/broken');
  const pending = scheduler.fetch('https://example.test/ok');
  const reading = response.text();
  broken.stream.error(new Error('broken body'));
  await expect(reading).rejects.toThrow('broken body');
  expect(await (await pending).text()).toBe('ok');
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
});

it('retains an aborted fetch slot until its late response releases the body', async () => {
  const late = streamResponse();
  let complete!: (response: Response) => void;
  let underlying!: AbortSignal;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => {
    underlying = init!.signal!;
    return new Promise(resolve => { complete = resolve; });
  }).mockResolvedValueOnce(new Response(null));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 1 });
  const controller = new AbortController();
  const first = scheduler.fetch(new Request('https://example.test/first', { signal: controller.signal }));
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const next = scheduler.fetch('https://example.test/next');
  controller.abort();
  await rejected;
  expect(underlying.aborted).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(scheduler.stats()).toEqual({ active: 1, queued: 1 });
  complete(late.response);
  await next;
  await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledOnce());
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
});

it.each(['abort', 'cancel'] as const)('retains a streaming slot until asynchronous %s completes', async action => {
  let release!: () => void;
  const cancel = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response(null));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 1 });
  const controller = new AbortController();
  const first = await scheduler.fetch('https://example.test/first', { signal: controller.signal });
  const next = scheduler.fetch('https://example.test/next');
  let cancelled: Promise<unknown>;
  if (action === 'abort') {
    cancelled = expect(first.text()).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
  } else cancelled = first.body!.cancel();
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(scheduler.stats()).toEqual({ active: 1, queued: 1 });
  release();
  await cancelled;
  await next;
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
});

it('evicts a queued speculative request to admit foreground work when the queue is full', async () => {
  const first = streamResponse(), fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(first.response).mockImplementation(async () => new Response('ok'));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 1, maxQueued: 2 });
  const response = await scheduler.fetch('https://example.test/active');
  const p1 = scheduler.fetch('https://example.test/prefetch-1', { priority: 'low' } as RequestInit);
  const p2 = scheduler.fetch('https://example.test/prefetch-2', { priority: 'low' } as RequestInit);
  const p1Rejected = expect(p1).rejects.toMatchObject({ name: 'AbortError' });
  await expect(scheduler.fetch('https://example.test/prefetch-3', { priority: 'low' } as RequestInit)).rejects.toThrow('queue is full');
  const foreground = scheduler.fetch('https://example.test/foreground');
  await p1Rejected;
  expect(scheduler.stats()).toEqual({ active: 1, queued: 2 });
  await response.body!.cancel();
  expect(await (await foreground).text()).toBe('ok');
  expect(await (await p2).text()).toBe('ok');
  expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
    'https://example.test/active', 'https://example.test/foreground', 'https://example.test/prefetch-2'
  ]);
  scheduler.dispose();
});

it('opens eight raster requests inside 4 MiB before their bodies finish', async () => {
  const streams = Array.from({ length: 8 }, () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-length': '12', 'content-encoding': 'identity' } });
    return { response, stream };
  });
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => streams[index++]!.response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024 });
  const requests = streams.map((_, i) => scheduler.fetch(`https://example.test/${i}`));
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(8));
  expect(scheduler.stats().queued).toBe(0);
  const bodies = (await Promise.all(requests)).map(response => response.arrayBuffer());
  streams.forEach(item => { item.stream.enqueue(new Uint8Array([1])); item.stream.close(); });
  await Promise.all(bodies);
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
});

it('holds further raster requests once declared bodies reach 4 MiB', async () => {
  const streams = Array.from({ length: 6 }, () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-length': String(1024 * 1024) } });
    return { response, stream };
  });
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => streams[index++]!.response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024 });
  const requests = streams.map((_, i) => scheduler.fetch(`https://example.test/${i}`));
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(scheduler.stats()).toEqual({ active: 4, queued: 2 });
  streams.slice(0, 4).forEach(item => item.stream.close());
  await Promise.all(requests.slice(0, 4).map(async request => (await request).arrayBuffer()));
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(6));
  streams.slice(4).forEach(item => item.stream.close());
  await Promise.all(requests.slice(4).map(async request => (await request).arrayBuffer()));
  scheduler.dispose();
});

it('retains the slot until an aborted raster body settles', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel }), { headers: { 'content-length': '12' } }));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024 });
  const response = await scheduler.fetch('https://example.test/tile');
  expect(scheduler.stats()).toEqual({ active: 1, queued: 0 });
  const rejected = expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
  scheduler.dispose();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream).toBeDefined();
});

it.each([{ maxActive: 0 }, { maxActive: 33 }, { maxActive: 1.5 }, { maxQueued: -1 }, { maxQueued: 65 }, { maxInFlightBytes: 32 * 1024 * 1024 + 1 }])('rejects invalid limits: %j', options => {
  expect(() => createForecastRequestScheduler(options)).toThrow('Invalid forecast request limits');
});

it('bounds the queue when byte pressure stops dispatch below the concurrency limit', async () => {
  const streams = Array.from({ length: 80 }, () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-length': String(1024 * 1024) } });
    return { response, stream };
  });
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => streams[index++]!.response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 8, maxQueued: 64, maxInFlightBytes: 4 * 1024 * 1024 });
  const requests = streams.map((_, i) => scheduler.fetch(`https://example.test/${i}`).catch(() => undefined));
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  await Promise.resolve();
  expect(scheduler.stats()).toEqual({ active: 4, queued: 64 });
  scheduler.dispose();
  await Promise.all(requests);
});

it('still dispatches an immediately admissible request with zero queue capacity', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(4)));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxQueued: 0, maxInFlightBytes: 4 * 1024 * 1024 });
  const response = await scheduler.fetch('https://example.test/now');
  expect(response).toBeInstanceOf(Response);
  await response.arrayBuffer();
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
});

it('keeps eight live bodies while headers arrive immediately', async () => {
  const streams = Array.from({ length: 10 }, () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-length': '12', 'content-encoding': 'identity' } });
    return { response, stream };
  });
  let index = 0;
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => streams[index++]!.response), maxActive: 8 });
  const requests = streams.map((_, i) => scheduler.fetch(`https://example.test/${i}`).catch(() => null));
  await vi.waitFor(() => expect(scheduler.detail().live).toBe(8));
  expect(scheduler.stats()).toEqual({ active: 8, queued: 2 });
  const first = (await requests[0])!;
  awaits: {
    const reader = first.body!.getReader();
    streams[0].stream.enqueue(new Uint8Array([1]));
    streams[0].stream.close();
    await reader.read();
    await reader.read();
    break awaits;
  }
  await vi.waitFor(() => expect(scheduler.detail().live).toBe(8));
  expect(scheduler.stats()).toEqual({ active: 8, queued: 1 });
  for (const stream of streams) { try { stream.stream.close(); } catch { /* already closed */ } }
  scheduler.dispose();
});

it('keeps speculative count and byte headroom while a full background queue admits the selected frame', async () => {
  const streams = Array.from({ length: 70 }, () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
    return { response, stream };
  });
  let index = 0;
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => streams[index++]!.response), maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024, maxQueued: 64 });
  const background = Array.from({ length: 68 }, (_, i) => scheduler.request({ url: `https://example.test/bg/${i}`, priority: 'background', kind: 'raster', maxResponseBytes: 1024 * 1024, initialReserveBytes: 1024 * 1024 }).response.catch(() => null));
  await vi.waitFor(() => expect(scheduler.detail().backgroundActive).toBe(2));
  expect(scheduler.detail().backgroundBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(scheduler.stats()).toEqual({ active: 2, queued: 64 });
  const selected = scheduler.request({ url: 'https://example.test/selected', priority: 'foreground', kind: 'raster', maxResponseBytes: 1024 * 1024, initialReserveBytes: 1024 * 1024 });
  await vi.waitFor(() => expect(scheduler.stats().active).toBe(3));
  expect(scheduler.detail().live).toBeLessThanOrEqual(8);
  expect(scheduler.stats().active).toBe(3);
  scheduler.dispose();
  await Promise.all(background);
  await selected.settled;
  expect(scheduler.detail().bodyBytes).toBe(0);
});


it('reserves unknown, malformed and compressed lengths at the header watermark', async () => {
  const responses = [
    new Response(new ReadableStream<Uint8Array>({ start() {} })),
    new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-length': '12x' } }),
    new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-length': '10', 'content-encoding': 'gzip' } }),
    new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-length': '12', 'content-encoding': 'identity' } })
  ];
  let index = 0;
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => responses[index++]!), maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024 });
  const requests = [0, 1, 2, 3].map(i => scheduler.fetch(`https://example.test/${i}`));
  await vi.waitFor(() => expect(scheduler.detail().active).toBe(4));
  expect(scheduler.detail().bodyBytes).toBe(3 * 1024 * 1024 + 12);
  scheduler.dispose();
  await Promise.allSettled(requests);
});

it('rejects an oversized task and starts smaller runnable work past a non-fitting head', async () => {
  let resolveFirst!: (response: Response) => void;
  const fetchImpl = vi.fn<typeof fetch>((input) => String(input).includes('/large-1')
    ? new Promise<Response>(resolve => { resolveFirst = resolve; })
    : Promise.resolve(new Response(new Uint8Array(4))));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024 });
  expect(() => scheduler.request({ url: 'https://example.test/too-big', priority: 'foreground', kind: 'wind', maxResponseBytes: 5 * 1024 * 1024, exactResponseBytes: 5 * 1024 * 1024 })).toThrow('exceeds its class bound');
  expect(() => scheduler.request({ url: 'https://example.test/big-bg', priority: 'background', kind: 'wind', maxResponseBytes: 3 * 1024 * 1024, exactResponseBytes: 3 * 1024 * 1024 })).toThrow('exceeds its class bound');
  const large = scheduler.request({ url: 'https://example.test/large-1', priority: 'foreground', kind: 'raster', maxResponseBytes: 4 * 1024 * 1024, exactResponseBytes: 3 * 1024 * 1024 });
  const blocked = scheduler.request({ url: 'https://example.test/large-2', priority: 'foreground', kind: 'json', maxResponseBytes: 4 * 1024 * 1024, exactResponseBytes: 3 * 1024 * 1024 });
  const small = scheduler.request({ url: 'https://example.test/small', priority: 'foreground', kind: 'json', maxResponseBytes: 4 * 1024 * 1024, exactResponseBytes: 1024 * 1024 });
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(['https://example.test/large-1', 'https://example.test/small']);
  resolveFirst(new Response(new Uint8Array(4)));
  await large.response;
  await small.response;
  scheduler.dispose();
  await Promise.allSettled([large.response, blocked.response, small.response, large.settled, blocked.settled, small.settled]);
});

it('retains admission through a late response body cancellation', async () => {
  let release!: () => void;
  const cancel = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  let complete!: (response: Response) => void;
  const scheduler = createForecastRequestScheduler({ maxActive: 1, fetchImpl: vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })) });
  const handle = scheduler.request({ url: 'https://example.test/late', priority: 'foreground', kind: 'raster', maxResponseBytes: 4 * 1024 * 1024 });
  handle.cancel(new DOMException('gone', 'AbortError'));
  await expect(handle.response).rejects.toMatchObject({ name: 'AbortError' });
  let settled = false;
  void handle.settled.then(() => { settled = true; });
  expect(scheduler.stats()).toEqual({ active: 1, queued: 0 });
  complete(new Response(new ReadableStream<Uint8Array>({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(scheduler.detail().bodyBytes).toBe(16 * 1024);
  release();
  await handle.settled;
  expect(settled).toBe(true);
  expect(scheduler.detail().bodyBytes).toBe(0);
  scheduler.dispose();
});

it('releases a streaming body once across repeated cancellation', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel: async () => {} }));
  const scheduler = createForecastRequestScheduler({ maxActive: 1, fetchImpl: vi.fn(async () => response) });
  const handle = scheduler.request({ url: 'https://example.test/body', priority: 'foreground', kind: 'wind', maxResponseBytes: 4 * 1024 * 1024 });
  const fetched = await handle.response;
  stream.enqueue(new Uint8Array([1]));
  const reader = fetched.body!.getReader();
  await reader.read();
  handle.cancel();
  handle.cancel();
  await handle.settled;
  expect(scheduler.detail()).toMatchObject({ active: 0, queued: 0, bodyBytes: 0, backgroundBytes: 0 });
  scheduler.dispose();
});

it('promotes queued speculative work without a duplicate fetch', async () => {
  let finishFirst!: () => void;
  let index = 0;
  const fetchImpl = vi.fn((_input: RequestInfo | URL) => {
    index++;
    if (index === 1) return new Promise<Response>(resolve => { finishFirst = () => resolve(new Response(null)); });
    return Promise.resolve(new Response(null));
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetchImpl as typeof fetch, maxActive: 1 });
  const first = scheduler.fetch('https://example.test/foreground');
  const background = scheduler.request({ url: 'https://example.test/promoted', priority: 'background', kind: 'raster', maxResponseBytes: 2 * 1024 * 1024 });
  expect(scheduler.stats()).toEqual({ active: 1, queued: 1 });
  background.promote();
  background.promote();
  finishFirst();
  await first;
  await background.response;
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
  await background.settled;
});


it('keeps a hidden encoding reservation conservative instead of trusting the wire length', async () => {
  const responses = [
    new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-length': '12' } }),
    new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-length': '12', 'content-encoding': 'br' } })
  ];
  let index = 0;
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => responses[index++]!), maxActive: 4, maxInFlightBytes: 4 * 1024 * 1024 });
  const requests = [0, 1].map(i => scheduler.fetch(`https://example.test/${i}`).catch(() => null));
  await vi.waitFor(() => expect(scheduler.detail().active).toBe(2));
  expect(scheduler.detail().bodyBytes).toBe(2 * 1024 * 1024);
  scheduler.dispose();
  await Promise.all(requests);
});

it('makes promotion after settlement a no-op and never releases background ownership twice', async () => {
  let finish!: () => void;
  const scheduler = createForecastRequestScheduler({
    maxActive: 4, maxBackgroundActive: 1, maxInFlightBytes: 4 * 1024 * 1024,
    fetchImpl: vi.fn(() => new Promise<Response>(resolve => { finish = () => resolve(new Response(null)); }))
  });
  const background = scheduler.request({ url: 'https://example.test/bg', priority: 'background', kind: 'raster', maxResponseBytes: 1024 });
  expect(scheduler.detail()).toMatchObject({ backgroundActive: 1, backgroundBytes: 1024 });
  finish();
  await background.response;
  await background.settled;
  expect(scheduler.detail()).toMatchObject({ backgroundActive: 0, backgroundBytes: 0, active: 0 });
  background.promote();
  background.promote();
  expect(scheduler.detail()).toMatchObject({ backgroundActive: 0, backgroundBytes: 0, active: 0 });
  scheduler.dispose();
});

it('dispatches a small explicit request under a tiny byte ceiling', async () => {
  const fetchImpl = vi.fn(async () => new Response(null));
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetchImpl as typeof fetch, maxActive: 4, maxInFlightBytes: 64 * 1024, maxBackgroundBytes: 64 * 1024 });
  const handle = scheduler.request({ url: 'https://example.test/small', priority: 'foreground', kind: 'json', maxResponseBytes: 1024 });
  expect(await handle.response).toBeInstanceOf(Response);
  await handle.settled;
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(scheduler.detail().bodyBytes).toBe(0);
  scheduler.dispose();
});

it('reserves only the initial admission watermark before headers arrive', async () => {
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(() => new Promise<Response>(() => {})), maxActive: 4, maxInFlightBytes: 4 * 1024 * 1024 });
  const handle = scheduler.request({ url: 'https://example.test/unknown', priority: 'foreground', kind: 'raster', maxResponseBytes: 3 * 1024 * 1024 });
  await vi.waitFor(() => expect(scheduler.detail().bodyBytes).toBe(16 * 1024));
  scheduler.dispose();
  await handle.response.catch(() => {});
});

it('rejects a body that exceeds its exact admitted size', async () => {
  const chunk = new Uint8Array(600);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); } });
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => new Response(stream)), maxActive: 4, maxInFlightBytes: 4 * 1024 * 1024 });
  const handle = scheduler.request({ url: 'https://example.test/exact', priority: 'foreground', kind: 'wind', maxResponseBytes: 4096, exactResponseBytes: 1024 });
  const response = await handle.response;
  await expect(response.arrayBuffer()).rejects.toThrow('exceeds its admitted size');
  await handle.settled;
  expect(scheduler.detail()).toMatchObject({ active: 0, bodyBytes: 0 });
  scheduler.dispose();
});

it('admits a small background request under a tiny scheduler with reserved foreground headroom', async () => {
  const fetchImpl = vi.fn(async () => new Response(null));
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetchImpl as typeof fetch, maxActive: 4, maxInFlightBytes: 64 * 1024, maxBackgroundBytes: 32 * 1024, maxBackgroundActive: 2 });
  const handle = scheduler.request({ url: 'https://example.test/bg-small', priority: 'background', kind: 'raster', maxResponseBytes: 1024 });
  expect(await handle.response).toBeInstanceOf(Response);
  await handle.settled;
  expect(fetchImpl).toHaveBeenCalledOnce();
  scheduler.dispose();
});

const MiB = 1024 * 1024;

it.each([16, 24, 32])('admits all %i configured foreground slots and bounds the queue', async limit => {
  const streams = Array.from({ length: limit }, streamResponse);
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => streams[index++].response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: limit, maxInFlightBytes: 32 * MiB, maxQueued: 1 });
  const handles = Array.from({ length: limit + 2 }, (_, i) => scheduler.request({ url: `https://example.test/${i}`, priority: 'foreground', kind: 'json', maxResponseBytes: 1024 }));
  const outcomes = Promise.allSettled(handles.map(handle => handle.response));
  try {
    expect(fetchImpl).toHaveBeenCalledTimes(limit);
    expect(scheduler.stats()).toEqual({ active: limit, queued: 1 });
    await expect(handles[limit + 1].response).rejects.toThrow('queue is full');
  } finally {
    scheduler.dispose();
    await outcomes;
    await Promise.all(handles.map(handle => handle.settled));
  }
});

it('defaults to twenty background bodies and reserves four starts and four MiB', async () => {
  const streams = Array.from({ length: 24 }, streamResponse);
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => streams[index++].response);
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const background = Array.from({ length: 21 }, (_, i) => scheduler.request({ url: `https://example.test/bg/${i}`, priority: 'background', kind: 'raster', maxResponseBytes: MiB, initialReserveBytes: MiB }));
  const foreground: typeof background = [];
  const pending = () => Promise.allSettled([...background, ...foreground].map(handle => handle.response));
  background.forEach(handle => void handle.response.catch(() => {}));
  try {
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(scheduler.detail()).toMatchObject({ active: 20, queued: 1, backgroundActive: 20, backgroundBytes: 20 * MiB, bodyBytes: 20 * MiB });
    for (let i = 0; i < 4; i++) foreground.push(scheduler.request({ url: `https://example.test/fg/${i}`, priority: 'foreground', kind: 'wind', maxResponseBytes: MiB, exactResponseBytes: MiB }));
    foreground.forEach(handle => void handle.response.catch(() => {}));
    expect(fetchImpl).toHaveBeenCalledTimes(24);
    expect(scheduler.detail()).toMatchObject({ active: 24, queued: 1, bodyBytes: 24 * MiB });
  } finally {
    scheduler.dispose();
    await pending();
    await Promise.all([...background, ...foreground].map(handle => handle.settled));
  }
});

it.each(['queued', 'active', 'body'] as const)('promotes the same %s handle and promise without a duplicate transfer', async phase => {
  const stream = streamResponse();
  let releaseHeaders!: (response: Response) => void;
  const fetchImpl = vi.fn<typeof fetch>((input, init) => String(input).endsWith('/hold')
    ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
    : new Promise(resolve => { releaseHeaders = resolve; }));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 2, maxBackgroundActive: 1, maxInFlightBytes: 4 * MiB, maxBackgroundBytes: 2 * MiB });
  const hold = phase === 'queued' ? scheduler.request({ url: 'https://example.test/hold', priority: 'background', kind: 'wind', maxResponseBytes: MiB }) : undefined;
  const handle = scheduler.request({ url: 'https://example.test/target', priority: 'background', kind: 'wind', maxResponseBytes: MiB });
  void handle.response.catch(() => {}); void hold?.response.catch(() => {});
  const original = handle.response;
  try {
    if (phase === 'body') { releaseHeaders(stream.response); await handle.response; }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    handle.promote(); handle.promote();
    expect(handle.response).toBe(original);
    expect(fetchImpl).toHaveBeenCalledTimes(phase === 'queued' ? 2 : 1);
    expect(scheduler.detail().backgroundActive).toBe(phase === 'queued' ? 1 : 0);
    if (phase !== 'body') releaseHeaders(stream.response);
    const response = await original;
    const reading = response.arrayBuffer();
    stream.stream.enqueue(new Uint8Array([1, 2])); stream.stream.close();
    expect(Array.from(new Uint8Array(await reading))).toEqual([1, 2]);
    await handle.settled;
  } finally {
    scheduler.dispose();
    await Promise.allSettled([handle.response, ...(hold ? [hold.response] : [])]);
    await Promise.all([handle.settled, ...(hold ? [hold.settled] : [])]);
  }
});

it.each(['complete', 'cancel', 'failure'] as const)('pauses new background admission until selected %s releases its epoch', async outcome => {
  const streams = [streamResponse(), streamResponse(), streamResponse()];
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => streams[index++].response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 4, maxBackgroundActive: 2, maxInFlightBytes: 4 * MiB, maxBackgroundBytes: 2 * MiB });
  const gate = scheduler as typeof scheduler & { setForegroundPending(epoch: number, pending: boolean): void };
  const first = scheduler.request({ url: 'https://example.test/first', priority: 'background', kind: 'wind', maxResponseBytes: 1024 });
  let next: typeof first | undefined, selected: typeof first | undefined;
  void first.response.catch(() => {});
  try {
    const response = await first.response;
    gate.setForegroundPending(2, true);
    gate.setForegroundPending(1, false);
    selected = scheduler.request({ url: 'https://example.test/selected', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 });
    const selectedResponse = await selected.response;
    const completion = selectedResponse.arrayBuffer().catch(() => undefined).finally(() => gate.setForegroundPending(2, false));
    next = scheduler.request({ url: 'https://example.test/next', priority: 'background', kind: 'wind', maxResponseBytes: 1024 });
    void next.response.catch(() => {});
    const reading = response.arrayBuffer();
    streams[0].stream.close(); await reading; await first.settled;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(scheduler.stats()).toEqual({ active: 1, queued: 1 });
    if (outcome === 'complete') streams[1].stream.close();
    else if (outcome === 'failure') streams[1].stream.error(new Error('broken selected body'));
    else selected.cancel();
    await completion;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const second = await next.response;
    const body = second.arrayBuffer(); streams[2].stream.close(); await body;
    await next.settled;
  } finally {
    scheduler.dispose();
    await Promise.allSettled([first.response, ...(next ? [next.response] : []), ...(selected ? [selected.response] : [])]);
    await Promise.all([first.settled, ...(next ? [next.settled] : []), ...(selected ? [selected.settled] : [])]);
  }
});

it('releases queued and active reservations after cancellation', async () => {
  const firstStream = streamResponse();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(firstStream.response).mockResolvedValueOnce(new Response(null));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 2, maxBackgroundActive: 1, maxInFlightBytes: 4 * MiB, maxBackgroundBytes: MiB });
  const active = scheduler.request({ url: 'https://example.test/active', priority: 'background', kind: 'wind', maxResponseBytes: MiB, exactResponseBytes: MiB });
  const queued = scheduler.request({ url: 'https://example.test/queued', priority: 'background', kind: 'wind', maxResponseBytes: MiB, exactResponseBytes: MiB });
  const queuedRejection = expect(queued.response).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await active.response;
    queued.cancel(); await queuedRejection; await queued.settled;
    expect(scheduler.detail()).toMatchObject({ active: 1, queued: 0, bodyBytes: MiB, backgroundBytes: MiB });
    active.cancel(); await active.settled;
    expect(scheduler.detail()).toMatchObject({ active: 0, queued: 0, bodyBytes: 0, backgroundBytes: 0, backgroundActive: 0 });
    const replacement = scheduler.request({ url: 'https://example.test/replacement', priority: 'background', kind: 'wind', maxResponseBytes: MiB });
    await replacement.response; await replacement.settled;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally { scheduler.dispose(); }
});

it.each(['declared', 'streamed'] as const)('accepts the exact response bound and rejects one byte beyond it (%s)', async mode => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input => {
    const bytes = String(input).endsWith('/over') ? 1025 : 1024;
    return new Response(new Uint8Array(bytes), mode === 'declared' ? { headers: { 'content-length': String(bytes), 'content-encoding': 'identity' } } : undefined);
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxInFlightBytes: 4 * MiB });
  try {
    const exact = scheduler.request({ url: 'https://example.test/exact', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 });
    expect((await (await exact.response).arrayBuffer()).byteLength).toBe(1024);
    await exact.settled;
    const over = scheduler.request({ url: 'https://example.test/over', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 });
    await expect(over.response.then(response => response.arrayBuffer())).rejects.toThrow('exceeds its admitted size');
    await over.settled;
    expect(scheduler.detail()).toMatchObject({ active: 0, bodyBytes: 0 });
  } finally { scheduler.dispose(); }
});

it('passes explicit request security options to fetch', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null));
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const controller = new AbortController();
  const spec = { url: 'https://example.test/tile', priority: 'foreground' as const, kind: 'raster' as const, maxResponseBytes: 1024, init: { signal: controller.signal, redirect: 'error' as const, headers: { accept: 'image/webp' }, credentials: 'omit' as const } };
  try {
    const handle = scheduler.request(spec);
    await handle.response; await handle.settled;
    const init = fetchImpl.mock.calls[0][1]!;
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('accept')).toBe('image/webp');
    expect(init.signal).toBeDefined();
  } finally { scheduler.dispose(); }
});

it('propagates the caller signal from an explicit request to its physical transfer', async () => {
  const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })));
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const controller = new AbortController();
  const spec = { url: 'https://example.test/tile', priority: 'foreground' as const, kind: 'raster' as const, maxResponseBytes: 1024, init: { signal: controller.signal } };
  const handle = scheduler.request(spec);
  const result = handle.response.then(() => 'resolved', () => 'rejected');
  try {
    controller.abort();
    expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(await result).toBe('rejected');
    await handle.settled;
  } finally { scheduler.dispose(); await result; await handle.settled; }
});

it('waits for shared budget pressure and holds response bytes until body settlement', async () => {
  const budget = createPreparationBudget(2048), blocker = budget.reserve('other', 2048)!;
  const stream = streamResponse(), fetchImpl = vi.fn<typeof fetch>(async () => stream.response);
  const scheduler = createForecastRequestScheduler({ fetchImpl, budget, maxActive: 2, maxInFlightBytes: 4 * MiB });
  const handle = scheduler.request({ url: 'https://example.test/budget', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 });
  try {
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(scheduler.stats()).toEqual({ active: 0, queued: 1 });
    blocker.release();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const response = await handle.response;
    expect(budget.snapshot()).toEqual({ response: 1024 });
    const reading = response.arrayBuffer();
    stream.stream.enqueue(new Uint8Array(10)); stream.stream.close();
    await reading; await handle.settled;
    expect(budget.used).toBe(0);
  } finally { blocker.release(); scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('releases the shared response reservation after asynchronous body cancellation', async () => {
  const budget = createPreparationBudget(2048);
  let release!: () => void;
  const cancel = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }))) });
  const handle = scheduler.request({ url: 'https://example.test/cancel', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 });
  try {
    await handle.response; handle.cancel();
    expect(budget.used).toBe(1024);
    release(); await handle.settled;
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); }
});

it('rejects requests that can never fit the shared preparation budget', async () => {
  const budget = createPreparationBudget(512), fetchImpl = vi.fn<typeof fetch>();
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl });
  try {
    await expect(scheduler.fetch('https://example.test/unbounded')).rejects.toThrow('exceeds preparation budget');
    expect(() => scheduler.request({ url: 'https://example.test/bounded', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 })).toThrow('exceeds preparation budget');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  } finally { scheduler.dispose(); }
});

it('grows an identity reservation to the streamed body bytes', async () => {
  const budget = createPreparationBudget(4096), stream = streamResponse();
  stream.response.headers.set('content-length', '10');
  stream.response.headers.set('content-encoding', 'identity');
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => stream.response) });
  const handle = scheduler.request({ url: 'https://example.test/body', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 });
  try {
    const response = await handle.response;
    expect(budget.used).toBe(10);
    const reading = response.arrayBuffer();
    stream.stream.enqueue(new Uint8Array(512)); stream.stream.close();
    expect((await reading).byteLength).toBe(512);
    await handle.settled;
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); }
});

it('grows a legacy fetch reservation to the consumed body bytes and releases it', async () => {
  const budget = createPreparationBudget(2 * MiB), stream = streamResponse();
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => stream.response) });
  try {
    const response = await scheduler.fetch('https://example.test/body');
    const reader = response.body!.getReader();
    stream.stream.enqueue(new Uint8Array(MiB + 128));
    expect((await reader.read()).value!.byteLength).toBe(MiB + 128);
    expect(budget.used).toBe(MiB + 128);
    stream.stream.close(); await reader.read();
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); }
});

it('admits a precharged response when destination claims fill the shared budget', async () => {
  const budget = createPreparationBudget(2048), destination = budget.reserve('wind-numeric', 1024)!, lease = budget.reserve('response', 1024)!;
  const stream = streamResponse(), fetchImpl = vi.fn<typeof fetch>(async () => stream.response);
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl });
  const handle = scheduler.request({ url: 'https://example.test/precharged', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024, responseLease: { budget, lease } });
  try {
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(budget.used).toBe(2048);
    const response = await handle.response, reading = response.arrayBuffer();
    stream.stream.enqueue(new Uint8Array(10)); stream.stream.close(); await reading; await handle.settled;
    expect(budget.snapshot()).toEqual({ 'wind-numeric': 1024 });
    expect(lease.bytes).toBe(0);
  } finally { scheduler.dispose(); destination.release(); }
});

it('releases a transferred queued lease on cancellation without touching other claims', async () => {
  const budget = createPreparationBudget(4096), stream = streamResponse();
  const scheduler = createForecastRequestScheduler({ budget, maxActive: 1, fetchImpl: vi.fn(async () => stream.response) });
  const first = scheduler.request({ url: 'https://example.test/first', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 });
  const lease = budget.reserve('response', 1024)!;
  const queued = scheduler.request({ url: 'https://example.test/queued', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024, responseLease: { budget, lease } });
  const rejection = expect(queued.response).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await first.response;
    expect(budget.used).toBe(2048);
    queued.cancel(); await rejection; await queued.settled;
    expect(lease.bytes).toBe(0); expect(budget.used).toBe(1024);
    first.cancel(); await first.settled;
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); }
});

it('rejects mismatched or duplicate response lease transfers without taking ownership', async () => {
  const budget = createPreparationBudget(4096), other = createPreparationBudget(4096), lease = budget.reserve('response', 1024)!;
  const stream = streamResponse(), scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => stream.response) });
  const spec = { url: 'https://example.test/precharged', priority: 'foreground' as const, kind: 'wind' as const, maxResponseBytes: 1024 };
  try {
    expect(() => scheduler.request({ ...spec, responseLease: { budget: other, lease } })).toThrow('Invalid forecast response lease');
    expect(() => scheduler.request({ ...spec, maxResponseBytes: 2048, responseLease: { budget, lease } })).toThrow('Invalid forecast response lease');
    expect(lease.bytes).toBe(1024);
    const first = scheduler.request({ ...spec, responseLease: { budget, lease } });
    expect(() => scheduler.request({ ...spec, responseLease: { budget, lease } })).toThrow('Invalid forecast response lease');
    await first.response; first.cancel(); await first.settled;
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); lease.release(); }
});

it('releases transferred reservations when admission rejects or the signal is already aborted', async () => {
  const budget = createPreparationBudget(4096), stream = streamResponse();
  const scheduler = createForecastRequestScheduler({ budget, maxActive: 1, maxQueued: 0, fetchImpl: vi.fn(async () => stream.response) });
  const first = scheduler.request({ url: 'https://example.test/first', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 });
  try {
    await first.response;
    const rejectedLease = budget.reserve('response', 1024)!;
    const rejected = scheduler.request({ url: 'https://example.test/full', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024, responseLease: { budget, lease: rejectedLease } });
    await expect(rejected.response).rejects.toThrow('queue is full'); await rejected.settled;
    expect(rejectedLease.bytes).toBe(0);
    const controller = new AbortController(); controller.abort();
    const abortedLease = budget.reserve('response', 1024)!;
    const aborted = scheduler.request({ url: 'https://example.test/aborted', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024, init: { signal: controller.signal }, responseLease: { budget, lease: abortedLease } });
    await expect(aborted.response).rejects.toMatchObject({ name: 'AbortError' }); await aborted.settled;
    expect(abortedLease.bytes).toBe(0);
    expect(budget.used).toBe(1024);
    first.cancel(); await first.settled;
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); }
});

it('reports whether a physical handle has started across queuing and cancellation', async () => {
  const stream = streamResponse();
  const scheduler = createForecastRequestScheduler({ maxActive: 1, fetchImpl: vi.fn(async () => stream.response) });
  const active = scheduler.request({ url: 'https://example.test/active', kind: 'wind', priority: 'foreground', maxResponseBytes: 1024 });
  const queued = scheduler.request({ url: 'https://example.test/queued', kind: 'wind', priority: 'foreground', maxResponseBytes: 1024 });
  const rejection = expect(queued.response).rejects.toMatchObject({ name: 'AbortError' });
  try {
    expect(active.started).toBe(true);
    expect(queued.started).toBe(false);
    queued.cancel(); await rejection; await queued.settled;
    expect(queued.started).toBe(false);
    await active.response; active.cancel(); await active.settled;
    expect(active.started).toBe(true);
  } finally { scheduler.dispose(); }
});

it('rejects forged and cross-scheduler reuse without consuming the real lease', async () => {
  const budget = createPreparationBudget(4096), other = createPreparationBudget(4096);
  const stream = streamResponse();
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => stream.response) });
  const second = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => new Response(null)) });
  const foreign = other.reserve('response', 1024)!, lease = budget.reserve('response', 1024)!;
  const spec = { url: 'https://example.test/precharge', kind: 'wind' as const, priority: 'foreground' as const, maxResponseBytes: 1024 };
  try {
    expect(() => scheduler.request({ ...spec, responseLease: { budget, lease: foreign } })).toThrow('Invalid forecast response lease');
    expect(() => scheduler.request({ ...spec, responseLease: { budget, lease: { bytes: 1024, resize: () => true, release() {} } } })).toThrow('Invalid forecast response lease');
    expect(foreign.bytes).toBe(1024);
    const handle = scheduler.request({ ...spec, responseLease: { budget, lease } });
    expect(lease.bytes).toBe(0);
    expect(lease.resize(512)).toBe(false); lease.release();
    expect(() => second.request({ ...spec, responseLease: { budget, lease } })).toThrow('Invalid forecast response lease');
    expect(budget.used).toBe(1024);
    await handle.response; handle.cancel(); await handle.settled;
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); second.dispose(); foreign.release(); lease.release(); }
});

it('preserves foreground processing capacity when a precharged background request is gated', async () => {
  const MiB = 1024 * 1024, budget = createPreparationBudget(12 * MiB, { foregroundReserveBytes: 8 * MiB });
  const numeric = budget.reserve('wind-numeric', 3 * MiB, 'background')!;
  const precharge = budget.reserve('response', MiB, 'background')!;
  const streams = [streamResponse(), streamResponse()]; let index = 0;
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => streams[index++].response) });
  scheduler.setForegroundPending(1, true);
  const background = scheduler.request({ url: 'https://example.test/bg', kind: 'wind', priority: 'background', maxResponseBytes: MiB, responseLease: { budget, lease: precharge } });
  const foreground = scheduler.request({ url: 'https://example.test/fg', kind: 'raster', priority: 'foreground', maxResponseBytes: MiB });
  const outcomes = Promise.allSettled([background.response, foreground.response]);
  try {
    expect(scheduler.stats()).toEqual({ active: 1, queued: 1 });
    const processing = budget.reserve('raster-compressed', 4 * MiB, 'foreground');
    expect(processing).not.toBeNull();
    expect(budget.reserve('other', 1, 'background')).toBeNull();
    const response = await foreground.response, reading = response.arrayBuffer(); streams[0].stream.close(); await reading; await foreground.settled;
    processing!.release(); scheduler.setForegroundPending(1, false);
    const next = await background.response, nextBody = next.arrayBuffer(); streams[1].stream.close(); await nextBody; await background.settled;
  } finally { scheduler.dispose(); numeric.release(); await outcomes; }
  expect(budget.used).toBe(0);
});

it('grows an unknown-length admission as streamed bytes pass the initial reserve', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { stream = value; } }), { headers: { 'content-type': 'image/webp' } });
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => response), maxInFlightBytes: 4 * MiB });
  const handle = scheduler.request({ url: 'https://example.test/tile', priority: 'foreground', kind: 'raster', maxResponseBytes: MiB });
  try {
    const body = (await handle.response).body!.getReader();
    expect(scheduler.detail().bodyBytes).toBe(16 * 1024);
    stream.enqueue(new Uint8Array(20 * 1024));
    expect((await body.read()).value!.byteLength).toBe(20 * 1024);
    expect(scheduler.detail().bodyBytes).toBe(20 * 1024);
    stream.close();
    expect((await body.read()).done).toBe(true);
    await handle.settled;
    expect(scheduler.detail()).toMatchObject({ active: 0, bodyBytes: 0 });
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('delivers error responses whose length differs from the exact payload size', async () => {
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => new Response('missing', { status: 404, headers: { 'content-length': '7', 'content-type': 'text/plain' } })), maxInFlightBytes: 4 * MiB });
  const handle = scheduler.request({ url: 'https://example.test/missing', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024, exactResponseBytes: 1024 });
  try {
    const response = await handle.response;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('missing');
    await handle.settled;
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('rejects an exact response that ends short', async () => {
  const stream = streamResponse(), scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => stream.response), maxInFlightBytes: 4 * MiB });
  const handle = scheduler.request({ url: 'https://example.test/short', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024, exactResponseBytes: 1024 });
  try {
    const reading = (await handle.response).arrayBuffer();
    stream.stream.enqueue(new Uint8Array(512)); stream.stream.close();
    await expect(reading).rejects.toThrow('does not match its exact size');
    await handle.settled;
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('cancels the physical body when a declared length exceeds remaining capacity', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
  const budget = createPreparationBudget(2048), scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => new Response(body, { headers: { 'content-length': '4096', 'content-encoding': 'identity', 'content-type': 'image/webp' } })) });
  const handle = scheduler.request({ url: 'https://example.test/large', priority: 'foreground', kind: 'raster', maxResponseBytes: 4096, initialReserveBytes: 1024 });
  try {
    await expect(handle.response).rejects.toThrow('budget');
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('promotes a streaming reservation so selected growth uses foreground capacity', async () => {
  const stream = streamResponse(), budget = createPreparationBudget(4096, { foregroundReserveBytes: 2048 });
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => stream.response) });
  const handle = scheduler.request({ url: 'https://example.test/promote', priority: 'background', kind: 'raster', maxResponseBytes: 4096, initialReserveBytes: 2048 });
  try {
    const reader = (await handle.response).body!.getReader();
    stream.stream.enqueue(new Uint8Array(2048));
    expect((await reader.read()).value!.byteLength).toBe(2048);
    handle.promote();
    stream.stream.enqueue(new Uint8Array(1024));
    expect((await reader.read()).value!.byteLength).toBe(1024);
    expect(budget.used).toBe(3072);
    stream.stream.close();
    expect((await reader.read()).done).toBe(true);
    await handle.settled;
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('rejects a bodyless successful response that promised an exact size', async () => {
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => new Response(null, { status: 204 })), maxInFlightBytes: 4 * MiB });
  const handle = scheduler.request({ url: 'https://example.test/empty', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024, exactResponseBytes: 1024 });
  try {
    await expect(handle.response).rejects.toThrow('does not match its exact size');
    await handle.settled;
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('delivers an oversized error status with an empty body', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start() {}, cancel });
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => new Response(body, { status: 404, headers: { 'content-length': '4096', 'content-encoding': 'identity' } })), maxInFlightBytes: 4 * MiB });
  const handle = scheduler.request({ url: 'https://example.test/error', priority: 'foreground', kind: 'wind', maxResponseBytes: 1024, exactResponseBytes: 1024 });
  try {
    const response = await handle.response;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    await handle.settled;
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('delivers an error status when its identity body exceeds remaining capacity', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start() {}, cancel });
  const budget = createPreparationBudget(2048), scheduler = createForecastRequestScheduler({ budget, fetchImpl: vi.fn(async () => new Response(body, { status: 404, headers: { 'content-length': '4096', 'content-encoding': 'identity' } })) });
  const handle = scheduler.request({ url: 'https://example.test/error', priority: 'foreground', kind: 'wind', maxResponseBytes: 8192, exactResponseBytes: 1024 });
  try {
    const response = await handle.response;
    expect(response.status).toBe(404);
    await response.body?.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    await handle.settled;
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});

it('accepts an exact-size response whose encoded length differs', async () => {
  const data = new Uint8Array(1024);
  const scheduler = createForecastRequestScheduler({ fetchImpl: vi.fn(async () => new Response(data, { headers: { 'content-encoding': 'gzip', 'content-length': '300' } })), maxInFlightBytes: 4 * MiB });
  const handle = scheduler.request({ url: 'https://example.test/compressed', priority: 'foreground', kind: 'wind', maxResponseBytes: 2048, exactResponseBytes: 1024 });
  try {
    expect((await (await handle.response).arrayBuffer()).byteLength).toBe(1024);
    await handle.settled;
  } finally { scheduler.dispose(); await Promise.allSettled([handle.response, handle.settled]); }
});
