import { afterEach, expect, it, vi } from 'vitest';
import { createRasterTileProtocol, createSourceRasterTileProtocol } from './client-raster';
import { createForecastRequestScheduler } from './client-request-scheduler';
import { createPreparationBudget } from './client-preparation-budget';
const base = 'https://api.test';
const tile = (x = 0) => `${base}/tiles/gfs/build/usable-lift-msl/f003/7/${x}/50.webp`;
const webp = () => new Response(Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } });
const disposals: Array<() => void> = [];
function setup(options: Parameters<typeof createRasterTileProtocol>[1]) { const protocol = createRasterTileProtocol(base, options); disposals.push(protocol.dispose); return protocol; }
function setupSources(options: Parameters<typeof createSourceRasterTileProtocol>[1]) { const protocol = createSourceRasterTileProtocol(base, options); disposals.push(protocol.dispose); return protocol; }
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
function heldFetch() {
  const finish: Array<(response: Response) => void> = [];
  const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((resolve, reject) => {
    const abort = () => reject(init!.signal!.reason);
    init!.signal!.addEventListener('abort', abort, { once: true });
    finish.push(response => { init!.signal!.removeEventListener('abort', abort); resolve(response); });
  }));
  return { fetchImpl, finish };
}
it('admits two active requests, drains queued tiles, and preserves cache metadata', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 2 });
  const pending = Array.from({ length: 5 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  for (let i = 0; i < pending.length; i++) {
    finish[i](webp());
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBe(Math.min(i + 3, 5)));
  }
  for (const result of await Promise.all(pending)) {
    expect(result.cacheControl).toBe('public, max-age=100');
  }
});
it('honors custom active and queued limits and drains the admitted queue', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 3, maxQueued: 1 });
  const pending = Array.from({ length: 4 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  await expect(protocol.load({ url: protocol.url(tile(4)) }, new AbortController())).rejects.toThrow('queue is full');
  for (let i = 0; i < pending.length; i++) {
    finish[i](webp());
    await pending[i];
  }
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});
it.each([{ maxActive: 0 }, { maxActive: 33 }, { maxActive: 1.5 }, { maxActive: NaN }, { maxQueued: 0 }, { maxQueued: 513 }, { maxQueued: 1.5 }, { maxQueued: Infinity }])('rejects invalid raster admission limits: %j', options => {
  expect(() => createRasterTileProtocol(base, options)).toThrow('Invalid raster request');
});
it('bounds admission and disposes both queued and active requests without starting queued work', async () => {
  const { fetchImpl } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 2 });
  const promises = Array.from({ length: 67 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  const outcomes = Promise.allSettled(promises);
  await expect(promises[66]).rejects.toThrow('queue is full');
  protocol.dispose();
  const settled = await outcomes;
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(settled.every(item => item.status === 'rejected')).toBe(true);
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
});
it('removes a cancelled queued request before it can consume a network slot', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 2 });
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const pending = controllers.map((c, i) => protocol.load({ url: protocol.url(tile(i)) }, c));
  const cancelled = expect(pending[2]).rejects.toMatchObject({ name: 'AbortError' });
  controllers[2].abort(); await cancelled;
  finish[0](webp()); finish[1](webp()); await Promise.all(pending.slice(0, 2));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('retries transient failures finitely and never substitutes an empty successful tile', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(webp());
  const protocol = setup({ fetchImpl, retryDelayMs: 0 });
  expect((await protocol.load({ url: protocol.url(tile()) }, new AbortController())).data.byteLength).toBe(12);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  protocol.evictBuild();
  fetchImpl.mockReset().mockImplementation(async () => new Response('busy', { status: 503 }));
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow('HTTP 503');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  fetchImpl.mockReset().mockResolvedValue(new Response('missing', { status: 404 }));
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow('HTTP 404');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('enforces the total deadline during body consumption and cancels the stalled stream', async () => {
  vi.useFakeTimers(); const cancel = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'image/webp' } }));
  const protocol = setup({ fetchImpl, timeoutMs: 10 });
  const pending = expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(11); await pending; expect(cancel).toHaveBeenCalled();
});
it('caches a 200 after the caller leaves and still aborts before headers', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1 });
  const early = new AbortController();
  const rejected = expect(protocol.load({ url: protocol.url(tile()) }, early)).rejects.toMatchObject({ name: 'AbortError' });
  early.abort(); await rejected;
  expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  fetchImpl.mockImplementationOnce(async () => new Response(new ReadableStream({ start(value) { controller = value; } }), { status: 200, headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } }));
  const late = new AbortController();
  const left = expect(protocol.load({ url: protocol.url(tile(1)) }, late)).rejects.toMatchObject({ name: 'AbortError' });
  finish[0]?.(webp());
  await vi.waitFor(() => expect(controller).toBeTypeOf('object'));
  late.abort(); await left;
  controller.enqueue(Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]));
  controller.close();
  await vi.waitFor(() => expect(protocol.stats().cachedTiles).toBe(1));
  await protocol.load({ url: protocol.url(tile(1)) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('cancels retry backoff on disposal and does not make another request', async () => {
  vi.useFakeTimers(); const fetchImpl = vi.fn<typeof fetch>(async () => new Response('busy', { status: 503 }));
  const protocol = setup({ fetchImpl });
  const pending = expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1); protocol.dispose(); await pending;
  await vi.advanceTimersByTimeAsync(1000); expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each(['https://other.test/tiles/gfs/build/layer/f003/0/0/0.webp', 'https://api.test/v1/catalog', `${tile()}?bypass=1`, `${tile()}#fragment`, 'https://user@api.test/tiles/gfs/build/layer/f003/0/0/0.webp'])('rejects an untrusted or non-tile URL before fetching: %s', url => {
  const fetchImpl = vi.fn<typeof fetch>(), protocol = setup({ fetchImpl });
  expect(() => protocol.url(url)).toThrow(); expect(fetchImpl).not.toHaveBeenCalled();
});
it('rejects oversized and corrupt bodies without retries', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'image/webp' } }));
  const protocol = setup({ fetchImpl });
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow('byte budget');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  fetchImpl.mockResolvedValue(new Response('not an image', { headers: { 'content-type': 'image/webp' } }));
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow('Invalid WebP');
});
it('returns independent cached buffers and expires entries at the pinned build deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const fetchImpl = vi.fn<typeof fetch>(async () => webp()), protocol = setup({ fetchImpl });
  protocol.setBuildExpiry('build', 10_100);
  const first = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  new Uint8Array(first.data)[0] = 0;
  const second = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  expect(new Uint8Array(second.data)[0]).toBe(82);
  expect(second.data).not.toBe(first.data);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(protocol.stats()).toMatchObject({ cacheHits: 1, cachedBytes: 12, cachedTiles: 1 });
  await vi.advanceTimersByTimeAsync(101);
  expect(protocol.stats().cachedBytes).toBe(0);
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([true, false])('preserves cached bytes after the map transfers a delivered tile buffer (length header=%s)', async lengthHeader => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const response = webp();
    if (lengthHeader) response.headers.set('content-length', '12');
    return response;
  }), protocol = setup({ fetchImpl });
  const first = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const transferred = structuredClone(first.data, { transfer: [first.data] });
  expect(first.data.byteLength).toBe(0);
  expect(transferred.byteLength).toBe(12);
  const cached = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  expect(new Uint8Array(cached.data)).toEqual(new Uint8Array(transferred));
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it('coalesces prefetch and interactive consumers while cancelling them independently', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
  const background = new AbortController();
  const prefetch = protocol.prefetch(tile(), background.signal);
  const prefetchAborted = expect(prefetch).rejects.toMatchObject({ name: 'AbortError' });
  const interactive = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  background.abort(); await prefetchAborted;
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(false);
  finish[0](webp());
  expect((await interactive).data.byteLength).toBe(12);
  expect(protocol.stats().coalesced).toBe(1);
});
it('dispatches newer interactive work ahead of prefetch and older interactive work', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1 });
  const first = protocol.load({ url: protocol.url(tile(0)) }, new AbortController());
  const background = protocol.prefetch(tile(1));
  const old = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  const newest = protocol.load({ url: protocol.url(tile(3)) }, new AbortController());
  finish[0](webp()); await first;
  expect(fetchImpl.mock.calls[1][0]).toBe(tile(3));
  finish[1](webp()); await newest;
  expect(fetchImpl.mock.calls[2][0]).toBe(tile(2));
  finish[2](webp()); await old;
  expect(fetchImpl.mock.calls[3][0]).toBe(tile(1));
  finish[3](webp()); await background;
});
it('promotes an already queued prefetch when an interactive consumer joins', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1 });
  const first = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const background = protocol.prefetch(tile(1));
  const older = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  const promoted = protocol.load({ url: protocol.url(tile(1)) }, new AbortController());
  finish[0](webp()); await first;
  expect(fetchImpl.mock.calls[1][0]).toBe(tile(1));
  finish[1](webp()); await Promise.all([background, promoted]);
  finish[2](webp()); await older;
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
it('evicts the least-recently-used tile within payload and metadata memory', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => webp()), protocol = setup({ fetchImpl, maxCacheBytes: 1100 });
  const load = (x: number) => protocol.load({ url: protocol.url(tile(x)) }, new AbortController());
  await load(0); await load(1); await load(0); await load(2);
  expect(protocol.stats()).toMatchObject({ cachedBytes: 24, cachedTiles: 2, cacheHits: 1 });
  await load(1);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  protocol.evictBuild('build');
  expect(protocol.stats()).toMatchObject({ cachedBytes: 0, cachedTiles: 0 });
});
it('accounts response Age and disables caching for no-store responses', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const response = webp(); response.headers.set('age', '99'); return response;
  }), protocol = setup({ fetchImpl });
  await protocol.prefetch(tile());
  expect(protocol.stats().cachedTiles).toBe(1);
  await vi.advanceTimersByTimeAsync(1001);
  expect(protocol.stats().cachedTiles).toBe(0);
  fetchImpl.mockImplementation(async () => { const response = webp(); response.headers.set('cache-control', 'no-store'); return response; });
  await protocol.prefetch(tile());
  expect(protocol.stats().cachedTiles).toBe(0);
});
it('supports twelve admitted requests and limits simultaneous prefetches', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 12, maxPrefetchActive: 2 });
  const background = Array.from({ length: 3 }, (_, i) => protocol.prefetch(tile(i)));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const foreground = Array.from({ length: 10 }, (_, i) => protocol.load({ url: protocol.url(tile(i + 3)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(12);
  for (const done of finish.slice()) done(webp());
  await Promise.all(foreground);
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(13));
  finish[12](webp()); await Promise.all(background);
});
it('admits interactive work by dropping queued background work when the queue is full', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1, maxQueued: 1 });
  const active = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const background = expect(protocol.prefetch(tile(1))).rejects.toMatchObject({ name: 'AbortError' });
  const foreground = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  await background;
  finish[0](webp()); await active;
  expect(fetchImpl.mock.calls[1][0]).toBe(tile(2));
  finish[1](webp()); await foreground;
});
it('expires active and queued work at the build deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const { fetchImpl } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1 });
  protocol.setBuildExpiry('build', 10_010);
  const requests = [0, 1].map(x => protocol.load({ url: protocol.url(tile(x)) }, new AbortController()));
  const outcomes = Promise.allSettled(requests);
  await vi.advanceTimersByTimeAsync(11);
  expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('aborts an initial consumer independently and returns distinct coalesced buffers', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
  const initial = new AbortController();
  const cancelled = expect(protocol.load({ url: protocol.url(tile()) }, initial)).rejects.toMatchObject({ name: 'AbortError' });
  const next = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const last = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  initial.abort(); await cancelled;
  expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(false);
  finish[0](webp());
  const [a, b] = await Promise.all([next, last]);
  expect(a.data).not.toBe(b.data);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('reserves interactive slots under a configured prefetch cap', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxPrefetchActive: 2 });
  const background = Array.from({ length: 4 }, (_, index) => protocol.prefetch(tile(index)));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const foreground = protocol.load({ url: protocol.url(tile(4)) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  for (const done of finish.splice(0)) done(webp());
  await foreground;
  expect(fetchImpl).toHaveBeenCalledTimes(5);
  for (const done of finish.splice(0)) done(webp());
  await Promise.all(background);
});

it('drops expired cache entries before a newer tile can evict a live one', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const fetchImpl = vi.fn<typeof fetch>(async url => {
    const response = webp();
    if (String(url).endsWith('/1/50.webp')) response.headers.set('cache-control', 'public, max-age=1');
    return response;
  }), protocol = setup({ fetchImpl, maxCacheBytes: 1100 });
  const load = (x: number) => protocol.load({ url: protocol.url(tile(x)) }, new AbortController());
  await load(0); await load(1);
  await vi.advanceTimersByTimeAsync(1500);
  await load(2); await load(0);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it('defaults to twenty-four interactive fetches and queues further tiles', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
  const requests = Array.from({ length: 25 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  const outcomes = Promise.allSettled(requests);
  try {
    expect(fetchImpl).toHaveBeenCalledTimes(24);
    for (const done of finish.slice()) done(webp());
    await Promise.all(requests.slice(0, 24));
    expect(fetchImpl).toHaveBeenCalledTimes(25);
    finish[24](webp()); await requests[24];
  } finally { protocol.dispose(); await outcomes; }
});

it('charges long tile URLs and headers against cache admission for small blank tiles', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => webp()), protocol = setup({ fetchImpl, maxCacheBytes: 1024 });
  const longUrl = `${base}/tiles/gfs/${'b'.repeat(128)}/${'l'.repeat(128)}/${'f'.repeat(128)}/0/0/0.webp`;
  const load = () => protocol.load({ url: protocol.url(longUrl) }, new AbortController());
  await load(); await load();
  expect(protocol.stats()).toMatchObject({ cachedBytes: 0, cachedTiles: 0 });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  fetchImpl.mockImplementation(async () => { const response = webp(); response.headers.set('cache-control', `public, max-age=100, extension=${'h'.repeat(1024)}`); return response; });
  await protocol.prefetch(tile());
  expect(protocol.stats().cachedTiles).toBe(0);
});

it('preserves the queued prefetch being promoted when the subscriber budget is full', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1, maxQueued: 2 });
  const active = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const target = protocol.prefetch(tile(1)).then(() => true, () => false);
  const unrelated = expect(protocol.prefetch(tile(2))).rejects.toMatchObject({ name: 'AbortError' });
  const promoted = protocol.load({ url: protocol.url(tile(1)) }, new AbortController());
  await unrelated;
  finish[0](webp()); await active;
  expect(fetchImpl.mock.calls[1][0]).toBe(tile(1));
  finish[1](webp()); await promoted;
  expect(await target).toBe(true);
  expect(protocol.stats().coalesced).toBe(1);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('bounds queued prefetches even when the prefetch lane cannot dispatch', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 2, maxQueued: 1, maxPrefetchActive: 0 });
  const background = protocol.prefetch(tile());
  await expect(protocol.prefetch(tile(1))).rejects.toThrow('queue is full');
  expect(fetchImpl).not.toHaveBeenCalled();
  const promoted = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  finish[0](webp()); await Promise.all([background, promoted]);
});


it('keeps prepared map sources in the background lane and promotes them without refetching', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setupSources({ fetchImpl, maxActive: 4, maxPrefetchActive: 2 });
  const source = protocol.createSource(false);
  const prepared = Array.from({ length: 4 }, (_, i) => protocol.load({ url: source.url(tile(i)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const interactive = protocol.load({ url: protocol.url(tile(4)) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  source.setInteractive(true);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  for (const done of finish.slice()) done(webp());
  await interactive;
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
  finish[4](webp()); await Promise.all(prepared);
  expect(new Set(fetchImpl.mock.calls.map(([url]) => url)).size).toBe(5);
});

it('delivers owned buffers for background map loads and preserves the byte cache after transfer', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => webp()), protocol = setupSources({ fetchImpl });
  const source = protocol.createSource(false), load = () => protocol.load({ url: source.url(tile()) }, new AbortController());
  const first = await load();
  structuredClone(first.data, { transfer: [first.data] });
  expect(first.data.byteLength).toBe(0);
  const cached = await load();
  expect(cached.data.byteLength).toBe(12);
  structuredClone(cached.data, { transfer: [cached.data] });
  expect((await protocol.load({ url: protocol.url(tile()) }, new AbortController())).data.byteLength).toBe(12);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('disposes a source without cancelling shared tiles or starting its queued work', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setupSources({ fetchImpl, maxActive: 1 });
  const source = protocol.createSource(false), target = protocol.createSource(true);
  const abandoned = [0, 1, 2].map(x => protocol.load({ url: source.url(tile(x)) }, new AbortController()));
  const outcomes = Promise.allSettled(abandoned), staleUrl = source.url(tile(3));
  const visible = protocol.load({ url: target.url(tile(0)) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledOnce();
  source.dispose();
  expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
  expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(false);
  finish[0](webp()); await visible;
  expect(fetchImpl).toHaveBeenCalledOnce();
  await expect(protocol.load({ url: staleUrl }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => source.url(tile())).toThrow();
  source.dispose();
});

it('limits retained source handles and releases them for the next selection', async () => {
  const protocol = setupSources({ fetchImpl: vi.fn<typeof fetch>(async () => webp()) });
  const first = protocol.createSource(true), second = protocol.createSource(false);
  expect(() => protocol.createSource(false)).toThrow('source limit');
  first.dispose();
  const next = protocol.createSource(false), url = next.url(tile());
  second.dispose(); protocol.dispose();
  await expect(protocol.load({ url }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => protocol.createSource(false)).toThrow();
});

it('bounds the expanded source window while preserving background admission', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setupSources({ fetchImpl, maxSources: 4, maxPrefetchActive: 2 });
  const sources = Array.from({ length: 4 }, (_, index) => protocol.createSource(index === 0));
  expect(() => protocol.createSource(false)).toThrow('source limit');
  const pending = sources.map((source, index) => protocol.load({ url: source.url(tile(index)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  finish[0](webp()); await pending[0];
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  finish[1](webp()); await pending[1];
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  finish[2](webp()); finish[3](webp()); await Promise.all(pending);
  sources[1].dispose();
  expect(() => protocol.createSource(false)).not.toThrow();
  expect(() => protocol.createSource(false)).toThrow('source limit');
});

it.each([1, 5, 2.5, Infinity])('rejects an unsupported source window: %s', maxSources => {
  expect(() => createSourceRasterTileProtocol(base, { maxSources })).toThrow('Invalid raster source limit');
});

it('demotes queued source work while allowing the current admitted read to settle', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setupSources({ fetchImpl, maxActive: 1, maxPrefetchActive: 0 });
  const source = protocol.createSource(true);
  const active = protocol.load({ url: source.url(tile()) }, new AbortController());
  const queued = protocol.load({ url: source.url(tile(1)) }, new AbortController());
  source.setInteractive(false);
  finish[0](webp()); await active;
  expect(fetchImpl).toHaveBeenCalledOnce();
  source.setInteractive(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  finish[1](webp()); await queued;
});


it('promotes the physical request when a queued source becomes interactive', async () => {
  let tileFetches = 0;
  const pending: Array<{ url: string; resolve: (response: Response) => void }> = [];
  const scheduler = createForecastRequestScheduler({
    maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024, maxBackgroundActive: 6, maxBackgroundBytes: 32 * 1024,
    fetchImpl: vi.fn((input: RequestInfo | URL) => new Promise<Response>(resolve => {
      const url = String(input);
      if (url.includes('/tiles/')) tileFetches++;
      pending.push({ url, resolve });
    })) as typeof fetch
  });
  const first = scheduler.request({ url: 'https://api.test/wind/1', priority: 'background', kind: 'wind', maxResponseBytes: 1024 * 1024 });
  const second = scheduler.request({ url: 'https://api.test/wind/2', priority: 'background', kind: 'wind', maxResponseBytes: 1024 * 1024 });
  first.response.catch(() => {}); second.response.catch(() => {});
  await vi.waitFor(() => expect(scheduler.detail().backgroundActive).toBe(2));
  const protocol = setupSources({ request: spec => scheduler.request(spec), maxActive: 2, maxSources: 2 });
  const source = protocol.createSource(false);
  const load = protocol.load({ url: source.url(tile(0)) }, new AbortController());
  await vi.waitFor(() => expect(scheduler.stats().queued).toBe(1));
  expect(tileFetches).toBe(0);
  source.setInteractive(true);
  await vi.waitFor(() => expect(tileFetches).toBe(1));
  pending.find(entry => entry.url.includes('/tiles/'))!.resolve(webp());
  await expect(load).resolves.toMatchObject({ data: expect.any(ArrayBuffer) });
  first.cancel(); second.cancel();
  for (const entry of pending) if (!entry.url.includes('/tiles/')) entry.resolve(new Response(null));
  await Promise.allSettled([first.settled, second.settled]);
  scheduler.dispose();
});

it.each([16, 24, 32])('supports %i raster requests without a hidden per-source cap', async limit => {
  const { fetchImpl, finish } = heldFetch();
  const protocol = setupSources({ fetchImpl, maxActive: limit, maxPrefetchActive: limit - 4 });
  const source = protocol.createSource(false);
  const pending = Array.from({ length: limit - 4 }, (_, i) => protocol.load({ url: source.url(tile(i)) }, new AbortController()));
  const outcomes = Promise.allSettled(pending);
  try {
    expect(fetchImpl).toHaveBeenCalledTimes(limit - 4);
    finish.forEach(done => done(webp()));
    expect((await outcomes).every(result => result.status === 'fulfilled')).toBe(true);
  } finally { protocol.dispose(); await outcomes; }
});

it('defaults to twenty background requests from one source', async () => {
  const { fetchImpl, finish } = heldFetch();
  const protocol = setupSources({ fetchImpl });
  const source = protocol.createSource(false);
  const pending = Array.from({ length: 20 }, (_, i) => protocol.load({ url: source.url(tile(i)) }, new AbortController()));
  const outcomes = Promise.allSettled(pending);
  try {
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    finish.forEach(done => done(webp()));
    expect((await outcomes).every(result => result.status === 'fulfilled')).toBe(true);
  } finally { protocol.dispose(); await outcomes; }
});

it.each(['queued', 'active', 'body'] as const)('immediately promotes the shared physical raster handle when an interactive consumer joins at %s', async phase => {
  let resolveTile!: (response: Response) => void;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl = vi.fn<typeof fetch>((input, init) => String(input).includes('/hold')
    ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
    : new Promise((resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      resolveTile = resolve;
    }));
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: phase === 'queued' ? 1 : 2, maxInFlightBytes: 4 * 1024 * 1024, maxBackgroundBytes: 2 * 1024 * 1024 });
  const hold = phase === 'queued' ? scheduler.request({ url: `${base}/hold`, priority: 'foreground', kind: 'wind', maxResponseBytes: 1024 }) : undefined;
  void hold?.response.catch(() => {});
  const handles: ReturnType<typeof scheduler.request>[] = [];
  const promote = vi.fn();
  const protocol = setupSources({ maxActive: 2, request: spec => {
    const handle = scheduler.request(spec);
    handles.push(handle);
    const original = handle.promote;
    handle.promote = () => { promote(); original(); };
    return handle;
  } });
  const source = protocol.createSource(false);
  const prepared = protocol.load({ url: source.url(tile()) }, new AbortController());
  void prepared.catch(() => {});
  let selected: Promise<unknown> | undefined;
  try {
    expect(handles).toHaveLength(1);
    const promise = handles[0].response;
    if (phase === 'body') {
      resolveTile(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } }));
      await promise;
    }
    selected = protocol.load({ url: protocol.url(tile()) }, new AbortController());
    void selected.catch(() => {});
    expect(promote).toHaveBeenCalledOnce();
    expect(handles).toHaveLength(1);
    expect(handles[0].response).toBe(promise);
    if (hold) { hold.cancel(); await hold.settled; }
    if (phase !== 'body') resolveTile(webp());
    else { body.enqueue(Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])); body.close(); }
    const [background, foreground] = await Promise.all([prepared, selected]);
    expect(background).toMatchObject({ data: expect.any(ArrayBuffer) });
    expect(foreground).toMatchObject({ data: expect.any(ArrayBuffer) });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/tiles/'))).toHaveLength(1);
  } finally {
    protocol.dispose(); scheduler.dispose();
    await Promise.allSettled([prepared, ...(selected ? [selected] : []), ...(hold ? [hold.response] : [])]);
    await Promise.all(handles.map(handle => handle.settled));
  }
});

it('keeps a complete scheduler-backed tile after its only consumer leaves during the body', async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } }));
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const protocol = setupSources({ request: spec => scheduler.request(spec) });
  const source = protocol.createSource(false), controller = new AbortController();
  const pending = protocol.load({ url: source.url(tile()) }, controller);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await vi.waitFor(() => expect(body).toBeDefined());
    await Promise.resolve();
    controller.abort(); await rejected;
    body.enqueue(Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])); body.close();
    await vi.waitFor(() => expect(protocol.stats().cachedTiles).toBe(1));
    const result = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
    expect(new Uint8Array(result.data)[0]).toBe(82);
    expect(fetchImpl).toHaveBeenCalledOnce();
  } finally { protocol.dispose(); scheduler.dispose(); }
});

it('preserves raster redirect policy and Accept on the scheduler-backed request', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => webp());
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const protocol = setupSources({ request: spec => scheduler.request(spec) });
  try {
    await protocol.load({ url: protocol.url(tile()) }, new AbortController());
    const init = fetchImpl.mock.calls[0][1]!;
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('accept')).toBe('image/webp');
  } finally { protocol.dispose(); scheduler.dispose(); }
});

it('rejects a redirected scheduler-backed raster request', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.redirect === 'error') return new Response(null, { status: 302, headers: { location: 'https://other.test/tile.webp' } });
    return webp();
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const protocol = setupSources({ request: spec => scheduler.request(spec), retryDelayMs: 0 });
  try {
    await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  } finally { protocol.dispose(); scheduler.dispose(); }
});

it('retries a promoted raster as foreground while the selected gate is active', async () => {
  let resolveFirst!: (response: Response) => void;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; })).mockImplementationOnce(async () => webp());
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const protocol = setupSources({ request: spec => scheduler.request(spec), retryDelayMs: 0 });
  const handle = protocol.requestTile(tile(), { priority: 'background' });
  const outcome = Promise.allSettled([handle.response]);
  try {
    await vi.waitFor(() => expect(resolveFirst).toBeDefined());
    handle.promote(); scheduler.setForegroundPending(1, true);
    resolveFirst(new Response(null, { status: 503 }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const result = await handle.response;
    expect(result.data.byteLength).toBe(12); result.release();
  } finally { protocol.dispose(); scheduler.dispose(); await outcome; }
});

it('charges cached and delivered bytes separately and recovers after release', async () => {
  const budget = createPreparationBudget(24);
  const fetchImpl = vi.fn<typeof fetch>(async () => { const response = webp(); response.headers.set('content-length', '12'); return response; });
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const protocol = setupSources({ request: spec => scheduler.request(spec), budget });
  try {
    const first = await protocol.requestTile(tile(), { priority: 'background' }).response;
    expect(budget.snapshot()).toEqual({ 'raster-compressed': 12, 'raster-delivered': 12 });
    await expect(protocol.requestTile(tile()).response).rejects.toThrow('Raster delivery budget exhausted');
    expect(fetchImpl).toHaveBeenCalledOnce();
    first.release(); first.release();
    expect(budget.used).toBe(0);
    const second = await protocol.requestTile(tile()).response;
    expect(new Uint8Array(second.data)).toEqual(new Uint8Array(first.data));
    expect(budget.used).toBe(24);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    protocol.evictBuild();
    expect(budget.snapshot()).toEqual({ 'raster-delivered': 12 });
    second.release();
    expect(budget.used).toBe(0);
  } finally { protocol.dispose(); scheduler.dispose(); }
});

it('evicts unreferenced compressed cache entries when the shared budget fills', async () => {
  const budget = createPreparationBudget(36);
  const fetchImpl = vi.fn<typeof fetch>(async () => { const response = webp(); response.headers.set('content-length', '12'); return response; });
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const protocol = setupSources({ request: spec => scheduler.request(spec), budget });
  try {
    for (let i = 0; i < 3; i++) {
      const result = await protocol.requestTile(tile(i)).response;
      expect(budget.used).toBeLessThanOrEqual(36);
      result.release();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(protocol.stats().cachedTiles).toBe(2);
    protocol.evictBuild();
    expect(budget.used).toBe(0);
  } finally { protocol.dispose(); scheduler.dispose(); }
});

it('releases raster body reservation after invalid data and retries after budget pressure', async () => {
  const budget = createPreparationBudget(24), blocker = budget.reserve('other', 13)!;
  const fetchImpl = vi.fn<typeof fetch>(async () => { const response = webp(); response.headers.set('content-length', '12'); return response; });
  const scheduler = createForecastRequestScheduler({ fetchImpl });
  const protocol = setupSources({ request: spec => scheduler.request(spec), budget });
  try {
    await expect(protocol.requestTile(tile()).response).rejects.toThrow('budget exhausted');
    expect(budget.snapshot()).toEqual({ other: 13 });
    blocker.release();
    fetchImpl.mockImplementationOnce(async () => new Response(new Uint8Array(12), { headers: { 'content-type': 'image/webp', 'content-length': '12' } }));
    await expect(protocol.requestTile(tile()).response).rejects.toThrow('Invalid WebP');
    expect(budget.used).toBe(0);
    const result = await protocol.requestTile(tile()).response;
    result.release(); protocol.evictBuild();
    expect(budget.used).toBe(0);
  } finally { blocker.release(); protocol.dispose(); scheduler.dispose(); }
});

it('promotes one per-tile handle and cancels one consumer without cancelling the shared transfer', async () => {
  const { fetchImpl, finish } = heldFetch();
  const scheduler = createForecastRequestScheduler({ fetchImpl, maxActive: 4 });
  const physical: ReturnType<typeof scheduler.request>[] = [];
  const protocol = setupSources({ request: spec => { const handle = scheduler.request(spec); physical.push(handle); return handle; } });
  const first = protocol.requestTile(tile(), { priority: 'background' });
  const second = protocol.requestTile(tile(), { priority: 'background' });
  const cancelled = expect(first.response).rejects.toMatchObject({ name: 'AbortError' });
  try {
    const original = physical[0].response;
    second.promote(); second.promote();
    expect(scheduler.detail().backgroundActive).toBe(0);
    expect(physical).toHaveLength(1);
    expect(physical[0].response).toBe(original);
    first.cancel(); await cancelled;
    expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(false);
    finish[0](webp());
    const result = await second.response;
    expect(result.data.byteLength).toBe(12);
    result.release();
    expect(fetchImpl).toHaveBeenCalledOnce();
  } finally { protocol.dispose(); scheduler.dispose(); await Promise.allSettled([first.response, second.response]); }
});

it('charges fallback response and compressed buffers until the response body settles', async () => {
  const budget = createPreparationBudget(2 * 1024 * 1024), { fetchImpl, finish } = heldFetch();
  const protocol = setupSources({ fetchImpl, budget });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const handle = protocol.requestTile(tile());
  try {
    expect(budget.snapshot()).toEqual({ response: 1024 * 1024 });
    finish[0](new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'image/webp', 'content-length': '12', 'cache-control': 'public, max-age=100' } }));
    await vi.waitFor(() => expect(budget.snapshot()).toEqual({ response: 1024 * 1024, 'raster-compressed': 12 }));
    stream.enqueue(Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])); stream.close();
    const result = await handle.response;
    expect(budget.snapshot()).toEqual({ 'raster-compressed': 12, 'raster-delivered': 12 });
    result.release(); protocol.evictBuild();
    expect(budget.used).toBe(0);
  } finally { protocol.dispose(); await Promise.allSettled([handle.response]); }
});

it('settles the scheduler and releases the reader and budget when raster allocation fails', async () => {
  const budget = createPreparationBudget(4 * 1024 * 1024);
  const failedResponse = webp(); failedResponse.headers.set('content-length', '12');
  const successfulResponse = webp(); successfulResponse.headers.set('content-length', '12');
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(failedResponse).mockResolvedValueOnce(successfulResponse);
  const scheduler = createForecastRequestScheduler({ fetchImpl, budget, maxActive: 1 });
  const protocol = setupSources({ request: spec => scheduler.request(spec), budget });
  const NativeUint8Array = globalThis.Uint8Array;
  let failed = false;
  const replacement = new Proxy(NativeUint8Array, { construct(target, args, newTarget) {
    if (!failed && args[0] === 12) { failed = true; throw new RangeError('allocation failed'); }
    return Reflect.construct(target, args, newTarget);
  } });
  vi.stubGlobal('Uint8Array', replacement);
  try {
    await expect(protocol.requestTile(tile()).response).rejects.toThrow('allocation failed');
    expect(failed).toBe(true);
    await vi.waitFor(() => expect(scheduler.stats()).toEqual({ active: 0, queued: 0 }));
    expect(failedResponse.body?.locked).toBe(false);
    expect(budget.used).toBe(0);
    const selected = await protocol.requestTile(tile(1)).response;
    selected.release(); protocol.evictBuild();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(budget.used).toBe(0);
  } finally { vi.unstubAllGlobals(); protocol.dispose(); scheduler.dispose(); }
});

function watchedBudget(limit: number) {
  const budget = createPreparationBudget(limit), peaks: number[] = [];
  const reserve = budget.reserve.bind(budget);
  budget.reserve = (category, bytes, priority) => { const lease = reserve(category, bytes, priority); peaks.push(budget.used); return lease; };
  return { budget, peaks };
}

const bigWebp = (bytes: number) => {
  const data = new Uint8Array(bytes);
  data.set([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
  return data;
};

it.each([true, false])('streams a valid 40 KiB tile when the declared length is %s', async declared => {
  const data = bigWebp(40 * 1024);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(data, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100', ...(declared ? { 'content-length': String(data.length) } : {}) } }));
  const protocol = setup({ fetchImpl });
  const result = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  expect(result.data.byteLength).toBe(data.length);
  expect(protocol.stats()).toMatchObject({ cachedBytes: data.length, cachedTiles: 1 });
});

it('reserves the next raster capacity while the previous buffer is still held', async () => {
  const { budget, peaks } = watchedBudget(4 * 1024 * 1024);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(value) { stream = value; } }), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } }));
  const protocol = setupSources({ fetchImpl, budget });
  const handle = protocol.requestTile(tile());
  await vi.waitFor(() => expect(budget.snapshot()['raster-compressed']).toBe(16 * 1024));
  stream.enqueue(bigWebp(20 * 1024));
  await vi.waitFor(() => expect(budget.snapshot()['raster-compressed']).toBe(32 * 1024));
  stream.enqueue(bigWebp(20 * 1024));
  await vi.waitFor(() => expect(budget.snapshot()['raster-compressed']).toBe(64 * 1024));
  stream.close();
  const result = await handle.response;
  const deltas = peaks.map(value => value - 1024 * 1024);
  expect(deltas).toContain(48 * 1024);
  expect(deltas).toContain(96 * 1024);
  expect(deltas).toContain(104 * 1024);
  result.release(); protocol.evictBuild();
  expect(budget.used).toBe(0);
});

it('aborts a background stream that cannot reserve growth capacity', async () => {
  const budget = createPreparationBudget(40 * 1024), data = bigWebp(40 * 1024);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(data, { headers: { 'content-type': 'image/webp' } }));
  const scheduler = createForecastRequestScheduler({ fetchImpl, budget, maxActive: 4 });
  const protocol = setup({ request: spec => scheduler.request(spec), budget });
  try {
    await expect(protocol.prefetch(tile())).rejects.toThrow('budget exhausted');
    expect(budget.used).toBe(0);
  } finally { scheduler.dispose(); }
});

it('releases a partial raster reservation when the reader is cancelled mid-body', async () => {
  const budget = createPreparationBudget(4 * 1024 * 1024);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'content-type': 'image/webp' } }));
  const protocol = setupSources({ fetchImpl, budget });
  const handle = protocol.requestTile(tile());
  await vi.waitFor(() => expect(budget.snapshot()['raster-compressed']).toBe(16 * 1024));
  controller.enqueue(bigWebp(20 * 1024));
  await vi.waitFor(() => expect(budget.snapshot()['raster-compressed']).toBe(32 * 1024));
  protocol.dispose();
  await expect(handle.response).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(budget.used).toBe(0));
});

it('keeps reusable cached tiles when a small streamed tile fits the admission watermark', async () => {
  const data = bigWebp(200 * 1024), fetchImpl = vi.fn<typeof fetch>(async () => new Response(data, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } }));
  const budget = createPreparationBudget(1_700_000), scheduler = createForecastRequestScheduler({ fetchImpl, budget, maxActive: 4 });
  const protocol = setupSources({ request: spec => scheduler.request(spec), budget });
  try {
    for (let i = 0; i < 4; i++) await protocol.load({ url: protocol.url(tile(i)) }, new AbortController());
    expect(protocol.stats()).toMatchObject({ cachedTiles: 4, cachedBytes: 4 * 200 * 1024 });
    await protocol.load({ url: protocol.url(tile(9)) }, new AbortController());
    expect(protocol.stats().cachedTiles).toBe(5);
    await protocol.load({ url: protocol.url(tile(0)) }, new AbortController());
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  } finally { protocol.dispose(); scheduler.dispose(); }
});

it('keeps cached tiles when background admission cannot succeed after eviction', async () => {
  const data = bigWebp(200 * 1024), fetchImpl = vi.fn<typeof fetch>(async () => new Response(data, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } }));
  const budget = createPreparationBudget(128 * 1024 * 1024, { foregroundReserveBytes: 24 * 1024 * 1024 });
  const scheduler = createForecastRequestScheduler({ fetchImpl, budget, maxActive: 8 });
  const protocol = setupSources({ request: spec => scheduler.request(spec), budget });
  try {
    await protocol.load({ url: protocol.url(tile(0)) }, new AbortController());
    expect(protocol.stats().cachedTiles).toBe(1);
    const blocker = budget.reserve('other', 105 * 1024 * 1024)!, controller = new AbortController();
    const prefetch = protocol.prefetch(tile(9), controller.signal);
    await vi.waitFor(() => expect(scheduler.stats().queued).toBe(1));
    controller.abort();
    await expect(prefetch).rejects.toMatchObject({ name: 'AbortError' });
    expect(protocol.stats().cachedTiles).toBe(1);
    blocker.release();
  } finally { protocol.dispose(); scheduler.dispose(); }
});

it('evicts a reusable tile when that makes admission possible', async () => {
  const small = bigWebp(64 * 1024), tiny = bigWebp(12 * 1024);
  let calls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(++calls === 1 ? small : tiny, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } }));
  const budget = createPreparationBudget(512 * 1024), scheduler = createForecastRequestScheduler({ fetchImpl, budget, maxActive: 4 });
  const protocol = setupSources({ request: spec => scheduler.request(spec), budget });
  try {
    await protocol.load({ url: protocol.url(tile(0)) }, new AbortController());
    const blocker = budget.reserve('other', 440 * 1024)!;
    expect(budget.limit - budget.used).toBe(8 * 1024);
    const result = await protocol.requestTile(tile(1)).response;
    expect(result.data.byteLength).toBe(tiny.byteLength);
    result.release();
    expect(protocol.stats().cachedTiles).toBe(1);
    blocker.release();
  } finally { protocol.dispose(); scheduler.dispose(); }
});

it('reconsiders cache eviction for a queued request after capacity is released', async () => {
  const small = bigWebp(8 * 1024), tiny = bigWebp(12 * 1024);
  let calls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(++calls === 1 ? small : tiny, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } }));
  const budget = createPreparationBudget(512 * 1024), scheduler = createForecastRequestScheduler({ fetchImpl, budget, maxActive: 4 });
  const protocol = setupSources({ request: spec => scheduler.request(spec), budget });
  try {
    await protocol.load({ url: protocol.url(tile(0)) }, new AbortController());
    const blocker = budget.reserve('other', 500 * 1024)!;
    expect(budget.limit - budget.used).toBe(4 * 1024);
    const pending = protocol.requestTile(tile(1)).response;
    await vi.waitFor(() => expect(scheduler.stats().queued).toBe(1));
    blocker.resize(480 * 1024);
    const result = await pending;
    expect(result.data.byteLength).toBe(tiny.byteLength);
    result.release();
    expect(protocol.stats().cachedTiles).toBe(1);
    blocker.release();
  } finally { protocol.dispose(); scheduler.dispose(); }
});
