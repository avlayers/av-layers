import { afterEach, expect, it, vi } from 'vitest';
import { WIND_FINE_CELL_BYTES, WIND_FRAME_LIMIT, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_VALUES, windLayout, windOverviewLayout } from '@av/contracts/wind-data';
import { STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_VALID } from '@av/contracts/layers';
import { planSample } from '@av/forecast/sampler';
import { decodePackedWindChunk, encodeWindColumns, samplePackedWindColumns, windTargetHeight } from '@av/forecast/wind';
import { fixtureBuild } from '../../../tests/forecast-fixture.ts';
import { preparedBounds, WIND_NUMERIC_BYTES, WIND_WINDOW_BYTES, WIND_WINDOW_ENTRIES, WindCapacityError, WindDataCache, WindDataSource } from './client-wind.ts';
import type { ForecastRequestHandle, ForecastRequestSpec } from './client-request-scheduler.ts';
import { createPreparationBudget } from './client-preparation-budget.ts';
import { createForecastRequestScheduler } from './client-request-scheduler.ts';

const bounds = [-1, -1, 2, 2] as const;
function build() {
  const result = fixtureBuild();
  result.expiresAtMs = Date.now() + 60000;
  result.manifest.expiresAt = new Date(result.expiresAtMs).toISOString();
  result.manifest.recipe.id = 'gfs';
  result.manifest.descriptors.bounds = [...bounds];
  const grid = { kind: 'regular-latlon' as const, width: 2, height: 2, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
  for (const surface of result.manifest.surfaces) surface.grid = grid;
  return result;
}
const column = { surface: { u: 1, v: 2 }, levels: [{ height: 100, wind: { u: 2, v: 4 } }, { height: 1000, wind: { u: 4, v: 8 } }] };
const wind = encodeWindColumns(Array.from({ length: 256 }, (_, index) => index % 16 < 2 && Math.floor(index / 16) < 2 ? column : null));
const fine = new Uint8Array(64 * 64 * WIND_FINE_CELL_BYTES), view = new DataView(fine.buffer);
for (let i = 0; i < 64 * 64; i++) {
  const inside = i % 64 < 2 && Math.floor(i / 64) < 2;
  view.setFloat32(i * WIND_FINE_CELL_BYTES, inside ? 100 : 0, true); view.setFloat32(i * WIND_FINE_CELL_BYTES + 4, inside ? 550 : 0, true);
  view.setUint8(i * WIND_FINE_CELL_BYTES + 8, inside ? 16 : 15);
}
const descriptor = (frame: string) => JSON.stringify({ version: 3, frame, levels: 2, tileSize: 16, fineTileSize: 64,
  wind: [{ sha256: 'a'.repeat(64), bytes: wind.length, indexSha256: 'b'.repeat(64), count: 1 }],
  fine: [{ sha256: 'c'.repeat(64), bytes: fine.length, indexSha256: 'd'.repeat(64), count: 1 }] });
function layoutDescriptor(pinned: ReturnType<typeof build>, metadata: ReturnType<typeof JSON.parse>) {
  for (const [kind, size, levels] of [['wind', metadata.tileSize, metadata.levels], ['fine', metadata.fineTileSize, undefined]] as const) {
    const grid = pinned.manifest.surfaces.find(surface => surface.kind === (kind === 'wind' ? 'native' : 'fine'))!.grid;
    const layout = windLayout(grid.width, grid.height, size, levels);
    metadata[kind] = Array.from({ length: layout.pages }, (_, page) => ({ ...metadata[kind][0], count: layout.pageCount(page), bytes: layout.pageCount(page) * layout.chunkBytes }));
  }
  for (const level of metadata.overview ?? []) {
    const grid = pinned.manifest.surfaces.find(surface => surface.kind === 'native')!.grid;
    const layout = windOverviewLayout(grid, level.stride);
    level.shards = Array.from({ length: layout.pages }, (_, page) => ({ ...level.shards[0], count: layout.pageCount(page), bytes: layout.pageCount(page) * layout.chunkBytes }));
  }
  return JSON.stringify(metadata);
}
const reply = (bytes: Uint8Array) => new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'application/octet-stream' } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('loads once per view and samples surface, AGL, and lift without requests', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const globalFetch = vi.fn(); vi.stubGlobal('fetch', globalFetch);
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds })).toBe('ready');
  expect(source.sample(0.5, 0.5, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
  expect(source.sample(0.5, 0.5, 450)).toEqual({ status: 'valid', u: 3, v: 6 });
  expect(source.sample(0.5, 0.5, 'lift')).toEqual({ status: 'valid', u: 3, v: 6 });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(globalFetch).not.toHaveBeenCalled();
  pinned.expiresAtMs = Date.now() - 1;
  expect(source.sample(0.5, 0.5, 'surface').status).toBe('unavailable');
  source.dispose();
});

it('reuses validated immutable chunks across panning, replacement views and timeline returns', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('/wind/') || String(url).includes('/fine/')
    ? reply(String(url).includes('/wind/') ? wind : fine)
    : new Response(descriptor(String(url).split('/').at(-1)!), { headers: { 'content-type': 'application/json' } }));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
  source.dispose();
  const replacement = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  expect(await replacement.load({ build: pinned, frame, bounds: [0.1, 0.1, 0.9, 0.9] })).toBe('ready');
  expect(replacement.sample(0.5, 0.5, 450)).toEqual({ status: 'valid', u: 3, v: 6 });
  expect(fetcher).toHaveBeenCalledTimes(3);
  const nextFrame = pinned.manifest.frames[1].id;
  expect(await replacement.load({ build: pinned, frame: nextFrame, bounds })).toBe('ready');
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(await replacement.load({ build: pinned, frame, bounds })).toBe('ready');
  expect(fetcher).toHaveBeenCalledTimes(6);
  replacement.dispose(); cache.clear();
  const reopened = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  expect(await reopened.load({ build: pinned, frame, bounds })).toBe('ready');
  expect(fetcher).toHaveBeenCalledTimes(9);
  reopened.dispose();
});

it('charges active and in-flight buffers to the shared numeric memory budget', () => {
  const cache = new WindDataCache(), chunkBytes = 256 * 1024, expires = Date.now() + 60_000;
  const pinned = Array.from({ length: WIND_NUMERIC_BYTES / chunkBytes }, (_, index) => cache.take(String(index), chunkBytes, expires));
  expect(() => cache.take('over-budget', chunkBytes, expires)).toThrow('byte budget');
  const reusable = pinned[0]; reusable.used = chunkBytes;
  cache.release(reusable);
  const fresh = cache.take('new', chunkBytes, expires);
  expect(() => cache.take('0', chunkBytes, expires)).toThrow('byte budget');
  cache.release(fresh);
  for (const entry of pinned.slice(1)) cache.release(entry);
  cache.clear();
});

it('keeps detail on the camera when a padded view exceeds one admission', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const grid = { kind: 'regular-latlon' as const, width: 144, height: 128, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
  for (const surface of pinned.manifest.surfaces) surface.grid = grid;
  pinned.manifest.descriptors.bounds = [0, 0, 144, 80];
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4, 8].map(stride => {
    const layout = windOverviewLayout(grid, stride);
    return { stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.count * layout.chunkBytes }] };
  });
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const core = [1, 1, 3, 3] as const;
  expect(await source.load({ build: pinned, frame, bounds: [-180, -10, 180, 10], core })).toBe('ready');
  expect(source.admitted).toEqual([...core]);
  const requests = fetcher.mock.calls.slice(1).map(([url]) => String(url));
  expect(requests.some(url => url.includes('/wind/'))).toBe(true);
  expect(requests.some(url => url.includes('/overview-'))).toBe(false);
  source.dispose();
});

it('retains a rested timeline beyond one view admission', () => {
  const cache = new WindDataCache(WIND_WINDOW_BYTES, WIND_WINDOW_ENTRIES), chunkBytes = 1024 * 1024, expires = Date.now() + 60_000;
  for (let index = 0; index < 16; index++) cache.take(String(index), chunkBytes, expires);
  expect(cache.allocatedBytes).toBe(16 * chunkBytes);
  cache.clear();
});

it('keeps cancelled allocations charged until their requests settle', async () => {
  const cache = new WindDataCache(), expires = Date.now() + 60_000;
  const pinned = cache.take('resident', WIND_NUMERIC_BYTES - 32 * 1024, expires);
  let settle!: () => void;
  const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { settle = () => reject(init!.signal!.reason); }, { once: true });
  }));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache }), current = build();
  const load = source.load({ build: current, frame: current.manifest.frames[0].id, bounds });
  const rejected = expect(load).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  source.dispose();
  expect(() => cache.take('replacement', 32 * 1024, expires)).toThrow('byte budget');
  settle(); await rejected;
  const replacement = cache.take('replacement', 32 * 1024, expires);
  cache.release(replacement); cache.release(pinned);
});

it('demotes future chunk and preparation claims after a held descriptor', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const budget = createPreparationBudget(4 * 1024 * 1024), reserve = vi.spyOn(budget, 'reserve');
  let resolveDescriptor!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Promise(resolve => { resolveDescriptor = resolve; })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetcher, budget });
  const request = vi.fn((spec: ForecastRequestSpec) => scheduler.request(spec));
  const source = new WindDataSource('https://api.test', { budget, request, coalesceSpans: false });
  const pending = source.load({ build: pinned, frame, bounds });
  try {
    await vi.waitFor(() => expect(resolveDescriptor).toBeDefined());
    expect(request.mock.calls[0][0].priority).toBe('foreground');
    source.setPriority('background');
    resolveDescriptor(new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } }));
    expect(await pending).toBe('ready');
    expect(request.mock.calls.slice(1).map(([spec]) => spec.priority)).toEqual(['background', 'background']);
    source.field('surface'); source.prepare('surface', 8);
    expect(reserve.mock.calls.filter(([category]) => category === 'wind-numeric').slice(1).every(([, , priority]) => priority === 'background')).toBe(true);
    expect(reserve.mock.calls.some(([category, , priority]) => category === 'wind-sampler' && priority === 'background')).toBe(true);
    expect(reserve.mock.calls.some(([category, , priority]) => category === 'wind-prepared' && priority === 'background')).toBe(true);
    source.promote(); source.field(450); source.prepare(450, 8);
    expect(reserve.mock.calls.some(([category, , priority]) => category === 'wind-sampler' && priority === 'foreground')).toBe(true);
    expect(reserve.mock.calls.some(([category, , priority]) => category === 'wind-prepared' && priority === 'foreground')).toBe(true);
  } finally { source.dispose(); scheduler.dispose(); await Promise.allSettled([pending]); }
});

it('reselects queued shared requests without changing their handles or cancelling another owner', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  const root = `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}`;
  const desc = cache.take(root, WIND_FRAME_LIMIT, pinned.expiresAtMs);
  const bytes = new TextEncoder().encode(descriptor(frame)); desc.bytes.set(bytes); desc.used = bytes.length; cache.release(desc);
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>(), signals = new Map<string, AbortSignal>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url); signals.set(path, init!.signal!);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.set(path, controller); } }), { headers: { 'content-type': 'application/octet-stream' } });
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetcher }); scheduler.setForegroundPending(1, true);
  const handles: ForecastRequestHandle[] = [];
  const request = vi.fn((spec: ForecastRequestSpec) => { const handle = scheduler.request(spec); handles.push(handle); return handle; });
  const first = new WindDataSource('https://api.test', { cache, request, priority: 'background', coalesceSpans: false });
  const second = new WindDataSource('https://api.test', { cache, request, priority: 'background', coalesceSpans: false });
  const one = first.load({ build: pinned, frame, bounds }), two = second.load({ build: pinned, frame, bounds });
  const outcomes = Promise.allSettled([one, two]);
  try {
    await vi.waitFor(() => expect(scheduler.stats().queued).toBe(2));
    expect(fetcher).not.toHaveBeenCalled();
    const originals = handles.map(handle => handle.response);
    second.setPriority('foreground');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    first.setPriority('foreground'); first.setPriority('background');
    expect(handles.map(handle => handle.response)).toEqual(originals);
    expect(handles).toHaveLength(2);
    expect([...signals.values()].every(signal => !signal.aborted)).toBe(true);
    for (const [path, stream] of streams) { stream.enqueue(path.includes('/wind/') ? wind : fine); stream.close(); }
    expect(await one).toBe('ready'); expect(await two).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { first.dispose(); second.dispose(); scheduler.dispose(); await outcomes; cache.clear(); }
});

it.each(['resolve', 'reject'] as const)('holds direct response and destination until the first body cancellation %ss', async mode => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, budget = createPreparationBudget(2 * 1024 * 1024);
  let finish!: () => void;
  const cancel = vi.fn(() => new Promise<void>((resolve, reject) => { finish = () => mode === 'resolve' ? resolve() : reject(new Error('cancel failed')); }));
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'application/json' } });
  const source = new WindDataSource('https://api.test', { budget, fetchImpl: vi.fn(async () => response) });
  const pending = source.load({ build: pinned, frame, bounds });
  const outcome = pending.then(() => 'resolved', () => 'rejected');
  try {
    await vi.waitFor(() => expect(budget.snapshot()).toEqual({ 'wind-numeric': WIND_FRAME_LIMIT, response: WIND_FRAME_LIMIT }));
    source.dispose();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(budget.snapshot()).toEqual({ 'wind-numeric': WIND_FRAME_LIMIT, response: WIND_FRAME_LIMIT });
    expect(response.body?.locked).toBe(true);
    finish();
    expect(await outcome).toBe('rejected');
    expect(response.body?.locked).toBe(false);
    expect(budget.used).toBe(0);
  } finally { finish?.(); source.dispose(); await outcome; }
});

it('allows foreground raster and JSON while a real background wind wave is gated', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, MiB = 1024 * 1024;
  const budget = createPreparationBudget(2 * MiB, { foregroundReserveBytes: MiB });
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const root = `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}`;
  const desc = cache.take(root, WIND_FRAME_LIMIT, pinned.expiresAtMs, false);
  const bytes = new TextEncoder().encode(descriptor(frame)); desc.bytes.set(bytes); desc.used = bytes.length; cache.release(desc);
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith('/selected-raster')) return new Response(new Uint8Array([1, 2]));
    if (path.endsWith('/selected-json')) return new Response('{}');
    return reply(path.includes('/wind/') ? wind : fine);
  });
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: fetcher });
  scheduler.setForegroundPending(1, true);
  const source = new WindDataSource('https://api.test', { cache, budget, priority: 'background', request: spec => scheduler.request(spec), coalesceSpans: false });
  const pending = source.load({ build: pinned, frame, bounds });
  const outcome = Promise.allSettled([pending]);
  try {
    await vi.waitFor(() => expect(scheduler.stats().queued).toBeGreaterThan(0));
    expect(fetcher).not.toHaveBeenCalled();
    const raster = scheduler.request({ url: 'https://api.test/selected-raster', kind: 'raster', priority: 'foreground', maxResponseBytes: 1024 });
    const json = scheduler.request({ url: 'https://api.test/selected-json', kind: 'json', priority: 'foreground', maxResponseBytes: 1024 });
    const processing = budget.reserve('selected-processing', 512 * 1024)!;
    expect(processing).not.toBeNull();
    expect(Array.from(new Uint8Array(await (await raster.response).arrayBuffer()))).toEqual([1, 2]);
    expect(await (await json.response).text()).toBe('{}');
    await Promise.all([raster.settled, json.settled]); processing.release();
    expect(scheduler.stats().queued).toBeGreaterThan(0);
    scheduler.setForegroundPending(1, false);
    expect(await pending).toBe('ready');
  } finally { source.dispose(); scheduler.dispose(); await outcome; cache.clear(); }
  expect(budget.used).toBe(0);
});

it('refetches malformed chunks instead of retaining failed validation in the shared cache', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  let corrupt = true;
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith(`/data/${frame}`)) return new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } });
    if (!String(url).includes('/wind/')) return reply(fine);
    const bytes = Uint8Array.from(wind);
    if (corrupt) new DataView(bytes.buffer).setFloat32(12, NaN, true);
    return reply(bytes);
  });
  const failed = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  await expect(failed.load({ build: pinned, frame, bounds })).rejects.toThrow('Invalid wind');
  failed.dispose(); corrupt = false;
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
  expect(source.sample(0.5, 0.5, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/wind/'))).toHaveLength(2);
  source.dispose();
});

it('preserves fractional AGL and lift targets beside missing vertical brackets', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const gapped = encodeWindColumns(Array.from({ length: 256 }, () => ({
    surface: { u: 1, v: 2 }, levels: [
      { height: 100, wind: { u: 1, v: 2 } }, null,
      { height: 300, wind: { u: 3, v: 6 } }, { height: 400, wind: { u: 4, v: 8 } }
    ]
  })));
  const companion = Uint8Array.from(fine), targets = new DataView(companion.buffer);
  targets.setFloat32(0, 99.6, true); targets.setFloat32(4, 299.6, true);
  const metadata = JSON.parse(descriptor(frame));
  metadata.levels = 4; metadata.wind[0].bytes = gapped.length;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? gapped : companion));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
  expect(source.sample(0, 0, 'lift')).toEqual({ status: 'unavailable', u: null, v: null });
  expect(source.sample(0, 0, 200)).toEqual({ status: 'unavailable', u: null, v: null });
  expect(source.sample(0, 0, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
  source.dispose();
});

it.each([0, 4])('rejects nonfinite companion targets at byte %s', async offset => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, companion = Uint8Array.from(fine);
  new DataView(companion.buffer).setFloat32(offset, NaN, true);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(layoutDescriptor(pinned, JSON.parse(descriptor(frame))), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : companion));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  await expect(source.load({ build: pinned, frame, bounds })).rejects.toThrow('Invalid numeric companion');
  expect(source.sample(0, 0, 'surface').status).toBe('unavailable');
  source.dispose();
});

it('returns unavailable for old builds and cancels a superseded request', async () => {
  let call = 0;
  const fetcher = vi.fn<typeof fetch>((_url, init) => ++call === 1 ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })) : Promise.resolve(new Response(null, { status: 409 })));
  vi.stubGlobal('fetch', fetcher);
  const source = new WindDataSource('https://api.test'), pinned = build();
  const pending = source.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds });
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(await source.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds })).toBe('unavailable');
  await rejection;
  expect(source.sample(0.5, 0.5, 'surface').status).toBe('unavailable');
  source.dispose();
});

it('waits for aborted loads to release their responses before starting replacements', async () => {
  let finish!: () => void;
  let calls = 0;
  const fetcher = vi.fn<typeof fetch>((_url, init) => ++calls === 1
    ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { finish = () => reject(init!.signal!.reason); }, { once: true }))
    : Promise.resolve(new Response(null, { status: 404 })));
  const pinned = build(), source = new WindDataSource('https://api.test', { fetchImpl: fetcher }), frame = pinned.manifest.frames[0].id;
  const first = source.load({ build: pinned, frame, bounds });
  const aborted = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const second = source.load({ build: pinned, frame, bounds });
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
  finish();
  await aborted;
  expect(await second).toBe('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(2);
  source.dispose();
});

it('rejects oversized descriptors before parsing or requesting chunks', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(' '.repeat(32 * 1024 + 1), { headers: { 'content-type': 'application/json' } }));
  const pinned = build(), source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  await expect(source.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds })).rejects.toThrow('exceeds budget');
  expect(fetcher).toHaveBeenCalledTimes(1);
  source.dispose();
});

function globalBuild(wrapLongitude: boolean) {
  const pinned = build();
  pinned.expiresAtMs = Date.now() + 600_000;
  pinned.manifest.expiresAt = new Date(pinned.expiresAtMs).toISOString();
  pinned.manifest.descriptors.bounds = [-180, -1, 180, 2];
  const grid = { kind: 'regular-latlon' as const, width: 1440, height: 2, lon0: -180, lat0: 0, dx: 0.25, dy: 1, earthRadiusM: 6371000, wrapLongitude };
  for (const surface of pinned.manifest.surfaces) surface.grid = grid;
  return pinned;
}

const globalWind = encodeWindColumns(Array.from({ length: 256 }, () => column));
const globalFine = new Uint8Array(64 * 64 * WIND_FINE_CELL_BYTES), globalFineView = new DataView(globalFine.buffer);
for (let i = 0; i < 64 * 64; i++) {
  globalFineView.setFloat32(i * WIND_FINE_CELL_BYTES, 100, true); globalFineView.setFloat32(i * WIND_FINE_CELL_BYTES + 4, 550, true); globalFineView.setUint8(i * WIND_FINE_CELL_BYTES + 8, 16);
}

it('loads both seam edges for wrapping grids and keeps regional grids unwrapped', async () => {
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(layoutDescriptor(pinned, JSON.parse(descriptor(frame))), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? globalWind : globalFine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [179.85, 0, 179.95, 1] })).toBe('ready');
  const east = source.sample(0.5, 179.95, 450);
  expect(east).toEqual({ status: 'valid', u: 3, v: 6 });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/wind/0'))).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/fine/0'))).toBe(true);
  expect(await source.load({ build: pinned, frame, bounds: [-179.95, 0, -179.85, 1] })).toBe('ready');
  expect(source.sample(0.5, -179.95, 450)).toEqual(east);
  fetcher.mockClear();
  expect(await source.load({ build: globalBuild(false), frame, bounds: [179.55, 0, 179.7, 1] })).toBe('ready');
  expect(source.sample(0.5, 179.6, 450).status).toBe('valid');
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/wind/0') || String(url).endsWith('/fine/0'))).toBe(false);
  source.dispose();
});

it('finishes multiple slow chunk waves within the workload deadline', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>((url, init) => {
    if (String(url).endsWith(`/data/${frame}`)) return Promise.resolve(new Response(layoutDescriptor(pinned, JSON.parse(descriptor(frame))), { headers: { 'content-type': 'application/json' } }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(reply(String(url).includes('/wind/') ? globalWind : globalFine)), 2_000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(init!.signal!.reason); }, { once: true });
    });
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const load = source.load({ build: pinned, frame, bounds: [-170, 0, 0, 1] });
  await vi.advanceTimersByTimeAsync(35_000);
  expect(await load).toBe('ready');
  expect(fetcher.mock.calls.length).toBeGreaterThan(40);
  expect(source.sample(0.5, -100, 450).status).toBe('valid');
  source.dispose();
});

it('times out a hanging body and cancels it', async () => {
  vi.useFakeTimers();
  const pinned = build(), frame = pinned.manifest.frames[0].id, cancel = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ pull() {}, cancel }), { headers: { 'content-type': 'application/json' } }));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const load = source.load({ build: pinned, frame, bounds });
  const rejected = expect(load).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  source.dispose();
});

it('propagates caller abort to an in-flight request', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, caller = new AbortController();
  const fetcher = vi.fn<typeof fetch>((url, init) => String(url).endsWith(`/data/${frame}`)
    ? new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); })
    : Promise.resolve(reply(String(url).includes('/wind/') ? wind : fine)));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const load = source.load({ build: pinned, frame, bounds, signal: caller.signal });
  const rejected = expect(load).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  caller.abort();
  await rejected;
  expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  source.dispose();
});

it('aborts a queued caller without starting the next fetch early', async () => {
  let finish!: () => void, calls = 0;
  const fetcher = vi.fn<typeof fetch>((_url, init) => ++calls === 1
    ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { finish = () => reject(init!.signal!.reason); }, { once: true }))
    : Promise.resolve(new Response(null, { status: 404 })));
  const pinned = build(), frame = pinned.manifest.frames[0].id, caller = new AbortController();
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const first = source.load({ build: pinned, frame, bounds });
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const queued = source.load({ build: pinned, frame, bounds, signal: caller.signal });
  const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  caller.abort();
  await queuedRejected;
  const next = source.load({ build: pinned, frame, bounds });
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledOnce();
  finish();
  await firstRejected;
  expect(await next).toBe('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(2);
  source.dispose();
});

it('reuses decoded tiles across repeated samples without retaining coordinate caches', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
  const internals = source as unknown as { current: { wind: Map<number, unknown>; fine: Map<number, unknown> } };
  const windTiles = [...internals.current.wind], fineTiles = [...internals.current.fine];
  const expected = source.sample(0.5, 0.5, 450);
  for (let i = 0; i < 3; i++) expect(source.sample(0.5, 0.5, 450)).toEqual(expected);
  expect([...internals.current.wind]).toEqual(windTiles);
  expect([...internals.current.fine]).toEqual(fineTiles);
  for (const [key, tile] of windTiles) expect(internals.current.wind.get(key)).toBe(tile);
  for (const [key, tile] of fineTiles) expect(internals.current.fine.get(key)).toBe(tile);
  expect(fetcher).toHaveBeenCalledTimes(3);
  source.dispose();
});

it('matches the reference sampler for mixed fine statuses and contributor counts', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, bytes = Uint8Array.from(fine), fineView = new DataView(bytes.buffer);
  const packed = decodePackedWindChunk(wind), grid = pinned.manifest.surfaces[0].grid;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : bytes));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const patterns = [[0, 0, 0, 0], [0, 1, 1, 0], [1, 1, 1, 1], [0, 2, 0, 3], [2, 0, 3, 0], [1, 2, 0, 0], [4, 5, 0, 0]];
  for (const stored of [false, true]) for (const pattern of patterns) {
    pinned.manifest.buildId = `fixture-${stored}-${pattern.join('-')}`;
    pinned.manifest.tool.useStoredMslNoLift = stored ? true : undefined;
    for (let i = 0; i < 4; i++) {
      const pos = (Math.floor(i / 2) * 64 + i % 2) * WIND_FINE_CELL_BYTES;
      fineView.setFloat32(pos, 100 + i * 20, true); fineView.setFloat32(pos + 4, 400 + i * 100, true);
      fineView.setUint8(pos + 8, 16 | (pattern[i] & 3 ? 2 : 0) | ((pattern[i] & 3) << 2)); fineView.setUint8(pos + 9, pattern[i] & ~3);
    }
    expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
    for (const [lat, lon] of [[0, 0], [0, 0.5], [0.5, 0.5], [0.2, 0.7]]) for (const height of [450, 'lift'] as const) {
      const plan = planSample(grid, lat, lon)!;
      const cells = plan.contributors.map(item => {
        const pos = (item.row * 64 + item.column) * WIND_FINE_CELL_BYTES, packed = fineView.getUint8(pos + 8);
        return { value: fineView.getFloat32(pos + (height === 'lift' ? 4 : 0), true), flags: height === 'lift' ? ((packed >> 2) & 3) | fineView.getUint8(pos + 9) : packed & 3 };
      });
      const selected = windTargetHeight(plan, cells, height === 'lift' ? { lift: true } : { agl: height }, stored);
      let expected;
      if (selected.status !== STATUS_VALID || selected.value === null) expected = { status: selected.status === STATUS_NO_LIFT ? 'no-lift' : selected.status === STATUS_OUTSIDE ? 'outside' : 'unavailable', u: null, v: null };
      else {
        const result = samplePackedWindColumns(plan, plan.contributors.map(() => packed), plan.contributors.map(item => item.row * 16 + item.column), selected.value);
        expected = { status: result.status === STATUS_VALID ? 'valid' : result.status === STATUS_OUTSIDE ? 'outside' : 'unavailable', u: result.u, v: result.v };
      }
      expect(source.sample(lat, lon, height)).toEqual(expected);
    }
  }
  source.dispose();
});

it('renders a bounded whole-world overview and retains wrapped seam samples', async () => {
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [-180, -90, 180, 90];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { height: 721, lat0: -90, dy: 0.25 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4, 8, 16].map(stride => {
    const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, stride);
    return { stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.count * layout.chunkBytes }] };
  });
  const bytes = new Uint8Array(32 * 32 * WIND_OVERVIEW_CELL_BYTES), view = new DataView(bytes.buffer);
  for (let cell = 0; cell < 32 * 32; cell++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
    const offset = cell * WIND_OVERVIEW_CELL_BYTES + mode * 9;
    view.setFloat32(offset, mode + 1, true); view.setFloat32(offset + 4, (mode + 1) * 2, true);
  }
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } }) : reply(bytes));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [-180, -85, 180, 85] })).toBe('ready');
  const requests = fetcher.mock.calls.slice(1).map(([url]) => String(url));
  expect(requests).toHaveLength(6);
  expect(requests.every(url => url.includes('/overview-16/'))).toBe(true);
  expect(requests.length * bytes.length).toBeLessThan(4 * 1024 * 1024);
  expect(source.sample(0, 179.95, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
  expect(source.sample(0, -179.95, 20)).toEqual({ status: 'valid', u: 2, v: 4 });
  expect(source.sample(0, 0, 'lift')).toEqual({ status: 'valid', u: 12, v: 24 });
  source.dispose();
});

it('preserves per-mode missing overview cells without inventing calm or bridging masks', async () => {
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id, metadata = JSON.parse(descriptor(frame));
  const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 2);
  metadata.overview = [{ stride: 2, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.count * layout.chunkBytes }] }];
  const bytes = new Uint8Array(layout.chunkBytes), view = new DataView(bytes.buffer);
  for (let cell = 0; cell < 32 * 32; cell++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
    const offset = cell * WIND_OVERVIEW_CELL_BYTES + mode * 9;
    if (mode === 0) { view.setFloat32(offset, 3, true); view.setFloat32(offset + 4, 4, true); }
    else view.setUint8(offset + 8, mode === WIND_OVERVIEW_VALUES - 1 ? STATUS_NO_LIFT : 2);
  }
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } }) : reply(bytes));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [-180, -1, 180, 2] })).toBe('ready');
  expect(source.sample(0.5, 0, 'surface')).toEqual({ status: 'valid', u: 3, v: 4 });
  expect(source.sample(0.5, 0, 20)).toEqual({ status: 'unavailable', u: null, v: null });
  expect(source.sample(0.5, 0, 'lift')).toEqual({ status: 'no-lift', u: null, v: null });
  expect(source.sample(3, 0, 'surface')).toEqual({ status: 'outside', u: null, v: null });
  source.dispose();
});

it('registers averaged overview centers and partial edge cells to the source grid', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [-129, -1, 129, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 259, height: 1, lon0: -129 });
  const metadata = JSON.parse(descriptor(frame)), layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 2);
  metadata.levels = 77;
  metadata.wind[0].count = 17; metadata.wind[0].bytes = 17 * (12 + 256 * (9 + 13 * 77));
  metadata.fine[0].count = 5; metadata.fine[0].bytes = 5 * fine.length;
  metadata.overview = [{ stride: 2, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.count * layout.chunkBytes }] }];
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith(`/data/${frame}`)) return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
    const tile = Number(String(url).split('/').at(-1)), bytes = new Uint8Array(layout.chunkBytes), view = new DataView(bytes.buffer);
    for (let i = 0; i < 32 * 32; i++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
      const x = (tile * 32 + i % 32) * 2, offset = i * WIND_OVERVIEW_CELL_BYTES + mode * 9;
      if (x >= 259 || i >= 32) view.setUint8(offset + 8, STATUS_OUTSIDE);
      else view.setFloat32(offset, (x + Math.min(x + 1, 258)) / 2, true);
    }
    return reply(bytes);
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [-129, -1, 129, 1] })).toBe('ready');
  for (const x of [1, 29, 64.5, 255, 256, 257, 258]) expect(source.sample(0, x - 129, 'surface').u).toBeCloseTo(x);
  expect(source.sample(0, -129, 'surface').u).toBe(0.5);
  expect(fetcher.mock.calls.slice(1).every(([url]) => String(url).includes('/overview-2/'))).toBe(true);
  source.dispose();
});

it('reserves descriptor memory while replacing a viewport near the numeric byte limit', async () => {
  const pinned = build(), cache = new WindDataCache(), bounds = [-0.01, -0.01, 0.16, 4.48] as const;
  const grid = { kind: 'regular-latlon' as const, width: 16, height: 448, lon0: 0, lat0: 0, dx: 0.01, dy: 0.01, earthRadiusM: 6371000, wrapLongitude: false };
  pinned.manifest.descriptors.bounds = [...bounds];
  for (const surface of pinned.manifest.surfaces) surface.grid = grid;
  const columns = encodeWindColumns(Array.from({ length: 256 }, () => ({ surface: { u: 1, v: 2 },
    levels: Array.from({ length: 41 }, (_, i) => ({ height: 100 + i * 50, wind: { u: 1, v: 2 } })) })));
  const layout = windOverviewLayout(grid, 2), overview = new Uint8Array(layout.chunkBytes), view = new DataView(overview.buffer);
  for (let offset = 0; offset < overview.length; offset += 9) { view.setFloat32(offset, 1, true); view.setFloat32(offset + 4, 2, true); }
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.includes('/wind/')) return reply(columns);
    if (path.includes('/fine/')) return reply(fine);
    if (path.includes('/overview-2/')) return reply(overview);
    const metadata = JSON.parse(descriptor(path.split('/').at(-1)!));
    metadata.levels = 41;
    metadata.wind[0].count = 28; metadata.wind[0].bytes = 28 * columns.length;
    metadata.fine[0].count = 7; metadata.fine[0].bytes = 7 * fine.length;
    metadata.overview = [{ stride: 2, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.count * layout.chunkBytes }] }];
    return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
  });
  const current = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  const replacement = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  try {
    expect(await current.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds })).toBe('ready');
    expect(await replacement.load({ build: pinned, frame: pinned.manifest.frames[1].id, bounds })).toBe('ready');
    for (const source of [current, replacement]) expect(source.sample(1, 0.1, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
    expect(fetcher.mock.calls.some(([url]) => /\/(wind|fine)\//.test(String(url)))).toBe(false);
  } finally { current.dispose(); replacement.dispose(); cache.clear(); }
});

it('coalesces contiguous tile spans, slices per-tile cache entries, and serves quantized field samples', async () => {
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  pinned.manifest.descriptors.bounds = [-180, -90, 180, 90];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { height: 721, lat0: -90, dy: 0.25 });
  const metadata = JSON.parse(descriptor(frame)), layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 8);
  metadata.overview = [2, 4, 8].map(stride => {
    const item = windOverviewLayout(pinned.manifest.surfaces[0].grid, stride);
    return { stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: item.count, bytes: item.count * item.chunkBytes }] };
  });
  const tileBytes = new Uint8Array(layout.chunkBytes), view = new DataView(tileBytes.buffer);
  for (let cell = 0; cell < 32 * 32; cell++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
    const offset = cell * WIND_OVERVIEW_CELL_BYTES + mode * 9;
    view.setFloat32(offset, 5, true); view.setFloat32(offset + 4, -3, true);
  }
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } });
    const range = path.split('/').at(-1)!.split('-').map(Number);
    const count = range.length === 2 ? range[1]! - range[0]! + 1 : 1;
    const combined = new Uint8Array(count * tileBytes.length);
    for (let i = 0; i < count; i++) combined.set(tileBytes, i * tileBytes.length);
    return reply(combined);
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, coalesceSpans: true });
  expect(await source.load({ build: pinned, frame, bounds: [-180, -85, 180, 85] })).toBe('ready');
  expect(source.isOverview).toBe(true);
  const chunkCalls = fetcher.mock.calls.slice(1).map(([url]) => String(url));
  expect(chunkCalls.length).toBeLessThan(6);
  expect(chunkCalls.some(url => /\/overview-8\/\d+-\d+$/.test(url))).toBe(true);
  const field = source.field('surface');
  expect(field.sample(75, 20)).toEqual({ status: 0, u: 5, v: -3 });
  expect(field.sample(75.0004, 20.0004)).toEqual({ status: 0, u: 5, v: -3 });
  fetcher.mockClear();
  const replacement = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, coalesceSpans: true });
  expect(await replacement.load({ build: pinned, frame, bounds: [-20, -20, 20, 20] })).toBe('ready');
  expect(fetcher).not.toHaveBeenCalled();
  pinned.expiresAtMs = Date.now() - 1;
  expect(field.sample(75, 20).status).toBe(2);
  source.dispose(); replacement.dispose(); cache.clear();

  pinned.expiresAtMs = Date.now() + 600_000;
  pinned.manifest.expiresAt = new Date(pinned.expiresAtMs).toISOString();
  const legacyCache = new WindDataCache();
  const legacyFetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } });
    if (/\/\d+-\d+$/.test(path)) return new Response('Invalid wind chunk', { status: 400 });
    return reply(tileBytes);
  });
  const fallbackSource = new WindDataSource('https://api.test', { fetchImpl: legacyFetcher, cache: legacyCache, coalesceSpans: true });
  expect(await fallbackSource.load({ build: pinned, frame, bounds: [-180, -85, 180, 85] })).toBe('ready');
  expect(legacyCache.spansUnsupported).toBe(true);
  expect(fallbackSource.sample(75, 20, 'surface')).toEqual({ status: 'valid', u: 5, v: -3 });
  fallbackSource.dispose(); legacyCache.clear();
});

it('skips outside sparse wind/fine tiles during admission, aligns 8-tile spans, and falls back to overview on a missing detail chunk', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 16];
  pinned.manifest.surfaces[0]!.grid = { kind: 'regular-latlon', width: 128, height: 16, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
  pinned.manifest.surfaces[1]!.grid = { kind: 'regular-latlon', width: 512, height: 64, lon0: 0, lat0: 0, dx: 0.25, dy: 0.25, earthRadiusM: 6371000, wrapLongitude: false };
  // Logical tiles: 8 wind tiles (0..7) and 8 fine tiles (0..7). Only logical tile 7 (easternmost island x=112..127) is covered!
  const maskBits = Uint8Array.of(0x80);
  const b64 = btoa(String.fromCharCode(...maskBits));
  const islandWind = encodeWindColumns(Array.from({ length: 256 }, () => column));
  const islandFine = new Uint8Array(64 * 64 * WIND_FINE_CELL_BYTES), fv = new DataView(islandFine.buffer);
  for (let i = 0; i < 64 * 64; i++) { fv.setFloat32(i * WIND_FINE_CELL_BYTES, 100, true); fv.setFloat32(i * WIND_FINE_CELL_BYTES + 4, 550, true); fv.setUint8(i * WIND_FINE_CELL_BYTES + 8, 16); }
  const ovLayout = windOverviewLayout(pinned.manifest.surfaces[0]!.grid, 2);
  const ovBytes = new Uint8Array(ovLayout.chunkBytes), ovView = new DataView(ovBytes.buffer);
  for (let cell = 0; cell < 32 * 32; cell++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
    const off = cell * WIND_OVERVIEW_CELL_BYTES + mode * 9;
    ovView.setFloat32(off, 7, true); ovView.setFloat32(off + 4, 9, true);
  }
  const sparseDesc = JSON.stringify({
    version: 3, frame, levels: 2, tileSize: 16, fineTileSize: 64, windMask: b64, fineMask: b64,
    wind: [{ sha256: 'a'.repeat(64), bytes: islandWind.length, indexSha256: 'b'.repeat(64), count: 1 }],
    fine: [{ sha256: 'c'.repeat(64), bytes: islandFine.length, indexSha256: 'd'.repeat(64), count: 1 }],
    overview: [{ stride: 2, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: ovLayout.count, bytes: ovLayout.count * ovLayout.chunkBytes }] }]
  });
  let failDetail = false;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(sparseDesc, { headers: { 'content-type': 'application/json' } });
    if (failDetail && (path.includes('/wind/') || path.includes('/fine/'))) return new Response(null, { status: 404 });
    if (path.includes('/overview-2/')) {
      const range = path.split('/').at(-1)!.split('-').map(Number);
      const count = range.length === 2 ? range[1]! - range[0]! + 1 : 1;
      const out = new Uint8Array(count * ovBytes.length);
      for (let i = 0; i < count; i++) out.set(ovBytes, i * ovBytes.length);
      return reply(out);
    }
    return reply(path.includes('/wind/') ? islandWind : islandFine);
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, coalesceSpans: true });
  // Pure-ocean viewport [0..20, 0..10] skips all outside tiles -> zero chunk HTTP requests!
  expect(await source.load({ build: pinned, frame, bounds: [0, 0, 20, 10] })).toBe('ready');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(source.sample(5, 10, 'surface')).toEqual({ status: 'outside', u: null, v: null });

  // Mixed ocean + island viewport [80..126, 0..12] fetches only slot 0 for wind and slot 0 for fine!
  fetcher.mockClear();
  expect(await source.load({ build: pinned, frame, bounds: [80, 0, 126, 12] })).toBe('ready');
  expect(source.isOverview).toBe(false);
  expect(fetcher.mock.calls.map(([u]) => String(u).split('/data/')[1])).toEqual([`${frame}/fine/0`, `${frame}/wind/0`]);
  expect(source.sample(5, 90, 'surface')).toEqual({ status: 'outside', u: null, v: null });
  expect(source.sample(5, 120, 450)).toEqual({ status: 'valid', u: 3, v: 6 });

  // Missing detail chunk falls back cleanly to overview instead of rejecting the viewport.
  failDetail = true;
  const resilient = new WindDataSource('https://api.test', { fetchImpl: fetcher, coalesceSpans: true });
  expect(await resilient.load({ build: pinned, frame, bounds: [80, 0, 126, 12] })).toBe('ready');
  expect(resilient.isOverview).toBe(true);
  expect(resilient.sample(5, 120, 'surface')).toEqual({ status: 'valid', u: 7, v: 9 });
  source.dispose(); resilient.dispose();
});

it('caches 409 builds with a bounded TTL, isolates single-span 404/400 fallbacks, admits overview-less viewports, and invalidates field slots on reload', async () => {
  vi.useFakeTimers();
  const nonNumeric = build(), frame = nonNumeric.manifest.frames[0].id, cache = new WindDataCache();
  const unavailFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 409 }));
  const probe = new WindDataSource('https://api.test', { fetchImpl: unavailFetch, cache });
  expect(await probe.load({ build: nonNumeric, frame, bounds })).toBe('unavailable');
  expect(cache.isBuildUnavailable(nonNumeric.manifest.buildId)).toBe(true);
  expect(await probe.load({ build: nonNumeric, frame: nonNumeric.manifest.frames[1].id, bounds })).toBe('unavailable');
  expect(unavailFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(cache.isBuildUnavailable(nonNumeric.manifest.buildId)).toBe(false);
  probe.dispose();
  vi.useRealTimers();

  // Single 404 or single 400 on a multi-tile span falls back to single-tile requests without permanently flipping spansUnsupported.
  const spanBuild = globalBuild(true), spanFrame = spanBuild.manifest.frames[0].id, spanCache = new WindDataCache();
  spanBuild.manifest.descriptors.bounds = [-180, -90, 180, 90];
  for (const surface of spanBuild.manifest.surfaces) Object.assign(surface.grid, { height: 721, lat0: -90, dy: 0.25 });
  const spanMeta = JSON.parse(descriptor(spanFrame));
  spanMeta.overview = [2, 4, 8].map(stride => {
    const item = windOverviewLayout(spanBuild.manifest.surfaces[0].grid, stride);
    return { stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: item.count, bytes: item.count * item.chunkBytes }] };
  });
  const spanTile = new Uint8Array(windOverviewLayout(spanBuild.manifest.surfaces[0].grid, 8).chunkBytes), stv = new DataView(spanTile.buffer);
  for (let c = 0; c < 32 * 32; c++) for (let m = 0; m < WIND_OVERVIEW_VALUES; m++) { stv.setFloat32(c * WIND_OVERVIEW_CELL_BYTES + m * 9, 3, true); stv.setFloat32(c * WIND_OVERVIEW_CELL_BYTES + m * 9 + 4, 4, true); }
  let spanCalls = 0;
  const spanFetch = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${spanFrame}`)) return new Response(layoutDescriptor(spanBuild, spanMeta), { headers: { 'content-type': 'application/json' } });
    if (/\/\d+-\d+$/.test(path)) {
      spanCalls++;
      if (spanCalls === 1) return new Response(null, { status: 404 });
      if (spanCalls === 2) return new Response(null, { status: 400 });
      const [lo, hi] = path.split('/').at(-1)!.split('-').map(Number);
      const count = hi! - lo! + 1, out = new Uint8Array(count * spanTile.length);
      for (let i = 0; i < count; i++) out.set(spanTile, i * spanTile.length);
      return reply(out);
    }
    return reply(spanTile);
  });
  const spanSource = new WindDataSource('https://api.test', { fetchImpl: spanFetch, cache: spanCache, coalesceSpans: true });
  expect(await spanSource.load({ build: spanBuild, frame: spanFrame, bounds: [-180, -85, 180, 85] })).toBe('ready');
  expect(spanCalls).toBeGreaterThanOrEqual(3);
  expect(spanCache.spansUnsupported).toBe(false);
  spanSource.dispose(); spanCache.clear();

  // Overview-less regional build (e.g. pre-overview av-wrf at z=8.02: 55 wind + 6 fine = 7.34 MiB > 4 MiB) uses SINGLE_VIEW_MAX_BYTES.
  const regional = build();
  regional.manifest.buildId = 'av-wrf-no-overview';
  regional.manifest.descriptors.bounds = [0, 0, 160, 80];
  regional.manifest.surfaces[0]!.grid = { kind: 'regular-latlon', width: 176, height: 80, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
  regional.manifest.surfaces[1]!.grid = { kind: 'regular-latlon', width: 176, height: 80, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
  let windSpeed = 4;
  const makeRegionalWind = (u: number) => encodeWindColumns(Array.from({ length: 256 }, () => ({
    surface: { u, v: -2 },
    levels: Array.from({ length: 40 }, (_, i) => ({ height: 50 + i * 100, wind: { u, v: -2 } }))
  })));
  const regionalFine = new Uint8Array(64 * 64 * WIND_FINE_CELL_BYTES), rfv = new DataView(regionalFine.buffer);
  for (let i = 0; i < 64 * 64; i++) { rfv.setFloat32(i * WIND_FINE_CELL_BYTES, 100, true); rfv.setFloat32(i * WIND_FINE_CELL_BYTES + 4, 1500, true); rfv.setUint8(i * WIND_FINE_CELL_BYTES + 8, 16); }
  const firstWind = makeRegionalWind(windSpeed);
  const noOverviewDesc = (f: string) => JSON.stringify({
    version: 3, frame: f, levels: 40, tileSize: 16, fineTileSize: 64,
    wind: [{ sha256: 'a'.repeat(64), bytes: 55 * firstWind.length, indexSha256: 'b'.repeat(64), count: 55 }],
    fine: [{ sha256: 'c'.repeat(64), bytes: 6 * regionalFine.length, indexSha256: 'd'.repeat(64), count: 6 }]
  });
  const regionalFetch = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (/\/data\/f\d+$/.test(path)) return new Response(noOverviewDesc(path.split('/').at(-1)!), { headers: { 'content-type': 'application/json' } });
    return reply(path.includes('/wind/') ? makeRegionalWind(windSpeed) : regionalFine);
  });
  const regionalSource = new WindDataSource('https://api.test', { fetchImpl: regionalFetch });
  expect(55 * firstWind.length + 6 * regionalFine.length).toBeGreaterThan(WIND_NUMERIC_BYTES / 2);
  expect(await regionalSource.load({ build: regional, frame, bounds: [0, 0, 160, 80] })).toBe('ready');
  const surfaceField = regionalSource.field('surface');
  expect(surfaceField.sample(10, 10)).toEqual({ status: STATUS_VALID, u: 4, v: -2 });

  // Reloading a new frame on the same WindDataSource invalidates cached quantized field slots.
  windSpeed = 9;
  expect(await regionalSource.load({ build: regional, frame: regional.manifest.frames[1].id, bounds: [0, 0, 160, 80] })).toBe('ready');
  expect(surfaceField.sample(10, 10)).toEqual({ status: STATUS_VALID, u: 9, v: -2 });
  regionalSource.dispose();
});


it('retries transient numeric responses and cools an exhausted immutable resource', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  let windAttempts = 0, fail = false;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const target = String(url);
    if (target.endsWith(`/data/${frame}`)) return new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } });
    if (target.includes('/wind/')) {
      windAttempts++;
      if (fail || windAttempts === 1) return new Response(null, { status: 503 });
    }
    return reply(target.includes('/wind/') ? wind : fine);
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, retryDelaysMs: [1, 1], sleep: async () => {}, random: () => 0.5 });
  expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
  expect(windAttempts).toBe(2);
  source.dispose();

  windAttempts = 0; fail = true;
  const failingCache = new WindDataCache();
  const failing = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache: failingCache, retryDelaysMs: [1, 1], sleep: async () => {}, random: () => 0.5 });
  await expect(failing.load({ build: pinned, frame, bounds })).rejects.toThrow('Transient numeric response 503');
  expect(fetcher.mock.calls.filter(call => String(call[0]).includes('/wind/'))).toHaveLength(5);
  failing.dispose();

  const before = fetcher.mock.calls.length;
  const cooling = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache: failingCache, retryDelaysMs: [1, 1], sleep: async () => {} });
  await expect(cooling.load({ build: pinned, frame, bounds })).rejects.toThrow('cooling down');
  expect(fetcher.mock.calls).toHaveLength(before);
  expect(failingCache.failedResources).toBeGreaterThan(0);
  cooling.dispose();
});

it('exposes capacity as a typed error and keeps ordinary validation as RangeError', () => {
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, 2);
  let error: unknown;
  try { cache.take('https://example.test/chunk', WIND_NUMERIC_BYTES + 1, Date.now() + 1000); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(WindCapacityError);
  expect((error as WindCapacityError).code).toBe('capacity');
  expect(() => new WindDataCache(1024, 1)).toThrow(RangeError);
});


it('prepares a quantized rendered lattice once per height and extent', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
  const sample = vi.spyOn(source, 'sample');
  const first = source.prepare('surface', 4)!;
  expect(first.size).toBe(4);
  expect(first.bounds).toEqual([...bounds]);
  expect(sample).toHaveBeenCalledTimes(16);
  expect(first.data.some(byte => byte !== 0)).toBe(true);
  expect(source.prepare('surface', 4)).toBe(first);
  expect(sample).toHaveBeenCalledTimes(16);
  const agl = source.prepare(450, 4)!;
  expect(agl).not.toBe(first);
  expect(sample).toHaveBeenCalledTimes(32);
  source.dispose();
});


it('prepares one coherent longitude interval across the dateline', () => {
  for (const bounds of [[179.85, 0, -179.85, 1], [179.85, 0, 180.15, 1]] as const) {
    const prepared = preparedBounds(bounds);
    expect(prepared[2] - prepared[0]).toBeCloseTo(0.3, 6);
    expect((prepared[0] + prepared[2]) / 2).toBeGreaterThanOrEqual(-180);
    expect((prepared[0] + prepared[2]) / 2).toBeLessThanOrEqual(180);
  }
  expect(preparedBounds([-1, -1, 2, 2])).toEqual([-1, -1, 2, 2]);
});

it('shares descriptor and chunk acquisitions across six concurrent sources', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  let releaseDescriptor!: () => void, releaseChunks!: () => void;
  const descriptorGate = new Promise<void>(resolve => { releaseDescriptor = resolve; });
  const chunkGate = new Promise<void>(resolve => { releaseChunks = resolve; });
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) {
      await descriptorGate;
      return new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } });
    }
    await chunkGate;
    return reply(path.includes('/wind/') ? wind : fine);
  });
  const sources = Array.from({ length: 6 }, () => new WindDataSource('https://api.test', { fetchImpl: fetcher, cache }));
  const loads = sources.map(source => source.load({ build: pinned, frame, bounds }));
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    releaseDescriptor();
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('/wind/'))).toBe(true));
    releaseChunks();
    expect(await Promise.all(loads)).toEqual(Array(6).fill('ready'));
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}`,
      `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}/fine/0`,
      `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}/wind/0`
    ].sort());
    expect(cache.allocatedBytes).toBe(WIND_FRAME_LIMIT + wind.length + fine.length);
    for (const source of sources) expect(source.sample(0.5, 0.5, 450)).toEqual({ status: 'valid', u: 3, v: 6 });
  } finally {
    releaseDescriptor(); releaseChunks();
    sources.forEach(source => source.dispose());
    await Promise.allSettled(loads);
    cache.clear();
  }
});

it('keeps a shared acquisition alive until its last consumer cancels', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const first = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  const second = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  const loads = [first.load({ build: pinned, frame, bounds }), second.load({ build: pinned, frame, bounds })];
  const settled = Promise.allSettled(loads);
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    first.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(signals.filter(signal => signal.aborted)).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledOnce();
    second.dispose();
    await settled;
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(cache.allocatedBytes).toBe(0);
  } finally {
    first.dispose(); second.dispose();
    await settled;
    cache.clear();
  }
});

it('rolls back complete view admission before starting chunks and retries after capacity is released', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const cache = new WindDataCache(WIND_FRAME_LIMIT + wind.length + fine.length, 8);
  const blocker = cache.take('blocker', fine.length, pinned.expiresAtMs);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  try {
    const first = await Promise.allSettled([source.load({ build: pinned, frame, bounds })]);
    const firstCalls = fetcher.mock.calls.length, firstBytes = cache.allocatedBytes;
    cache.release(blocker);
    expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
    expect(source.sample(0.5, 0.5, 450)).toEqual({ status: 'valid', u: 3, v: 6 });
    expect(first[0]).toMatchObject({ status: 'rejected', reason: expect.any(WindCapacityError) });
    expect(firstCalls).toBe(1);
    expect(firstBytes).toBe(fine.length + WIND_FRAME_LIMIT);
  } finally { source.dispose(); cache.clear(); }
});

it('reuses bounded field samplers per source and height without changing point samples', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  try {
    expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
    expect(source.hasField(450)).toBe(false);
    const surface = source.field('surface'), agl = source.field(450), lift = source.field('lift');
    expect(source.hasField(450)).toBe(true);
    expect(source.field('surface')).toBe(surface);
    expect(source.field(450)).toBe(agl);
    expect(source.field('lift')).toBe(lift);
    expect(agl).not.toBe(surface);
    expect(agl.sample(0.5, 0.5)).toEqual({ status: STATUS_VALID, u: 3, v: 6 });
    expect(source.sample(0.5, 0.5, 450)).toEqual({ status: 'valid', u: 3, v: 6 });
    for (let height = 0; height < 20; height++) source.field(height);
    expect(source.hasField(450)).toBe(false);
    const usage = (source as WindDataSource & { memoryUsage(): { fieldSamplerBytes: number } }).memoryUsage();
    expect(usage.fieldSamplerBytes).toBeGreaterThan(0);
    expect(usage.fieldSamplerBytes).toBeLessThanOrEqual(4 * 8192 * (8 + 8 + 1));
  } finally { source.dispose(); }
});

it('uses bounded scheduler handles for descriptor and exact chunk lengths', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const requests: Array<ForecastRequestSpec & { init?: RequestInit }> = [];
  const request = (spec: ForecastRequestSpec & { init?: RequestInit }): ForecastRequestHandle => {
    requests.push(spec);
    const response = spec.url.endsWith(`/data/${frame}`)
      ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
      : reply(spec.url.includes('/wind/') ? wind : fine);
    return { response: Promise.resolve(response), settled: Promise.resolve(), promote() {}, cancel() {} };
  };
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unbounded fetch used'); }));
  const source = new WindDataSource('https://api.test', { request, priority: 'background' } as ConstructorParameters<typeof WindDataSource>[1]);
  try {
    expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
    expect(requests).toHaveLength(3);
    const desc = requests.find(spec => spec.url.endsWith(`/data/${frame}`))!;
    expect(desc).toMatchObject({ kind: 'json', priority: 'background', maxResponseBytes: WIND_FRAME_LIMIT });
    expect(desc.expectedResponseBytes).toBeUndefined();
    for (const spec of requests) {
      expect(spec.init?.redirect).toBe('error');
      if (spec.kind === 'json') continue;
      const bytes = spec.url.includes('/wind/') ? wind.length : fine.length;
      expect(spec).toMatchObject({ kind: 'wind', priority: 'background', maxResponseBytes: bytes, expectedResponseBytes: bytes });
    }
  } finally { source.dispose(); }
});

it('binds scheduler span limits to the sum of validated tile lengths', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.wind[0].count = 8; metadata.wind[0].bytes = 8 * globalWind.length;
  metadata.fine[0].count = 2; metadata.fine[0].bytes = 2 * globalFine.length;
  const requests: ForecastRequestSpec[] = [];
  const request = (spec: ForecastRequestSpec): ForecastRequestHandle => {
    requests.push(spec);
    let response: Response;
    if (spec.kind === 'json') response = new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
    else {
      const [first, last = first] = spec.url.split('/').at(-1)!.split('-').map(Number);
      const tile = spec.url.includes('/wind/') ? globalWind : globalFine;
      const bytes = new Uint8Array((last! - first! + 1) * tile.length);
      for (let offset = 0; offset < bytes.length; offset += tile.length) bytes.set(tile, offset);
      response = reply(bytes);
    }
    return { response: Promise.resolve(response), settled: Promise.resolve(), promote() {}, cancel() {} };
  };
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unbounded fetch used'); }));
  const source = new WindDataSource('https://api.test', { request, coalesceSpans: true } as ConstructorParameters<typeof WindDataSource>[1]);
  try {
    expect(await source.load({ build: pinned, frame, bounds: [0, 0, 127, 1] })).toBe('ready');
    const chunks = requests.filter(spec => spec.kind === 'wind');
    expect(chunks.some(spec => /\/\d+-\d+$/.test(spec.url))).toBe(true);
    for (const spec of chunks) {
      const [first, last = first] = spec.url.split('/').at(-1)!.split('-').map(Number);
      const bytes = (last! - first! + 1) * (spec.url.includes('/wind/') ? globalWind.length : globalFine.length);
      expect(spec.maxResponseBytes).toBe(bytes);
      expect(spec.expectedResponseBytes).toBe(bytes);
    }
  } finally { source.dispose(); }
});

it('rejects an inconsistent descriptor layout before requesting any chunks', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const metadata = JSON.parse(descriptor(frame));
  metadata.wind[0].bytes++;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } }));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  try {
    await expect(source.load({ build: pinned, frame, bounds })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { source.dispose(); }
});

it('promotes active and queued handles and future chunks without restarting a load', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.wind[0].count = 8; metadata.wind[0].bytes = 8 * globalWind.length;
  metadata.fine[0].count = 2; metadata.fine[0].bytes = 2 * globalFine.length;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: Array<{ spec: ForecastRequestSpec; promote: ReturnType<typeof vi.fn> }> = [];
  const request = (spec: ForecastRequestSpec): ForecastRequestHandle => {
    const promote = vi.fn();
    requests.push({ spec, promote });
    const response = spec.kind === 'json'
      ? Promise.resolve(new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } }))
      : gate.then(() => reply(spec.url.includes('/wind/') ? globalWind : globalFine));
    return { response, settled: Promise.resolve(), promote, cancel() {} };
  };
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unbounded fetch used'); }));
  const source = new WindDataSource('https://api.test', { request, priority: 'background', coalesceSpans: false } as ConstructorParameters<typeof WindDataSource>[1]);
  const load = source.load({ build: pinned, frame, bounds: [0, 0, 127, 1] });
  const settled = Promise.allSettled([load]);
  try {
    await vi.waitFor(() => expect(requests.filter(item => item.spec.kind === 'wind')).toHaveLength(4));
    const inFlight = requests.filter(item => item.spec.kind === 'wind');
    (source as WindDataSource & { promote(): void }).promote();
    for (const item of inFlight) expect(item.promote).toHaveBeenCalledOnce();
    release();
    expect(await load).toBe('ready');
    expect(requests.filter(item => item.spec.kind === 'wind')).toHaveLength(10);
    expect(requests.slice(5).every(item => item.spec.priority === 'foreground')).toBe(true);
    expect(new Set(requests.map(item => item.spec.url)).size).toBe(requests.length);
  } finally { release(); source.dispose(); await settled; }
});

it('does not allocate or fetch overlapping pending tiles twice across spans', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.wind[0].count = 8; metadata.wind[0].bytes = 8 * globalWind.length;
  metadata.fine[0].count = 2; metadata.fine[0].bytes = 2 * globalFine.length;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
    await gate;
    const [first, last = first] = path.split('/').at(-1)!.split('-').map(Number);
    const tile = path.includes('/wind/') ? globalWind : globalFine;
    const bytes = new Uint8Array((last! - first! + 1) * tile.length);
    for (let offset = 0; offset < bytes.length; offset += tile.length) bytes.set(tile, offset);
    return reply(bytes);
  });
  const sources = Array.from({ length: 2 }, () => new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, coalesceSpans: true }));
  const loads = [sources[0]!.load({ build: pinned, frame, bounds: [0, 0, 64, 1] }), sources[1]!.load({ build: pinned, frame, bounds: [48, 0, 127, 1] })];
  try {
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => /\/(wind|fine)\//.test(String(url)))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    expect(await Promise.all(loads)).toEqual(['ready', 'ready']);
    const tiles: string[] = [];
    for (const [url] of fetcher.mock.calls) {
      const match = String(url).match(/\/(wind|fine)\/(\d+)(?:-(\d+))?$/);
      if (!match) continue;
      for (let tile = Number(match[2]); tile <= Number(match[3] ?? match[2]); tile++) tiles.push(`${match[1]}/${tile}`);
    }
    expect(new Set(tiles).size).toBe(tiles.length);
    expect(cache.allocatedBytes).toBe(WIND_FRAME_LIMIT + 8 * globalWind.length + 2 * globalFine.length);
    expect(sources[0]!.sample(0, 50, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
    expect(sources[1]!.sample(0, 50, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
  } finally { release(); sources.forEach(source => source.dispose()); await Promise.allSettled(loads); cache.clear(); }
});

it('charges shared numeric backing once and retains prepared arrays while callers hold them', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, budget = createPreparationBudget(1024 * 1024);
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const sources = Array.from({ length: 2 }, () => new WindDataSource('https://api.test', { fetchImpl: fetcher, cache }));
  try {
    expect(await Promise.all(sources.map(source => source.load({ build: pinned, frame, bounds })))).toEqual(['ready', 'ready']);
    const numeric = WIND_FRAME_LIMIT + wind.length + fine.length;
    expect(budget.snapshot()['wind-numeric']).toBe(numeric);
    const sampler = sources[0]!.field('surface');
    expect(budget.snapshot()['wind-sampler']).toBe(8192 * 17);
    const grid = sources[0]!.prepare('surface', 4)!;
    const releaseGrid = grid.retain!();
    expect(budget.snapshot()['wind-prepared']).toBe(grid.data.byteLength);
    sources.forEach(source => source.dispose());
    cache.clear();
    expect(sampler.sample(0.5, 0.5)).toEqual({ status: 2, u: null, v: null });
    expect(budget.used).toBe(grid.data.byteLength);
    expect(sources[0]!.memoryUsage().preparedBytes).toBe(grid.data.byteLength);
    expect(grid.data.some(byte => byte !== 0)).toBe(true);
    releaseGrid(); releaseGrid();
    expect(budget.used).toBe(0);
    expect(sources[0]!.memoryUsage().preparedBytes).toBe(0);
    expect(() => grid.retain!()).toThrow('Wind prepared grid is released');
  } finally { sources.forEach(source => source.dispose()); cache.clear(); }
});

it('rolls back shared budget claims after failed whole-view admission', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const budget = createPreparationBudget(WIND_FRAME_LIMIT + wind.length + fine.length - 1);
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  try {
    await expect(source.load({ build: pinned, frame, bounds })).rejects.toBeInstanceOf(WindCapacityError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(WIND_FRAME_LIMIT);
    source.dispose(); cache.clear();
    expect(budget.used).toBe(0);
  } finally { source.dispose(); cache.clear(); }
});

it('keeps a joined consumer usable when another source is cancelled', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    signals.push(init!.signal!);
    if (String(url).endsWith(`/data/${frame}`)) {
      await gate;
      init!.signal!.throwIfAborted();
      return new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } });
    }
    return reply(String(url).includes('/wind/') ? wind : fine);
  });
  const first = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  const second = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  const one = first.load({ build: pinned, frame, bounds }), two = second.load({ build: pinned, frame, bounds });
  const rejected = expect(one).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    first.dispose();
    await rejected;
    expect(signals[0]!.aborted).toBe(false);
    release();
    expect(await two).toBe('ready');
    expect(second.sample(0.5, 0.5, 450)).toEqual({ status: 'valid', u: 3, v: 6 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { release(); first.dispose(); second.dispose(); await Promise.allSettled([one, two]); cache.clear(); }
});

it('keeps native quality when it fits and uses a cheaper supported overview for a constrained horizon', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [-128, 0, 127, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 256, height: 1, lon0: -128 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4].map(stride => ({ stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: 1, bytes: 1 }] }));
  const overview = new Uint8Array(32 * 32 * WIND_OVERVIEW_CELL_BYTES);
  const overviewView = new DataView(overview.buffer);
  for (let cell = 0; cell < 32 * 32; cell++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
    const offset = cell * WIND_OVERVIEW_CELL_BYTES + mode * 9;
    overviewView.setFloat32(offset, 7, true); overviewView.setFloat32(offset + 4, 8, true); overviewView.setUint8(offset + 8, STATUS_VALID);
  }
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } });
    if (path.includes('/overview-')) return reply(overview);
    return reply(path.includes('/wind/') ? globalWind : globalFine);
  });
  const native = new WindDataSource('https://api.test', { fetchImpl: fetcher, horizon: 30 });
  const horizon = new WindDataSource('https://api.test', { fetchImpl: fetcher, horizon: 30, overviewForHorizon: true });
  try {
    expect(await native.load({ build: pinned, frame, bounds: [-128, 0, 127, 1] })).toBe('ready');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/wind/'))).toBe(true);
    expect(native.sample(0, 0, 450)).toEqual({ status: 'valid', u: 3, v: 6 });
    fetcher.mockClear();
    expect(await horizon.load({ build: pinned, frame, bounds: [-128, 0, 127, 1] })).toBe('ready');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/overview-4/'))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/wind/'))).toBe(false);
    expect(horizon.sample(0, 0, 1500)).toEqual({ status: 'valid', u: 7, v: 8 });
    expect(horizon.sample(0, 0, 450)).toEqual({ status: 'unavailable', u: null, v: null });
  } finally { native.dispose(); horizon.dispose(); }
});

it('accounts for shared-budget pressure and restores native quality after release', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [-128, 0, 127, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 256, height: 1, lon0: -128 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4].map(stride => ({ stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: 1, bytes: 1 }] }));
  const overview = new Uint8Array(32 * 32 * WIND_OVERVIEW_CELL_BYTES);
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } });
    return reply(path.includes('/overview-') ? overview : path.includes('/wind/') ? globalWind : globalFine);
  });
  const budget = createPreparationBudget(WIND_NUMERIC_BYTES), blocker = budget.reserve('raster', 5 * 1024 * 1024)!;
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const first = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, horizon: 10, overviewForHorizon: true });
  const second = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, horizon: 10, overviewForHorizon: true });
  try {
    expect(await first.load({ build: pinned, frame, bounds: [-128, 0, 127, 1] })).toBe('ready');
    expect(first.isOverview).toBe(true);
    first.dispose(); blocker.release();
    expect(await second.load({ build: pinned, frame, bounds: [-128, 0, 127, 1] })).toBe('ready');
    expect(second.isOverview).toBe(false);
  } finally { first.dispose(); second.dispose(); blocker.release(); cache.clear(); }
});

it.each(['numeric', 'shared'] as const)('loads a usable selected overview when the full horizon exceeds the %s budget', async constrained => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [-128, 0, 127, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 256, height: 1, lon0: -128 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4].map(stride => ({ stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: 1, bytes: 1 }] }));
  const overview = new Uint8Array(32 * 32 * WIND_OVERVIEW_CELL_BYTES);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } })
    : reply(overview));
  const budget = createPreparationBudget(constrained === 'shared' ? 512 * 1024 : WIND_WINDOW_BYTES);
  const cache = new WindDataCache(constrained === 'numeric' ? 512 * 1024 : WIND_WINDOW_BYTES, WIND_WINDOW_ENTRIES, budget);
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, horizon: 40, overviewForHorizon: true });
  try {
    expect(await source.load({ build: pinned, frame, bounds: [-128, 0, 127, 1] })).toBe('ready');
    expect(source.isOverview).toBe(true);
    expect(fetcher.mock.calls.slice(1).map(([url]) => String(url).split('/').slice(-2).join('/'))).toEqual(['overview-4/0', 'overview-4/1']);
    expect(source.prepare('surface')).not.toBeNull();
    expect(source.field('surface').sample(0, 0)).toEqual({ status: STATUS_VALID, u: 0, v: 0 });
    expect(cache.allocatedBytes).toBe(WIND_FRAME_LIMIT + 2 * overview.length);
    expect(budget.used).toBeLessThanOrEqual(budget.limit);
  } finally { source.dispose(); cache.clear(); }
  expect(budget.used).toBe(0);
});

it('counts shared pending horizon backing once even with several source leases', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, other = `${frame}-other`;
  pinned.manifest.frames.push({ ...pinned.manifest.frames[0], id: other });
  const perFrame = WIND_FRAME_LIMIT + wind.length + fine.length;
  const budget = createPreparationBudget((perFrame + wind.length + fine.length) * 2), cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`) || path.endsWith(`/data/${other}`)) {
      return new Response(descriptor(path.endsWith(`/data/${frame}`) ? frame : other), { headers: { 'content-type': 'application/json' } });
    }
    await gate;
    return reply(path.includes('/wind/') ? wind : fine);
  });
  const sources = Array.from({ length: 3 }, () => new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, horizon: 2 }));
  const loads = sources.map((source, index) => source.load({ build: pinned, frame: index === 2 ? other : frame, bounds }));
  const settled = Promise.allSettled(loads);
  try {
    await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/wind/'))).toHaveLength(2));
    expect(budget.used).toBe((perFrame + wind.length + fine.length) * 2);
    expect(sources[0]!.memoryUsage().horizonNumericRemaining).toBe(0);
    release();
    expect(await Promise.all(loads)).toEqual(['ready', 'ready', 'ready']);
    expect(fetcher).toHaveBeenCalledTimes(6);
  } finally { release(); sources.forEach(source => source.dispose()); await settled; cache.clear(); }
  expect(budget.used).toBe(0);
});

it('releases failed detail claims before choosing an overview under a tight budget', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, metadata = JSON.parse(descriptor(frame));
  const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 2);
  metadata.overview = [{ stride: 2, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.chunkBytes * layout.count }] }];
  const budget = createPreparationBudget(WIND_FRAME_LIMIT + 2 * layout.chunkBytes);
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
    if (path.includes('/wind/')) return new Response(null, { status: 404 });
    return reply(path.includes('/overview-') ? new Uint8Array(layout.chunkBytes) : fine);
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  try {
    expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
    expect(source.isOverview).toBe(true);
    expect(budget.used).toBe(WIND_FRAME_LIMIT + layout.chunkBytes);
  } finally { source.dispose(); cache.clear(); }
  expect(budget.used).toBe(0);
});

it('releases evicted and disposed borrowed grids without garbage collection', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, gridBytes = 32 * 32 * 4;
  const numeric = WIND_FRAME_LIMIT + wind.length + fine.length;
  const budget = createPreparationBudget(numeric + wind.length + fine.length), cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  try {
    expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
    const grids: Array<NonNullable<ReturnType<WindDataSource['prepare']>>> = [];
    for (let height = 0; height < 20; height++) {
      grids.push(source.prepare(height, 32)!);
      expect(budget.used).toBeLessThanOrEqual(numeric + 4 * gridBytes);
    }
    expect(budget.used).toBe(numeric + 4 * gridBytes);
    expect(() => grids[0]!.retain!()).toThrow('Wind prepared grid is released');
    source.dispose(); cache.clear();
    expect(budget.used).toBe(0);
    expect(source.memoryUsage().preparedBytes).toBe(0);
  } finally { source.dispose(); cache.clear(); }
});

it('does not report expired prepared data as ready even after sampling clears the current view', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  try {
    expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
    expect(source.prepare('surface', 4)).not.toBeNull();
    expect(source.hasPrepared('surface', 4)).toBe(true);
    pinned.expiresAtMs = Date.now() - 1;
    expect(source.hasPrepared('surface', 4)).toBe(false);
    expect(source.sample(0.5, 0.5, 'surface').status).toBe('unavailable');
    expect(source.hasPrepared('surface', 4)).toBe(false);
  } finally { source.dispose(); }
});

it('stops unshared detail followers promptly after a missing chunk and falls back to overview', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4].map(stride => ({ stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: 1, bytes: 1 }] }));
  const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 4);
  const started: string[] = [], cancelled: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url); started.push(path);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/wind/0')) return new Response(null, { status: 404 });
    if (path.includes('/overview-')) return reply(new Uint8Array(layout.chunkBytes));
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { cancelled.push(path); reject(init!.signal!.reason); }, { once: true });
    });
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, coalesceSpans: false });
  try {
    expect(await source.load({ build: pinned, frame, bounds: [0, 0, 127, 1] })).toBe('ready');
    expect(source.isOverview).toBe(true);
    expect(started.filter(path => /\/wind\//.test(path))).toHaveLength(4);
    expect(cancelled).toHaveLength(3);
    expect(started.some(path => /\/wind\/[4-7]$/.test(path))).toBe(false);
  } finally { source.dispose(); }
});

it('fails one source promptly without cancelling a different consumer of shared chunks', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, cache = new WindDataCache();
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4].map(stride => ({ stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: 1, bytes: 1 }] }));
  const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 4);
  let fail!: () => void, release!: () => void;
  const failureGate = new Promise<void>(resolve => { fail = resolve; });
  const chunkGate = new Promise<void>(resolve => { release = resolve; });
  const signals = new Map<string, AbortSignal>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } });
    if (path.includes('/overview-')) return reply(new Uint8Array(layout.chunkBytes));
    signals.set(path, init!.signal!);
    if (path.endsWith('/wind/0')) { await failureGate; return new Response(null, { status: 404 }); }
    await Promise.race([chunkGate, new Promise<never>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))]);
    init!.signal!.throwIfAborted();
    return reply(path.includes('/wind/') ? globalWind : globalFine);
  });
  const first = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, coalesceSpans: false });
  const second = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache, coalesceSpans: false });
  const one = first.load({ build: pinned, frame, bounds: [0, 0, 127, 1] });
  const two = second.load({ build: pinned, frame, bounds: [48, 0, 64, 1] });
  const settled = Promise.allSettled([one, two]);
  try {
    await vi.waitFor(() => expect([...signals.keys()].some(path => path.endsWith('/wind/2'))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    fail();
    expect(await Promise.race([one, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fallback stalled')), 1000))])).toBe('ready');
    expect(first.isOverview).toBe(true);
    const shared = [...signals.entries()].find(([path]) => path.endsWith('/wind/2'))!;
    expect(shared[1].aborted).toBe(false);
    release();
    expect(await two).toBe('ready');
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/wind/2'))).toHaveLength(1);
  } finally { fail(); release(); first.dispose(); second.dispose(); await settled; cache.clear(); }
});

it('waits for unshared aborted bodies before replanning a missing detail chunk', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4].map(stride => ({ stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: 1, bytes: 1 }] }));
  const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 4);
  const budget = createPreparationBudget(2 * 1024 * 1024);
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget), take = vi.spyOn(cache, 'take');
  let fail!: () => void;
  const failed = new Promise<void>(resolve => { fail = resolve; });
  const cancels: Array<() => void> = [];
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/wind/0')) { await failed; return new Response(null, { status: 404 }); }
    if (path.includes('/overview-')) return reply(new Uint8Array(layout.chunkBytes));
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(resolve => { cancels.push(resolve); }) }), { headers: { 'content-type': 'application/octet-stream' } });
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetcher, budget });
  const source = new WindDataSource('https://api.test', { budget, cache, request: spec => scheduler.request(spec), coalesceSpans: false });
  const sharedSource = new WindDataSource('https://api.test', { budget, cache, request: spec => scheduler.request(spec), coalesceSpans: false });
  const pending = source.load({ build: pinned, frame, bounds: [0, 0, 127, 1] });
  let shared: Promise<'ready' | 'unavailable'> | undefined;
  let pressure: ReturnType<typeof budget.reserve> = null;
  try {
    await Promise.race([vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/wind/')).length).toBe(4)), pending.then(value => { throw new Error(`unexpected ${value}`); })]);
    shared = sharedSource.load({ build: pinned, frame, bounds: [34, 0, 42, 1] });
    void shared.catch(() => {});
    await vi.waitFor(() => expect(take.mock.calls.filter(([url]) => url.endsWith('/wind/2')).length).toBe(2));
    pressure = budget.reserve('other', budget.limit - budget.used - 2 * layout.chunkBytes - 2 * globalFine.length);
    expect(pressure).not.toBeNull();
    fail();
    await vi.waitFor(() => expect(cancels).toHaveLength(2));
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/overview-'))).toBe(false);
    cancels.forEach(resolve => resolve());
    expect(await pending).toBe('ready');
    expect(source.isOverview).toBe(true);
    expect(cancels).toHaveLength(2);
  } finally {
    pressure?.release(); fail(); source.dispose(); sharedSource.dispose(); scheduler.dispose();
    await Promise.resolve(); cancels.forEach(resolve => resolve());
    await Promise.allSettled([pending, ...(shared ? [shared] : [])]); cache.clear();
  }
  expect(budget.used).toBe(0);
});

it('drains newly unshared cancellation while another shared body stays live', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4].map(stride => ({ stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: 1, bytes: 1 }] }));
  const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 4);
  const budget = createPreparationBudget(2 * 1024 * 1024), cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const take = vi.spyOn(cache, 'take'), cancellations = new Map<string, () => void>();
  let fail!: () => void;
  const failed = new Promise<void>(resolve => { fail = resolve; });
  const signals = new Map<string, AbortSignal>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/wind/0')) { await failed; return new Response(null, { status: 404 }); }
    if (path.includes('/overview-')) return reply(new Uint8Array(layout.chunkBytes));
    signals.set(path, init!.signal!);
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(resolve => { cancellations.set(path, resolve); }) }), { headers: { 'content-type': 'application/octet-stream' } });
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetcher, budget });
  const create = () => new WindDataSource('https://api.test', { budget, cache, request: spec => scheduler.request(spec), coalesceSpans: false });
  const first = create(), departing = create(), retained = create();
  const one = first.load({ build: pinned, frame, bounds: [0, 0, 127, 1] });
  let two: Promise<'ready' | 'unavailable'> | undefined, three: Promise<'ready' | 'unavailable'> | undefined;
  let outcome = 'pending', pressure: ReturnType<typeof budget.reserve> = null;
  void one.then(() => { outcome = 'ready'; }, () => { outcome = 'failed'; });
  try {
    await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/wind/')).length).toBe(4));
    two = departing.load({ build: pinned, frame, bounds: [34, 0, 42, 1] }); void two.catch(() => {});
    three = retained.load({ build: pinned, frame, bounds: [50, 0, 58, 1] }); void three.catch(() => {});
    await vi.waitFor(() => expect(take.mock.calls.filter(([url]) => url.endsWith('/wind/3')).length).toBe(2));
    pressure = budget.reserve('other', budget.limit - budget.used - 2 * layout.chunkBytes - 2 * globalFine.length);
    expect(pressure).not.toBeNull();
    fail();
    await vi.waitFor(() => expect([...cancellations.keys()].some(path => path.endsWith('/wind/1'))).toBe(true));
    departing.dispose();
    await vi.waitFor(() => expect([...cancellations.keys()].some(path => path.endsWith('/wind/2'))).toBe(true));
    const before = budget.used;
    [...cancellations.entries()].find(([path]) => path.endsWith('/wind/1'))![1]();
    await vi.waitFor(() => expect(budget.used).toBeLessThan(before));
    await Promise.resolve(); await Promise.resolve();
    expect(outcome).toBe('pending');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/overview-'))).toBe(false);
    expect([...signals.entries()].find(([path]) => path.endsWith('/wind/3'))![1].aborted).toBe(false);
    [...cancellations.entries()].find(([path]) => path.endsWith('/wind/2'))![1]();
    expect(await one).toBe('ready');
    expect(first.isOverview).toBe(true);
  } finally {
    pressure?.release(); fail(); first.dispose(); departing.dispose(); retained.dispose(); scheduler.dispose();
    await Promise.resolve(); for (const release of cancellations.values()) release();
    await Promise.allSettled([one, ...(two ? [two] : []), ...(three ? [three] : [])]); cache.clear();
  }
  expect(budget.used).toBe(0);
});

it('cancels unstarted lane followers without waiting for a shared predecessor', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const cache = new WindDataCache(), take = vi.spyOn(cache, 'take');
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>(), signals = new Map<string, AbortSignal>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, JSON.parse(descriptor(frame))), { headers: { 'content-type': 'application/json' } });
    signals.set(path, init!.signal!);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.set(path, controller); } }), { headers: { 'content-type': 'application/octet-stream' } });
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetcher });
  const first = new WindDataSource('https://api.test', { cache, request: spec => scheduler.request(spec), coalesceSpans: false });
  const second = new WindDataSource('https://api.test', { cache, request: spec => scheduler.request(spec), coalesceSpans: false });
  const one = first.load({ build: pinned, frame, bounds: [0, 0, 127, 1] });
  const two = second.load({ build: pinned, frame, bounds: [0, 0, 10, 1] });
  const outcome = Promise.allSettled([one, two]);
  try {
    await vi.waitFor(() => expect(take.mock.calls.filter(([url]) => url.endsWith('/wind/0')).length).toBe(2));
    await vi.waitFor(() => expect([...signals.keys()].some(path => path.endsWith('/wind/3'))).toBe(true));
    first.dispose();
    expect(await Promise.race([one.then(() => 'ready', () => 'cancelled'), new Promise<string>(resolve => setTimeout(() => resolve('stalled'), 1000))])).toBe('cancelled');
    const shared = [...signals.entries()].find(([path]) => path.endsWith('/wind/0'))!;
    expect(shared[1].aborted).toBe(false);
    expect([...signals.keys()].some(path => path.endsWith('/wind/4'))).toBe(false);
    for (const [path, controller] of streams) if (!signals.get(path)!.aborted) { controller.enqueue(path.includes('/wind/') ? globalWind : globalFine); controller.close(); }
    expect(await two).toBe('ready');
  } finally { first.dispose(); second.dispose(); scheduler.dispose(); await outcome; cache.clear(); }
});

it('dispatches later lanes at live priority while retaining a different foreground owner', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const cache = new WindDataCache(), take = vi.spyOn(cache, 'take');
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>(), signals = new Map<string, AbortSignal>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith(`/data/${frame}`)) return new Response(layoutDescriptor(pinned, JSON.parse(descriptor(frame))), { headers: { 'content-type': 'application/json' } });
    signals.set(path, init!.signal!);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.set(path, controller); } }), { headers: { 'content-type': 'application/octet-stream' } });
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetcher });
  const request = vi.fn((spec: ForecastRequestSpec) => scheduler.request(spec));
  const first = new WindDataSource('https://api.test', { cache, request, coalesceSpans: false });
  const second = new WindDataSource('https://api.test', { cache, request, coalesceSpans: false });
  const one = first.load({ build: pinned, frame, bounds: [0, 0, 127, 1] });
  const two = second.load({ build: pinned, frame, bounds: [0, 0, 10, 1] });
  const outcomes = Promise.allSettled([one, two]);
  try {
    await vi.waitFor(() => expect(take.mock.calls.filter(([url]) => url.endsWith('/wind/0')).length).toBe(2));
    await vi.waitFor(() => expect([...streams.keys()].some(path => path.endsWith('/wind/3'))).toBe(true));
    const shared = [...streams.entries()].find(([path]) => path.endsWith('/wind/0'))!;
    first.setPriority('background');
    expect(signals.get(shared[0])!.aborted).toBe(false);
    shared[1].enqueue(globalWind); shared[1].close();
    await vi.waitFor(() => expect(request.mock.calls.some(([spec]) => spec.url.endsWith('/wind/4'))).toBe(true));
    expect(request.mock.calls.find(([spec]) => spec.url.endsWith('/wind/4'))![0].priority).toBe('background');
    expect(request.mock.calls.find(([spec]) => spec.url.endsWith('/wind/0'))![0].priority).toBe('foreground');
    expect(signals.get(shared[0])!.aborted).toBe(false);
  } finally { first.dispose(); second.dispose(); scheduler.dispose(); await outcomes; cache.clear(); }
});

it('frees unissued foreground wind claims on demotion so a new selected request can start', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, MiB = 1024 * 1024;
  pinned.manifest.descriptors.bounds = [0, 0, 128, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 128, height: 1, lon0: 0 });
  const budget = createPreparationBudget(28 * MiB, { foregroundReserveBytes: 24 * MiB });
  const background = budget.reserve('background', 4 * MiB, 'background')!;
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const fetcher = vi.fn<typeof fetch>((url, init) => {
    if (String(url).endsWith(`/data/${frame}`)) return Promise.resolve(new Response(layoutDescriptor(pinned, JSON.parse(descriptor(frame))), { headers: { 'content-type': 'application/json' } }));
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  });
  const scheduler = createForecastRequestScheduler({ fetchImpl: fetcher, budget });
  const source = new WindDataSource('https://api.test', { cache, budget, request: spec => scheduler.request(spec), coalesceSpans: false });
  const pending = source.load({ build: pinned, frame, bounds: [0, 0, 127, 1] });
  const outcomes = Promise.allSettled([pending]);
  let selected: ReturnType<typeof scheduler.request> | undefined;
  try {
    await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/wind/'))).toHaveLength(4));
    scheduler.setForegroundPending(1, true);
    expect(cache.allocatedBytes).toBe(WIND_FRAME_LIMIT + 4 * globalWind.length);
    const before = budget.used, required = budget.limit - before;
    source.setPriority('background');
    expect(budget.used).toBe(before);
    selected = scheduler.request({ url: 'https://api.test/selected', kind: 'json', priority: 'foreground', maxResponseBytes: required });
    void selected.response.catch(() => {});
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/selected'))).toBe(true));
  } finally {
    selected?.cancel(); source.dispose(); scheduler.dispose(); await outcomes;
    if (selected) await selected.settled;
    cache.clear(); background.release();
  }
  expect(budget.used).toBe(0);
});

it.each(['release', 'promote'] as const)('parks unissued background lanes and resumes the same load on %s', async action => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, MiB = 1024 * 1024;
  const budget = createPreparationBudget(2 * MiB, { foregroundReserveBytes: MiB });
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const root = `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}`;
  const desc = cache.take(root, WIND_FRAME_LIMIT, pinned.expiresAtMs, false);
  const bytes = new TextEncoder().encode(descriptor(frame)); desc.bytes.set(bytes); desc.used = bytes.length; cache.release(desc);
  const pressure = budget.reserve('other', MiB - WIND_FRAME_LIMIT - 1, 'background')!;
  const fetcher = vi.fn<typeof fetch>(async url => reply(String(url).includes('/wind/') ? wind : fine));
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: fetcher });
  const subscriptions = vi.spyOn(budget, 'onRelease');
  const source = new WindDataSource('https://api.test', { cache, budget, priority: 'background', request: spec => scheduler.request(spec), coalesceSpans: false });
  const pending = source.load({ build: pinned, frame, bounds });
  const outcome = Promise.allSettled([pending]);
  try {
    await vi.waitFor(() => expect(subscriptions).toHaveBeenCalledTimes(2));
    expect(cache.allocatedBytes).toBe(WIND_FRAME_LIMIT);
    expect(fetcher).not.toHaveBeenCalled();
    if (action === 'release') pressure.release(); else source.promote();
    expect(await pending).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { pressure.release(); source.dispose(); scheduler.dispose(); await outcome; cache.clear(); }
  expect(budget.used).toBe(0);
});

it('releases demoted wind working sets already queued behind another physical request', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, MiB = 1024 * 1024;
  const budget = createPreparationBudget(28 * MiB, { foregroundReserveBytes: 24 * MiB });
  const background = budget.reserve('other', 4 * MiB, 'background')!;
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const root = `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}`;
  const desc = cache.take(root, WIND_FRAME_LIMIT, pinned.expiresAtMs);
  const bytes = new TextEncoder().encode(descriptor(frame)); desc.bytes.set(bytes); desc.used = bytes.length; cache.release(desc);
  let finishBlocker!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>((url, init) => {
    const path = String(url);
    if (path.endsWith('/blocker')) return new Promise((resolve, reject) => { finishBlocker = resolve; init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); });
    if (!/\/(wind|fine|overview-\d+)\//.test(path)) return Promise.resolve(new Response(descriptor(path.slice(path.lastIndexOf('/') + 1)), { headers: { 'content-type': 'application/json' } }));
    return Promise.resolve(reply(path.includes('/wind/') ? wind : fine));
  });
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: fetcher, maxActive: 1 });
  const blocker = scheduler.request({ url: 'https://api.test/blocker', kind: 'json', priority: 'foreground', maxResponseBytes: 1024 });
  void blocker.response.catch(() => {});
  const source = new WindDataSource('https://api.test', { cache, budget, request: spec => scheduler.request(spec), coalesceSpans: false });
  const pending = source.load({ build: pinned, frame, bounds });
  const outcomes = Promise.allSettled([pending]);
  try {
    await vi.waitFor(() => expect(scheduler.stats()).toEqual({ active: 1, queued: 2 }));
    const before = budget.used;
    scheduler.setForegroundPending(1, true);
    source.setPriority('background');
    await vi.waitFor(() => expect(budget.used).toBeLessThan(before));
    expect(cache.allocatedBytes).toBe(WIND_FRAME_LIMIT);
    expect(fetcher).toHaveBeenCalledOnce();
    background.release(); scheduler.setForegroundPending(1, false);
    finishBlocker(new Response(null)); await blocker.response; await blocker.settled;
    expect(await pending).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { source.dispose(); blocker.cancel(); scheduler.dispose(); await outcomes; await blocker.settled; cache.clear(); background.release(); }
  expect(budget.used).toBe(0);
});

it('preserves shared foreground queued wind work through demotion and reselect', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, budget = createPreparationBudget(4 * 1024 * 1024);
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget), take = vi.spyOn(cache, 'take');
  const root = `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}`;
  const desc = cache.take(root, WIND_FRAME_LIMIT, pinned.expiresAtMs);
  const bytes = new TextEncoder().encode(descriptor(frame)); desc.bytes.set(bytes); desc.used = bytes.length; cache.release(desc);
  let finishBlocker!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>((url, init) => String(url).endsWith('/blocker')
    ? new Promise((resolve, reject) => { finishBlocker = resolve; init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); })
    : Promise.resolve(reply(String(url).includes('/wind/') ? wind : fine)));
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: fetcher, maxActive: 1 });
  const blocker = scheduler.request({ url: 'https://api.test/blocker', kind: 'json', priority: 'foreground', maxResponseBytes: 1024 });
  void blocker.response.catch(() => {});
  const handles: ForecastRequestHandle[] = [];
  const request = (spec: ForecastRequestSpec) => { const handle = scheduler.request(spec); handles.push(handle); return handle; };
  const first = new WindDataSource('https://api.test', { cache, budget, request, coalesceSpans: false });
  const second = new WindDataSource('https://api.test', { cache, budget, request, coalesceSpans: false });
  const one = first.load({ build: pinned, frame, bounds }), two = second.load({ build: pinned, frame, bounds });
  const outcomes = Promise.allSettled([one, two]);
  try {
    await vi.waitFor(() => expect(take.mock.calls.filter(([url]) => url.endsWith('/wind/0'))).toHaveLength(2));
    await vi.waitFor(() => expect(scheduler.stats().queued).toBe(2));
    const original = handles.map(handle => handle.response), before = budget.used;
    first.setPriority('background');
    expect(budget.used).toBe(before);
    expect(handles.map(handle => handle.response)).toEqual(original);
    expect(scheduler.stats().queued).toBe(2);
    second.setPriority('background');
    expect(budget.used).toBeLessThan(before);
    second.setPriority('foreground');
    finishBlocker(new Response(null)); await blocker.response; await blocker.settled;
    expect(await one).toBe('ready'); expect(await two).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { first.dispose(); second.dispose(); blocker.cancel(); scheduler.dispose(); await outcomes; await blocker.settled; cache.clear(); }
  expect(budget.used).toBe(0);
});

it('settles concurrent scheduler waves under an exactly bounded shared budget and retries after release', async () => {
  const pinned = build(), frames = pinned.manifest.frames.slice(0, 2).map(item => item.id);
  const budget = createPreparationBudget(2 * (WIND_FRAME_LIMIT + wind.length + fine.length) + 1024);
  const cache = new WindDataCache(WIND_NUMERIC_BYTES, WIND_WINDOW_ENTRIES, budget);
  const root = `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data`;
  const descriptors = frames.map(frame => {
    const entry = cache.take(`${root}/${frame}`, WIND_FRAME_LIMIT, pinned.expiresAtMs);
    const bytes = new TextEncoder().encode(descriptor(frame)); entry.bytes.set(bytes); entry.used = bytes.length;
    return entry;
  });
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith('/hold')) return new Response(new ReadableStream({ cancel() {} }));
    const frame = frames.find(item => path.endsWith(`/data/${item}`));
    if (frame) return new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } });
    return reply(path.includes('/wind/') ? wind : fine);
  });
  const scheduler = createForecastRequestScheduler({ budget, fetchImpl: fetcher, maxActive: 1, maxBackgroundActive: 1 });
  const hold = scheduler.request({ url: 'https://api.test/hold', kind: 'json', priority: 'foreground', maxResponseBytes: 1024 });
  await hold.response;
  const sources = frames.map(() => new WindDataSource('https://api.test', { cache, budget, request: spec => scheduler.request(spec), coalesceSpans: false }));
  const loads = sources.map((source, index) => source.load({ build: pinned, frame: frames[index]!, bounds }));
  const settled = Promise.allSettled(loads);
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    hold.cancel(); await hold.settled;
    const result = await Promise.race([settled, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('scheduler wave stalled')), 1000))]);
    expect(result.some(item => item.status === 'fulfilled' && item.value === 'ready')).toBe(true);
    for (const item of result) if (item.status === 'rejected') expect(item.reason).toBeInstanceOf(WindCapacityError);
    sources.forEach(source => source.dispose());
    descriptors.forEach(entry => cache.release(entry)); cache.clear();
    for (const frame of frames) {
      const retry = new WindDataSource('https://api.test', { cache, budget, request: spec => scheduler.request(spec), coalesceSpans: false });
      try { expect(await retry.load({ build: pinned, frame, bounds })).toBe('ready'); }
      finally { retry.dispose(); cache.clear(); }
    }
    expect(budget.used).toBe(0);
  } finally {
    hold.cancel(); sources.forEach(source => source.dispose()); scheduler.dispose();
    await settled; cache.clear();
  }
});

it('chooses an already-backed finer overview when it has the lowest remaining cost', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [-128, 0, 127, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 256, height: 1, lon0: -128 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.levels = 77;
  metadata.overview = [2, 4].map(stride => ({ stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: 1, bytes: 1 }] }));
  const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 2);
  const root = `https://api.test/v1/models/${pinned.manifest.model}/runs/${pinned.manifest.buildId}/data/${frame}`;
  const cache = new WindDataCache();
  for (let tile = 0; tile < layout.count; tile++) {
    const entry = cache.take(`${root}/overview-2/${tile}`, layout.chunkBytes, pinned.expiresAtMs);
    entry.used = layout.chunkBytes; cache.release(entry);
  }
  const fetcher = vi.fn<typeof fetch>(async () => new Response(layoutDescriptor(pinned, metadata), { headers: { 'content-type': 'application/json' } }));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher, cache });
  try {
    expect(await source.load({ build: pinned, frame, bounds: [-128, 0, 127, 1] })).toBe('ready');
    expect(source.isOverview).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(source.memoryUsage().horizonNumericRemaining).toBe(0);
  } finally { source.dispose(); cache.clear(); }
});
