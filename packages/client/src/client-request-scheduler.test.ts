import { expect, it, vi } from 'vitest';
import { createForecastRequestScheduler, createSourceRasterTileProtocol } from './client-raster';

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
  const scheduler = createForecastRequestScheduler({ fetchImpl });
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
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const protocol = createSourceRasterTileProtocol('https://example.test', { fetchImpl: scheduler.fetch });
  const active = await Promise.all(numeric.map((_, i) => scheduler.fetch(`https://example.test/numeric/${i}`)));
  const tile = (x: number) => `https://example.test/tiles/gfs/build/layer/f003/7/${x}/50.webp`;
  const prefetch = protocol.prefetch(tile(1));
  const visible = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  expect(scheduler.stats()).toEqual({ active: 6, queued: 2 });
  await active[0].body!.cancel();
  await Promise.all([visible, prefetch]);
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
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-length': '12' } });
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
  expect(scheduler.stats()).toEqual({ active: 0, queued: 2 });
  streams.slice(0, 4).forEach(item => item.stream.close());
  await Promise.all(requests.slice(0, 4).map(async request => (await request).arrayBuffer()));
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(6));
  streams.slice(4).forEach(item => item.stream.close());
  await Promise.all(requests.slice(4).map(async request => (await request).arrayBuffer()));
  scheduler.dispose();
});

it('aborts a raster body after its concurrency slot is released', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel }), { headers: { 'content-length': '12' } }));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024 });
  const response = await scheduler.fetch('https://example.test/tile');
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  const rejected = expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
  scheduler.dispose();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream).toBeDefined();
});

it.each([{ maxActive: 0 }, { maxActive: 13 }, { maxActive: 1.5 }, { maxQueued: -1 }, { maxQueued: 65 }, { maxInFlightBytes: 4 * 1024 * 1024 + 1 }])('rejects invalid limits: %j', options => {
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
  expect(scheduler.stats()).toEqual({ active: 0, queued: 64 });
  scheduler.dispose();
  await Promise.all(requests);
});

it('still dispatches an immediately admissible request with zero queue capacity', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(4)));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxQueued: 0, maxInFlightBytes: 4 * 1024 * 1024 });
  await expect(scheduler.fetch('https://example.test/now')).resolves.toBeInstanceOf(Response);
  expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  scheduler.dispose();
});
