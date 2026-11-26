import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { createPreparationBudget, type RasterTileResponse, type RasterTileSourceProtocol } from '@av/client';
import { MAX_TILE_BYTES } from '@av/contracts/format';
import { renderedFrames } from '@av/contracts/publication';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { RasterOverview, type RasterOverviewOptions } from './raster-overview';

class Bitmap {
  readonly close = vi.fn();
  constructor(readonly kind: 'tile' | 'overview', readonly width = 256, readonly height = 256) { bitmaps.push(this); }
}
const bitmaps: Bitmap[] = [];
const canvases: Canvas[] = [];
class Canvas {
  readonly context = { clearRect: vi.fn(), drawImage: vi.fn() };
  constructor(public width: number, public height: number) { canvases.push(this); }
  getContext() { return this.context; }
  transferToImageBitmap() { return new Bitmap('overview', this.width, this.height); }
}
const decode = vi.fn<(...args: unknown[]) => Promise<Bitmap>>();
const LOCAL = { west: -78.5, east: -78.2, south: 38.6, north: 38.9 };
const FOCUSED = { west: -78.6, east: -78.2, south: 38.7, north: 39.0 };
function build(count = 1, mapFrameCount = count) {
  const original = fixtureBuild(), first = original.manifest.frames[0];
  const frames = Array.from({ length: count }, (_, index) => {
    const validTime = new Date(Date.parse(first.validTime) + index * 3600_000).toISOString();
    return { id: `f${String(index + 1).padStart(3, '0')}`, validTime, intervalEnd: validTime,
      intervalStart: new Date(Date.parse(validTime) - 3600_000).toISOString() };
  });
  return fixtureBuild({ frames, mapFrameCount });
}
function fixture(held = false, bytes = 12, abortable = true, options: RasterOverviewOptions = {}, leased = false) {
  let bounds = { west: -80, east: 80, south: -50, north: 50 }, zoom = 4, sourceZoom: number | null = null;
  const sources = new globalThis.Map<string, { coordinates: number[][]; updateImage: ReturnType<typeof vi.fn> }>();
  const layers = new globalThis.Map<string, object>();
  const map = {
    getCanvas: () => ({}), getZoom: () => zoom,
    coveringTiles: (options?: { minzoom?: number; maxzoom?: number }) => [{ canonical: { z: Math.max(options?.minzoom ?? 0, Math.min(options?.maxzoom ?? 22, Math.round(sourceZoom ?? zoom))) } }],
    getBounds: () => ({ getWest: () => bounds.west, getEast: () => bounds.east, getSouth: () => bounds.south, getNorth: () => bounds.north }),
    getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
    addSource: vi.fn((id: string, spec: { coordinates: number[][] }) => sources.set(id, { coordinates: spec.coordinates, updateImage: vi.fn() })),
    addLayer: vi.fn((layer: { id: string }) => layers.set(layer.id, layer)),
    removeLayer: vi.fn((id: string) => layers.delete(id)), removeSource: vi.fn((id: string) => sources.delete(id)),
    setPaintProperty: vi.fn()
  };
  const transport = { url: (url: string) => url, setInteractive: vi.fn(), dispose: vi.fn() };
  const requests: { url: string; signal: AbortSignal; resolve: (response: RasterTileResponse) => void; reject: (error: Error) => void }[] = [];
  const load = vi.fn(({ url }: { url: string }, controller: AbortController): Promise<RasterTileResponse> => new Promise((resolve, reject) => {
    requests.push({ url, signal: controller.signal, resolve, reject });
    if (abortable) controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    if (!held) resolve({ data: new ArrayBuffer(bytes) });
  }));
  const handles: { url: string; promote: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }[] = [];
  let compressed = 0, peakCompressed = 0;
  const requestTile = leased ? vi.fn((url: string) => {
    const controller = new AbortController(), promote = vi.fn();
    let size = 0;
    const release = vi.fn(() => { compressed -= size; size = 0; });
    handles.push({ url, promote, release });
    return { response: load({ url }, controller).then(value => { size = value.data.byteLength; compressed += size; peakCompressed = Math.max(peakCompressed, compressed); return { ...value, release }; }), promote, cancel: () => controller.abort() };
  }) : undefined;
  const protocol = { load, requestTile, createSource: vi.fn(() => transport), setBuildExpiry: vi.fn() };
  const onReady = vi.fn(), overview = new RasterOverview(map as unknown as Map, protocol as unknown as RasterTileSourceProtocol, onReady, options);
  const finish = (index: number, returnedBytes = bytes) => requests[index].resolve({ data: new ArrayBuffer(returnedBytes) });
  return { overview, map, sources, layers, requests, handles, protocol, transport, onReady, finish, peakCompressed: () => peakCompressed,
    view: (value: typeof bounds, valueZoom = zoom) => { bounds = value; zoom = valueZoom; },
    setSourceZoom: (value: number | null) => { sourceZoom = value; } };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-30T00:00:00Z'));
  bitmaps.length = 0; canvases.length = 0; decode.mockReset().mockImplementation(async () => new Bitmap('tile'));
  vi.stubGlobal('OffscreenCanvas', Canvas); vi.stubGlobal('createImageBitmap', decode);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['addSource', 'addLayer'] as const)('rolls back display admission when %s fails', async operation => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(false, 12, true, { budget }), b = build();
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    const before = budget.used;
    f.map[operation].mockImplementationOnce(() => { throw new Error('Map publication failed'); });
    expect(f.overview.show(b, 'usable-lift-agl', b.manifest.frames[0].id, 0.7)).toBe(false);
    expect(budget.used).toBe(before);
    expect(f.sources.size).toBe(0);
    expect(f.layers.size).toBe(0);
  } finally { f.overview.destroy(); }
  await vi.advanceTimersByTimeAsync(0);
  expect(budget.used).toBe(0);
});

it('keeps a visible preview charged through multiple pending viewport replacements', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(true, 12, true, { budget }, true), b = build(2);
  const frame = b.manifest.frames[0].id;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frame);
    for (const request of f.requests) request.resolve({ data: new ArrayBuffer(12) });
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(2));
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(true);
    const shown = f.overview['shown']!, pixels = shown.bitmap.width * shown.bitmap.height * 4;
    f.view(FOCUSED, 9); f.overview.select(b, 'usable-lift-agl', frame);
    expect(f.overview['heldLease']?.bytes).toBe(pixels);
    f.view({ west: 40, east: 41, south: 40, north: 41 }, 9); f.overview.select(b, 'usable-lift-agl', frame);
    expect(f.overview['shown']).toBe(shown);
    expect(f.overview['heldLease']?.bytes).toBe(pixels);
    expect(budget.snapshot()['raster-preview']).toBe(2 * 256 * 256 * 4 + pixels);
  } finally { f.overview.destroy(); }
  expect(budget.used).toBe(0);
});


it('latches a failed opacity publication until a new explicit selection', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    f.overview.show(b, 'usable-lift-agl', frame, 0);
    f.map.setPaintProperty.mockClear().mockImplementationOnce(() => { throw new Error('Paint failed'); });
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(false);
    expect(f.overview['opacities'].get(f.overview.id)).toBe(0);
    const calls = f.map.setPaintProperty.mock.calls.length;
    for (let paint = 0; paint < 25; paint++) expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(false);
    expect(f.map.setPaintProperty).toHaveBeenCalledTimes(calls);
    f.overview.select(b, 'usable-lift-agl', frame);
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(true);
    expect(f.map.setPaintProperty).toHaveBeenCalledTimes(calls + 1);
    expect(f.overview['opacities'].get(f.overview.id)).toBe(0.7);
  } finally { f.overview.destroy(); }
});

it('keeps the previous image visible when a staged reveal fails and render callbacks repeat', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(false, 12, true, { budget }), b = build(2);
  const [first, second] = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', first.id);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(2));
    expect(f.overview.show(b, 'usable-lift-agl', first.id, 0.7)).toBe(true);
    const previous = f.overview['shown']!, before = budget.used;
    f.overview.select(b, 'usable-lift-agl', second.id);
    expect(f.overview.show(b, 'usable-lift-agl', second.id, 0)).toBe(true);
    const stagedBytes = budget.used;
    f.map.setPaintProperty.mockImplementationOnce(() => { throw new Error('Stage reveal failed'); });
    expect(f.overview.show(b, 'usable-lift-agl', second.id, 0.7)).toBe(false);
    const mutations = f.map.setPaintProperty.mock.calls.length;
    for (let paint = 0; paint < 25; paint++) {
      expect(f.overview.show(b, 'usable-lift-agl', second.id, 0.7)).toBe(false);
      f.overview.painted();
    }
    expect(f.map.setPaintProperty).toHaveBeenCalledTimes(mutations);
    expect(f.overview['visibleId']).toBe(f.overview.id);
    expect(f.overview['opacities'].get(f.overview.id)).toBe(0.7);
    expect(f.overview['opacities'].get(`${f.overview.id}-stage`)).toBe(0);
    expect(previous.bitmap.close).not.toHaveBeenCalled();
    expect(budget.used).toBe(stagedBytes);
    expect(stagedBytes).toBeGreaterThan(before);
    f.overview.select(b, 'usable-lift-agl', second.id);
    expect(f.overview.show(b, 'usable-lift-agl', second.id, 0.7)).toBe(true);
    expect(f.overview.painted()).toBe(true);
    expect(f.sources.has(f.overview.id)).toBe(false);
  } finally { f.overview.destroy(); }
  await vi.advanceTimersByTimeAsync(0);
  expect(budget.used).toBe(0);
});

it('finishes destruction after a map source removal fails', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(false, 12, true, { budget }, true), b = build();
  f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
  await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
  f.overview.show(b, 'usable-lift-agl', b.manifest.frames[0].id, 0.7);
  f.map.removeLayer.mockImplementationOnce(() => { throw new Error('Layer removal failed'); });
  expect(() => f.overview.destroy()).toThrow('Layer removal failed');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.transport.dispose).toHaveBeenCalledOnce();
  expect(f.map.removeSource).toHaveBeenCalled();
  expect(canvases[0].width).toBe(0);
  expect(canvases[0].height).toBe(0);
  expect(budget.used).toBe(0);
});

it.each(['clear', 'transfer'] as const)('fails a canvas %s at its owning job and recovers through the bounded preview retry', async operation => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(false, 12, true, { budget }, true), b = build();
  const frame = b.manifest.frames[0].id;
  const method = operation === 'transfer' ? vi.spyOn(canvases[0], 'transferToImageBitmap') : canvases[0].context.clearRect;
  method.mockImplementationOnce(() => { throw new Error('Canvas operation failed'); });
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    expect(f.requests).toHaveLength(8);
    expect(f.handles.every(handle => handle.release.mock.calls.length === 1)).toBe(true);
  } finally { f.overview.destroy(); }
  await vi.advanceTimersByTimeAsync(0);
  expect(budget.used).toBe(0);
});

it('bounds retries and releases buffers when canvas transfers keep failing', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(false, 12, true, { budget }, true), b = build();
  vi.spyOn(canvases[0], 'transferToImageBitmap').mockImplementation(() => { throw new Error('Canvas unavailable'); });
  try {
    f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.overview.state).toEqual({ ready: 0, total: 1, failed: 1 });
    expect(f.requests).toHaveLength(12);
    expect(f.handles.every(handle => handle.release.mock.calls.length === 1)).toBe(true);
    expect(f.overview['decodeLease']).toBeNull();
  } finally { f.overview.destroy(); }
  await vi.advanceTimersByTimeAsync(0);
  expect(budget.used).toBe(0);
});


it.each(['rejection', 'oversized response'] as const)('keeps request admission bounded after repeated %s failures', async failure => {
  const f = fixture(true, 12, true, {}, true), b = build(48);
  const settled = new Set<typeof f.requests[number]>();
  const pending = () => f.requests.filter(request => !request.signal.aborted && !settled.has(request));
  try {
    f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    expect(pending()).toHaveLength(24);
    for (let attempt = 0; attempt < 10; attempt++) {
      const request = pending()[0];
      settled.add(request);
      if (failure === 'rejection') request.reject(new Error('request failed'));
      else request.resolve({ data: new ArrayBuffer(MAX_TILE_BYTES + 1) });
      await vi.advanceTimersByTimeAsync(0);
      expect(pending().length).toBeLessThanOrEqual(24);
      expect(f.overview['fetching']).toBe(pending().length);
    }
    const selected = b.manifest.frames[0].id;
    expect(pending().filter(request => !request.url.includes(`/${selected}/`)).length).toBeLessThanOrEqual(20);
  } finally { f.overview.destroy(); }
  expect(f.overview['fetching']).toBe(0);
});

it('stops a failed pump when its synchronous error callback replaces the context', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(true, 12, true, { budget }, true), b = build(48);
  f.protocol.requestTile!.mockImplementationOnce(() => { throw new Error('request failed synchronously'); });
  f.onReady.mockImplementationOnce(() => f.overview.select(b, 'usable-lift-msl', b.manifest.frames[1].id));
  try {
    f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    await vi.advanceTimersByTimeAsync(0);
    const pending = f.requests.filter(request => !request.signal.aborted);
    expect(pending).toHaveLength(24);
    expect(pending.every(request => request.url.includes('/usable-lift-msl/'))).toBe(true);
    expect(f.overview['fetching']).toBe(pending.length);
    expect(f.overview.ready(b, 'usable-lift-agl', b.manifest.frames[0].id)).toBe(false);
  } finally { f.overview.destroy(); }
  expect(budget.used).toBe(0);
});

it('cancels a handle returned after synchronous context replacement and releases its late response', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(true, 12, false, { budget }, true), b = build(48);
  const requestTile = f.protocol.requestTile!.getMockImplementation()!;
  f.protocol.requestTile!.mockImplementationOnce(url => {
    const handle = requestTile(url);
    f.overview.select(b, 'usable-lift-msl', b.manifest.frames[1].id);
    return handle;
  });
  try {
    f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    expect(f.requests[0].signal.aborted).toBe(true);
    expect(f.requests.filter(request => !request.signal.aborted)).toHaveLength(24);
    f.requests[0].resolve({ data: new ArrayBuffer(12) });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.handles[0].release).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
    expect(f.overview['fetching']).toBe(24);
  } finally { f.overview.destroy(); }
  expect(budget.used).toBe(0);
});

it.each(['request failure', 'clear', 'viewport reset'] as const)('preserves a context started synchronously during %s cancellation', async cause => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(true, 12, true, { budget }, true), b = build(48);
  const requestTile = f.protocol.requestTile!.getMockImplementation()!;
  f.protocol.requestTile!.mockImplementationOnce(url => {
    const handle = requestTile(url);
    return { ...handle, cancel() {
      handle.cancel();
      f.overview.select(b, 'usable-lift-msl', b.manifest.frames[1].id);
    } };
  });
  try {
    f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    if (cause === 'request failure') f.requests[1].reject(new Error('request failed'));
    else if (cause === 'clear') f.overview.clear();
    else {
      f.view(FOCUSED, 9);
      f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    }
    await vi.advanceTimersByTimeAsync(0);
    const pending = f.requests.filter(request => !request.signal.aborted && request !== f.requests[1]);
    expect(pending).toHaveLength(cause === 'viewport reset' ? 22 : 24);
    expect(pending.every(request => request.url.includes('/usable-lift-msl/'))).toBe(true);
    expect(f.overview['fetching']).toBe(pending.length);
  } finally { f.overview.destroy(); }
  expect(budget.used).toBe(0);
});

it('keeps cancelled decodes charged and bounded across repeated context replacement', async () => {
  const mib = 1024 * 1024, budget = createPreparationBudget(128 * mib), f = fixture(false, 12, true, { budget }, true), b = build(4);
  const pending: ((image: Bitmap) => void)[] = [];
  decode.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  try {
    f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    for (let cycle = 0; cycle < 12; cycle++) {
      f.overview.clear();
      f.overview.select(b, cycle % 2 ? 'usable-lift-agl' : 'usable-lift-msl', b.manifest.frames[cycle % 4].id);
      await vi.advanceTimersByTimeAsync(0);
      expect(pending).toHaveLength(4);
      expect(budget.snapshot()['raster-decode']).toBe(5 * mib);
    }
  } finally { f.overview.destroy(); }
  const late = pending.map(() => new Bitmap('tile'));
  pending.forEach((resolve, index) => resolve(late[index]));
  await vi.waitFor(() => expect(budget.used).toBe(0));
  expect(late.every(image => image.close.mock.calls.length === 1)).toBe(true);
});


it('keeps the outgoing source and both display leases until the staged image is visible and painted', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(false, 12, true, { budget }), b = build(2), [first, second] = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', first.id);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(2));
    expect(f.overview.show(b, 'usable-lift-agl', first.id, 0.7)).toBe(true);
    expect(f.overview.painted()).toBe(true);
    const oldSource = f.sources.get(f.overview.id)!;
    const oldBitmap = oldSource.updateImage.mock.calls[0][0].image as Bitmap;
    const firstLease = budget.snapshot()['raster-display'];
    f.map.setPaintProperty.mockClear();
    expect(f.overview.show(b, 'usable-lift-agl', second.id, 0)).toBe(true);
    expect(f.sources.get(f.overview.id)).toBe(oldSource);
    expect(f.map.setPaintProperty).not.toHaveBeenCalledWith(f.overview.id, 'raster-opacity', 0);
    expect(budget.snapshot()['raster-display']).toBeGreaterThan(firstLease);
    expect(f.overview.painted()).toBe(true);
    expect(oldBitmap.close).not.toHaveBeenCalled();
    expect(budget.snapshot()['raster-display']).toBeGreaterThan(firstLease);
    expect(f.overview.show(b, 'usable-lift-agl', second.id, 0.7)).toBe(true);
    expect(f.overview.painted()).toBe(true);
    expect(f.sources.has(f.overview.id)).toBe(false);
    expect(budget.snapshot()['raster-display']).toBeLessThanOrEqual(firstLease);
  } finally { f.overview.destroy(); }
  expect(budget.used).toBe(0);
});

it('writes opacity only when the displayed value changes', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    f.overview.show(b, 'usable-lift-agl', frame, 0.7);
    f.map.setPaintProperty.mockClear();
    for (let i = 0; i < 120; i++) f.overview.show(b, 'usable-lift-agl', frame, 0.7);
    expect(f.map.setPaintProperty.mock.calls.length).toBe(0);
    f.overview.show(b, 'usable-lift-agl', frame, 0.4);
    expect(f.map.setPaintProperty).toHaveBeenCalledExactlyOnceWith(f.overview.id, 'raster-opacity', 0.4);
    f.overview.hide();
    f.map.setPaintProperty.mockClear();
    for (let i = 0; i < 120; i++) f.overview.hide();
    expect(f.map.setPaintProperty.mock.calls.length).toBe(0);
  } finally { f.overview.destroy(); }
});


it.each([16, 24, 32])('fills the %i-request profile while replacing completed downloads', async maxActive => {
  const f = fixture(true, 12, true, { requestLimits: { maxActive, maxPrefetchActive: maxActive - 4 } }), b = build(48);
  try {
    f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    expect(f.requests).toHaveLength(maxActive);
    const sibling = f.requests[5];
    f.finish(4);
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(maxActive));
    expect(sibling.signal.aborted).toBe(false);
  } finally { f.overview.destroy(); }
});






it('promotes selected handles and releases compressed responses after stale decodes settle', async () => {
  const f = fixture(true, 12, false, {}, true), b = build(3), [first, second] = renderedFrames(b.manifest);
  const pending: ((image: Bitmap) => void)[] = [];
  decode.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  try {
    f.overview.select(b, 'usable-lift-agl', first.id);
    const secondHandles = f.handles.filter(handle => handle.url.includes(`/${second.id}/`));
    expect(secondHandles.length).toBeGreaterThan(0);
    f.overview.select(b, 'usable-lift-agl', second.id);
    expect(secondHandles.every(handle => handle.promote.mock.calls.length === 1)).toBe(true);
    for (const request of f.requests) request.resolve({ data: new ArrayBuffer(12) });
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(0);
    f.overview.clear();
    const awaitingDecode = f.handles.filter(handle => !handle.release.mock.calls.length);
    expect(awaitingDecode.length).toBe(pending.length);
    for (const resolve of pending) resolve(new Bitmap('tile'));
    await vi.waitFor(() => expect(f.handles.every(handle => handle.release.mock.calls.length === 1)).toBe(true));
  } finally { f.overview.destroy(); }
});


it('retains the decode lease until cancelled bitmap work settles', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(false, 12, true, { budget }), b = build();
  const pending: ((image: Bitmap) => void)[] = [];
  decode.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  try {
    f.view(FOCUSED, 9); f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    f.overview.clear();
    expect(budget.snapshot()['raster-decode']).toBeGreaterThan(0);
    for (const resolve of pending) resolve(new Bitmap('tile'));
    await vi.waitFor(() => expect(budget.used).toBe(0));
  } finally { f.overview.destroy(); }
});

it('retries a deferred preview horizon when budget capacity is released', async () => {
  const budget = createPreparationBudget(16 * 1024 * 1024), held = budget.reserve('other', 15 * 1024 * 1024)!;
  const f = fixture(false, 12, true, { budget }), b = build(8);
  try {
    f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    expect(f.overview.readiness().limited).toBe(true);
    held.release();
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(8));
  } finally { held.release(); f.overview.destroy(); }
  expect(budget.used).toBe(0);
});

it.each([undefined, 2, 4, 8])('prepares a compact aspect-preserving preview for every rendered frame with device memory %s', async memory => {
  if (memory !== undefined) Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: memory });
  const f = fixture(), b = build(52, 48), frames = renderedFrames(b.manifest);
  try {
    f.view({ west: -100, east: -90, south: 30, north: 35 }, 4); f.overview.select(b, 'usable-lift-agl', frames[24].id);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(frames.length), { timeout: 1000 });
    expect(frames.length).toBe(48);
    for (const frame of frames) {
      expect(f.overview.ready(b, 'usable-lift-agl', frame.id)).toBe(true);
      expect(f.overview.show(b, 'usable-lift-agl', frame.id, 0.7)).toBe(true);
      const requestCount = f.requests.filter(request => request.url.includes(`/${frame.id}/`)).length;
      expect(requestCount).toBeGreaterThan(0);
      expect(requestCount).toBeLessThanOrEqual(4);
      const source = f.sources.get(f.overview.id)!;
      const image = source.updateImage.mock.calls.at(-1)![0].image as Bitmap;
      expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0);
      expect(image.width).toBeLessThanOrEqual(256); expect(image.height).toBeLessThanOrEqual(256);
      const coordinates = source.coordinates;
      const mercatorY = (lat: number) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
      const aspect = ((coordinates[1][0] - coordinates[0][0]) / 360) / (mercatorY(coordinates[2][1]) - mercatorY(coordinates[0][1]));
      expect(Math.abs(image.width / image.height - aspect)).toBeLessThan(0.03);
    }
    expect(canvases).toHaveLength(1);
  } finally {
    f.overview.destroy();
    delete (navigator as { deviceMemory?: number }).deviceMemory;
  }
});

it('replaces a completed download while its sibling is still pending', async () => {
  const f = fixture(true), b = build(48), frame = b.manifest.frames[0].id;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frame);
    expect(f.requests.length).toBeGreaterThanOrEqual(2);
    const initial = f.requests.length, pending = f.requests[2];
    f.finish(1);
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(initial), { timeout: 500 });
    expect(pending.signal.aborted).toBe(false);
  } finally { f.overview.destroy(); }
});

it('starts another frame while one tile of the selected frame remains pending', async () => {
  const f = fixture(true), b = build(3), [first, second] = renderedFrames(b.manifest);
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', first.id);
    const pending = f.requests[0];
    let next = 1;
    for (let round = 0; round < 30 && !f.requests.some(request => request.url.includes(`/${second.id}/`)); round++) {
      while (next < f.requests.length) f.finish(next++);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(pending.signal.aborted).toBe(false);
    expect(f.overview.ready(b, 'usable-lift-agl', first.id)).toBe(false);
    expect(f.requests.some(request => request.url.includes(`/${second.id}/`))).toBe(true);
  } finally { f.overview.destroy(); }
});

it('keeps in-flight horizon requests and starts the newly selected frame', async () => {
  const f = fixture(true), b = build(3), [first, , selected] = renderedFrames(b.manifest);
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', first.id);
    const initial = f.requests.slice();
    f.overview.select(b, 'usable-lift-agl', selected.id);
    expect(initial.every(request => !request.signal.aborted)).toBe(true);
    await vi.waitFor(() => expect(f.requests.some(request => request.url.includes(`/${selected.id}/`))).toBe(true), { timeout: 500 });
  } finally { f.overview.destroy(); }
});



it('caps concurrent decodes at four, uses one canvas, and closes cancelled decode results', async () => {
  const f = fixture(), b = build(8), frame = b.manifest.frames[0].id;
  const pending: ((image: Bitmap) => void)[] = [];
  let active = 0, peak = 0;
  decode.mockImplementation(() => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    pending.push(image => { active--; resolve(image); });
  }));
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frame);
    for (let round = 0; round < 200 && f.overview.state.ready < 2; round++) {
      await vi.advanceTimersByTimeAsync(0);
      if (pending.length) pending.shift()!(new Bitmap('tile'));
      expect(peak).toBeLessThanOrEqual(4);
      expect(canvases).toHaveLength(1);
    }
    expect(f.overview.state.ready).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.length).toBeGreaterThan(0);
    f.overview.clear();
    const stale = pending.splice(0).map(resolve => { const image = new Bitmap('tile'); resolve(image); return image; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stale.every(image => image.close.mock.calls.length === 1)).toBe(true);
  } finally { f.overview.destroy(); }
});

it('waits for every preview tile before marking the frame ready', async () => {
  const f = fixture(true), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frame);
    const ready = () => f.overview.ready(b, 'usable-lift-agl', frame);
    expect(ready()).toBe(false);
    let done = 0;
    while (!ready()) {
      if (f.requests.length === done) {
        await vi.waitFor(() => expect(ready() || f.requests.length > done).toBe(true));
        if (ready()) break;
      }
      const batch = f.requests.length;
      for (let index = done; index < batch; index++) f.finish(index);
      done = batch;
    }
    expect(f.overview.state).toEqual({ ready: 1, total: 1, failed: 0 });
    expect(canvases[0].context.drawImage).toHaveBeenCalled();
    expect(bitmaps.filter(image => image.kind === 'tile').every(image => image.close.mock.calls.length === 1)).toBe(true);
    expect(f.protocol.createSource).toHaveBeenCalledWith(false);
  } finally { f.overview.destroy(); }
});

it('uses at most two image sources and reuses decoded frames for timeline changes', async () => {
  const f = fixture(), b = build(3), frames = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', frames[1].id);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(3));
    const requests = f.requests.length;
    expect(f.overview.show(b, 'usable-lift-agl', frames[1].id, 0.7)).toBe(true);
    expect(f.overview.show(b, 'usable-lift-agl', frames[2].id, 0.7)).toBe(true);
    expect(f.overview.show(b, 'usable-lift-agl', frames[2].id, 0.4)).toBe(true);
    expect(f.map.addSource).toHaveBeenCalledTimes(2); expect(f.map.addLayer).toHaveBeenCalledTimes(2);
    expect(f.sources.get(f.overview.id)!.updateImage).toHaveBeenCalledOnce();
    expect(f.sources.get(`${f.overview.id}-stage`)!.updateImage).toHaveBeenCalledOnce();
    expect(f.requests).toHaveLength(requests);
    f.overview.hide();
    expect(f.map.setPaintProperty).toHaveBeenLastCalledWith(`${f.overview.id}-stage`, 'raster-opacity', 0);
  } finally { f.overview.destroy(); }
});

it('retries the selected overview once after a tile error', async () => {
  const f = fixture(true), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frame);
    f.requests[0].reject(new Error('503'));
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(1));
    const ready = () => f.overview.ready(b, 'usable-lift-agl', frame);
    let done = 1;
    while (!ready()) {
      if (f.requests.length === done) {
        await vi.waitFor(() => expect(ready() || f.requests.length > done).toBe(true));
        if (ready()) break;
      }
      const batch = f.requests.length;
      for (let index = done; index < batch; index++) f.finish(index);
      done = batch;
    }
    expect(f.overview.state).toEqual({ ready: 1, total: 1, failed: 0 });
  } finally { f.overview.destroy(); }
});

it('stops after one retry when the selected overview fails twice', async () => {
  const f = fixture(true), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frame);
    f.requests[0].reject(new Error('503'));
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(1));
    f.requests[1].reject(new Error('503'));
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 0, total: 1, failed: 1 }));
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(false);
    expect(f.map.addSource).not.toHaveBeenCalled();
  } finally { f.overview.destroy(); }
});

it('keeps the one-retry limit when the same frame is selected again during the retry', async () => {
  const f = fixture(true), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frame);
    f.requests[0].reject(new Error('503'));
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(1));
    f.overview.select(b, 'usable-lift-agl', frame);
    f.requests[1].reject(new Error('503'));
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 0, total: 1, failed: 1 }));
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(false);
  } finally { f.overview.destroy(); }
});

it('never promotes a partially failed frame into an empty fallback', async () => {
  const f = fixture(true), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    f.finish(0); f.requests[1].reject(new Error('503'));
    const initial = f.requests.length;
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(initial));
    expect(f.overview.state.failed).toBe(0);
    f.requests[initial].reject(new Error('503'));
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 0, total: 1, failed: 1 }));
    expect(bitmaps.filter(image => image.kind === 'tile').every(image => image.close.mock.calls.length === 1)).toBe(true);
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(false);
    expect(f.map.addSource).not.toHaveBeenCalled();
    expect(f.onReady).toHaveBeenCalled();
  } finally { f.overview.destroy(); }
});

it.each([
  { west: 170, east: 190, south: -20, north: 20 },
  { west: 530, east: 550, south: -20, north: 20 },
  { west: -190, east: -170, south: -20, north: 20 },
  { west: -170, east: 170, south: -2, north: 2 },
  { west: -2, east: 2, south: -90, north: 90 },
  { west: -540, east: 540, south: -85, north: 85 }
])('covers the canonical Mercator viewport within the mosaic limits: %j', async bounds => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.view(bounds, 10); f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    expect(f.requests.length).toBeGreaterThan(0); expect(f.requests.length).toBeLessThanOrEqual(64);
    const zooms = new Set<string>();
    for (const { url } of f.requests) {
      const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(url)!;
      zooms.add(z);
      expect(Number(z)).toBeLessThanOrEqual(9);
      expect(Number(x)).toBeGreaterThanOrEqual(0); expect(Number(x)).toBeLessThan(2 ** Number(z));
      expect(Number(y)).toBeGreaterThanOrEqual(0); expect(Number(y)).toBeLessThan(2 ** Number(z));
    }
    expect(zooms.size).toBe(1);
    f.overview.show(b, 'usable-lift-agl', frame, 0.7);
    const coordinates = f.sources.get(f.overview.id)!.coordinates;
    const west = coordinates[0][0], east = coordinates[1][0], north = coordinates[0][1], south = coordinates[2][1];
    const middle = (west + east) / 2;
    expect(middle).toBeGreaterThanOrEqual(-180); expect(middle).toBeLessThan(180);
    const viewWest = bounds.west; let viewEast = bounds.east;
    if (viewEast <= viewWest) viewEast += 360;
    const span = Math.min(360, viewEast - viewWest), center = (viewWest + viewEast) / 2;
    const shift = Math.floor((center + 180) / 360) * 360;
    expect(east - west).toBeGreaterThanOrEqual(span - 1e-6);
    if (east - west < 360 - 1e-6) {
      expect(center - shift).toBeGreaterThanOrEqual(west - 1e-4);
      expect(center - shift).toBeLessThanOrEqual(east + 1e-4);
    }
    const limit = 85.0511287798066;
    expect(north).toBeGreaterThanOrEqual(Math.min(limit, bounds.north) - 1e-4);
    expect(south).toBeLessThanOrEqual(Math.max(-limit, bounds.south) + 1e-4);
    const boxes = canvases[0].context.drawImage.mock.calls.map(call => call.slice(1) as number[]);
    expect(Math.min(...boxes.map(box => box[0]))).toBeLessThanOrEqual(0);
    expect(Math.min(...boxes.map(box => box[1]))).toBeLessThanOrEqual(0);
    expect(Math.max(...boxes.map(box => box[0] + box[2]))).toBeGreaterThanOrEqual(canvases[0].width);
    expect(Math.max(...boxes.map(box => box[1] + box[3]))).toBeGreaterThanOrEqual(canvases[0].height);
  } finally { f.overview.destroy(); }
});

it('keeps a local preview and covers a fidget inside it', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.view(FOCUSED, 9.45); f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    expect(f.requests.some(request => /\/8\/\d+\/\d+\.webp$/.test(request.url))).toBe(true);
    f.overview.show(b, 'usable-lift-agl', frame, 0.7);
    const count = f.requests.length;
    f.view({ west: -78.55, east: -78.25, south: 38.75, north: 38.95 }, 9.45);
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(true);
    expect(f.requests).toHaveLength(count);
    f.view({ west: -70, east: -69.6, south: 38.7, north: 39 }, 9.45);
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
  } finally { f.overview.destroy(); }
});

it('keeps an in-flight mosaic running when the selected frame is already decoded', async () => {
  const f = fixture(true), b = build(2), [first, second] = b.manifest.frames;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', first.id);
    const firstIndices = f.requests.map((r, i) => r.url.includes(`/${first.id}/`) ? i : -1).filter(i => i >= 0);
    for (const index of firstIndices) f.finish(index);
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', first.id)).toBe(true));
    const inflight = f.requests.filter(r => r.url.includes(`/${second.id}/`));
    expect(inflight.length).toBeGreaterThan(0);
    const countBefore = f.requests.length;
    f.overview.select(b, 'usable-lift-agl', first.id);
    expect(inflight.every(request => request.signal.aborted)).toBe(false);
    expect(f.requests).toHaveLength(countBefore);
    for (const req of inflight) req.resolve({ data: new ArrayBuffer(12) });
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', second.id)).toBe(true));
  } finally { f.overview.destroy(); }
});

it('retains in-flight frames and the reserved transport across contexts', async () => {
  const f = fixture(true), b = build(2), [first, second] = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', first.id);
    f.overview.select(b, 'usable-lift-agl', first.id);
    expect(f.requests[0].signal.aborted).toBe(false);
    f.overview.select(b, 'usable-lift-agl', second.id);
    expect(f.requests.slice(0, 2).every(request => !request.signal.aborted)).toBe(true);
    expect(f.requests.some(request => request.url.includes(`/${second.id}/`))).toBe(true);
    const count = f.requests.length;
    f.overview.clear(); f.overview.select(b, 'usable-lift-msl', second.id);
    expect(f.requests.length).toBeGreaterThan(count);
    expect(f.protocol.createSource).toHaveBeenCalledOnce(); expect(f.transport.dispose).not.toHaveBeenCalled();
  } finally { f.overview.destroy(); }
  expect(f.transport.dispose).toHaveBeenCalledOnce();
});

it('closes late decoded images before allocating work for a new context', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  const pending: ((image: Bitmap) => void)[] = [];
  decode.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    f.overview.clear(); f.overview.select(b, 'usable-lift-msl', frame);
    decode.mockImplementation(async () => new Bitmap('tile'));
    const stale = pending.map(() => new Bitmap('tile'));
    pending.forEach((resolve, index) => resolve(stale[index]));
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-msl', frame)).toBe(true));
    expect(stale.every(image => image.close.mock.calls.length === 1)).toBe(true);
    expect(f.onReady).toHaveBeenCalled();
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
  } finally { f.overview.destroy(); }
});

it('retains every map frame and the displayed image', async () => {
  const f = fixture(), b = build(60), frames = b.manifest.frames;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frames[59].id);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 60, total: 60, failed: 0 }));
    f.overview.show(b, 'usable-lift-agl', frames[59].id, 0.7);
    const shown = f.sources.get(f.overview.id)!.updateImage.mock.calls[0][0].image as Bitmap;
    f.overview.select(b, 'usable-lift-agl', frames[0].id);
    expect(shown.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frames[0].id)).toBe(true));
    f.overview.show(b, 'usable-lift-agl', frames[0].id, 0.7);
    expect(f.overview.show(b, 'usable-lift-agl', frames[59].id, 0.7)).toBe(true);
    expect(shown.close).not.toHaveBeenCalled();
    expect(bitmaps.filter(image => image.kind === 'overview' && !image.close.mock.calls.length).length).toBeGreaterThanOrEqual(60);
    expect(canvases).toHaveLength(1);
  } finally { f.overview.destroy(); }
});

it('keeps every preview when the device reports 4 GiB', async () => {
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 });
  const f = fixture(), b = build(60), frames = b.manifest.frames;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frames[30].id);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 60, total: 60, failed: 0 }));
    f.overview.show(b, 'usable-lift-agl', frames[30].id, 0.7);
    f.overview.select(b, 'usable-lift-agl', frames[0].id);
    expect(f.overview.state).toEqual({ ready: 60, total: 60, failed: 0 });
    expect(f.overview.ready(b, 'usable-lift-agl', frames[30].id)).toBe(true);
    expect(f.overview.ready(b, 'usable-lift-agl', frames[29].id)).toBe(true);
  } finally {
    f.overview.destroy();
    delete (navigator as { deviceMemory?: number }).deviceMemory;
  }
});

it('rejects an uncovered viewport and disposes resident images on expiry', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    f.overview.show(b, 'usable-lift-agl', frame, 0.7);
    f.view({ west: 100, east: 120, south: 20, north: 40 });
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(false);
    vi.setSystemTime(b.expiresAtMs); f.overview.refresh();
    expect(f.overview.state).toEqual({ ready: 0, total: 0, failed: 0 });
    expect(f.sources.size).toBe(0);
    expect(bitmaps.every(image => image.close.mock.calls.length === 1)).toBe(true);
    expect(f.transport.dispose).not.toHaveBeenCalled();
  } finally { f.overview.destroy(); }
});

it('decodes every map frame of a rested context', async () => {
  const f = fixture(false, 128 * 1024), b = build(4), frames = b.manifest.frames;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frames[0].id);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 4, total: 4, failed: 0 }));
    const requests = f.requests.slice();
    f.overview.select(b, 'usable-lift-agl', frames[3].id);
    expect(requests.every(request => !request.signal.aborted)).toBe(true);
    expect(f.overview.ready(b, 'usable-lift-agl', frames[3].id)).toBe(true);
    f.overview.select(b, 'usable-lift-msl', frames[0].id);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 4, total: 4, failed: 0 }));
    expect(f.requests.some(request => request.url.includes('/usable-lift-msl/'))).toBe(true);
  } finally { f.overview.destroy(); }
});

it('keeps preparing frames after a full-size tile', async () => {
  const f = fixture(true), b = build(2), frames = b.manifest.frames;
  try {
    f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frames[0].id);
    let done = 0;
    while (f.overview.state.ready < 2) {
      if (f.requests.length === done) {
        await vi.waitFor(() => expect(f.overview.state.ready === 2 || f.requests.length > done).toBe(true));
        if (f.overview.state.ready === 2) break;
      }
      const batch = f.requests.length;
      expect(batch - done).toBeLessThanOrEqual(8);
      for (let index = done; index < batch; index++) f.finish(index, index < 2 ? MAX_TILE_BYTES : 12);
      done = batch;
    }
    expect(f.overview.state).toEqual({ ready: 2, total: 2, failed: 0 });
    expect(bitmaps.filter(image => image.kind === 'overview' && !image.close.mock.calls.length)).toHaveLength(2);
  } finally { f.overview.destroy(); }
});

it('excludes aborted responses from the next context', async () => {
  const f = fixture(true, 128 * 1024, false), b = build(2), frame = b.manifest.frames[0].id;
  try {
    f.view(LOCAL, 4);
    f.overview.select(b, 'usable-lift-agl', frame);
    f.overview.clear(); f.overview.select(b, 'usable-lift-msl', frame);
    const previous = f.requests.filter(request => request.url.includes('/usable-lift-agl/'));
    expect(previous.every(request => request.signal.aborted)).toBe(true);
    for (const request of previous) request.resolve({ data: new ArrayBuffer(MAX_TILE_BYTES) });
    let index = previous.length;
    while (f.overview.state.ready < 2) {
      if (f.requests.length === index) {
        await vi.waitFor(() => expect(f.overview.state.ready === 2 || f.requests.length > index).toBe(true));
        if (f.overview.state.ready === 2) break;
      }
      while (index < f.requests.length) f.finish(index++);
    }
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 2, total: 2, failed: 0 }));
    expect(f.overview.ready(b, 'usable-lift-msl', frame)).toBe(true);
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
  } finally { f.overview.destroy(); }
});

it('releases the canvas backing on clear and reallocates only for an admitted context', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
  f.view(LOCAL, 4); f.overview.select(b, 'usable-lift-agl', frame);
  await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
  expect(canvases[0].width).toBeGreaterThan(0);
  f.overview.clear();
  expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
  expect(bitmaps.every(image => image.close.mock.calls.length === 1)).toBe(true);
  f.overview.select(b, 'usable-lift-msl', frame);
  await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
  expect(canvases[0].width).toBeGreaterThan(0);
  f.overview.destroy();
  expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
});

it('leaves unsupported browsers on the existing fine renderer without reserving a handle', () => {
  vi.stubGlobal('createImageBitmap', undefined);
  const f = fixture(), b = build();
  f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
  expect(f.overview.supported).toBe(false); expect(f.protocol.createSource).not.toHaveBeenCalled();
  expect(f.overview.state).toEqual({ ready: 0, total: 0, failed: 0 });
  f.overview.destroy();
});





it('keeps a contained pan inside the retained crop without closing prepared images', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  const armenia = { west: 44.27798057856188, east: 44.72201942143812, south: 40.104612670852696, north: 40.29538732914732 };
  try {
    f.view(armenia, 10); f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(true));
    const requests = f.requests.length, closes = bitmaps.reduce((count, bitmap) => count + bitmap.close.mock.calls.length, 0);
    f.view({ ...armenia, west: armenia.west + 0.01, east: armenia.east + 0.01 }, 10);
    f.overview.select(b, 'usable-lift-agl', frame);
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(true);
    expect(f.requests.length).toBe(requests);
    expect(bitmaps.reduce((count, bitmap) => count + bitmap.close.mock.calls.length, 0)).toBe(closes);
  } finally { f.overview.destroy(); }
});

it('keeps preview identities across a one-level zoom inside the same preview', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  const armenia = { west: 44.27798057856188, east: 44.72201942143812, south: 40.104612670852696, north: 40.29538732914732 };
  try {
    f.view(armenia, 8); f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(true));
    const previewUrls = () => f.requests.map(request => request.url).filter(url => {
      const zoom = Number(/\/(\d+)\/\d+\/\d+\.webp$/.exec(url)?.[1]);
      return Number.isFinite(zoom) && zoom < 8;
    });
    const before = previewUrls(), closes = bitmaps.reduce((count, bitmap) => count + bitmap.close.mock.calls.length, 0);
    f.view(armenia, 9); f.overview.select(b, 'usable-lift-agl', frame);
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(true);
    expect(previewUrls()).toEqual(before);
    expect(bitmaps.reduce((count, bitmap) => count + bitmap.close.mock.calls.length, 0)).toBe(closes);
  } finally { f.overview.destroy(); }
});

it('retains the displayed preview while preparing a new viewport', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  const wide = { west: -80, east: 80, south: -50, north: 50 }, armenia = { west: 44.27798057856188, east: 44.72201942143812, south: 40.104612670852696, north: 40.29538732914732 };
  try {
    f.view(wide, 12); f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(true));
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(true);
    const previous = f.sources.get(f.overview.id)!.updateImage.mock.calls.at(-1)![0].image as Bitmap;
    f.view(armenia, 12); f.overview.select(b, 'usable-lift-agl', frame);
    expect(previous.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(true));
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(true);
    expect(previous.close).not.toHaveBeenCalled();
    f.overview.painted();
    expect(previous.close).toHaveBeenCalledOnce();
  } finally { f.overview.destroy(); }
});

it('completes a newly selected 4-tile preview while background previews hold partial compressed tiles and a held request', async () => {
  const f = fixture(true, 12, true, {}, true), b = build(3), [first, second, third] = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', first.id);
    const firstRequests = f.requests.filter(req => req.url.includes(`/${first.id}/`));
    const secondRequests = f.requests.filter(req => req.url.includes(`/${second.id}/`));
    expect(firstRequests).toHaveLength(4);
    expect(secondRequests).toHaveLength(4);
    for (const req of firstRequests.slice(1)) req.resolve({ data: new ArrayBuffer(12) });
    await Promise.resolve();
    const allSecond = f.requests.filter(req => req.url.includes(`/${second.id}/`));
    for (const req of allSecond.slice(0, 2)) req.resolve({ data: new ArrayBuffer(12) });
    await Promise.resolve();
    f.overview.select(b, 'usable-lift-agl', third.id);
    await vi.waitFor(() => expect(f.requests.filter(req => req.url.includes(`/${third.id}/`))).toHaveLength(4));
    for (const req of f.requests.filter(req => req.url.includes(`/${third.id}/`))) req.resolve({ data: new ArrayBuffer(12) });
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', third.id)).toBe(true));
  } finally { f.overview.destroy(); }
});





it('acknowledges painted() only after MapLibre ImageSource uploads the bitmap and loads its tile', async () => {
  const f = fixture(), b = build(2), [first, second] = b.manifest.frames;
  try {
    f.view(LOCAL, 4);
    const tileID = { equals: (other: unknown) => other === tileID };
    f.map.addSource.mockImplementation((id: string, spec: { coordinates: number[][] }) => {
      const source = {
        coordinates: spec.coordinates,
        image: undefined as Bitmap | undefined,
        _imageDirty: false,
        texture: null as object | null,
        tileID,
        tiles: {} as Record<string, { state: string; tileID: { canonical: unknown } }>,
        updateImage: vi.fn(({ image, coordinates }: { image: Bitmap; coordinates: number[][] }) => {
          source.image = image;
          source.coordinates = coordinates;
          source._imageDirty = true;
        })
      };
      return f.sources.set(id, source);
    });
    f.overview.select(b, 'usable-lift-agl', first.id);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(2));
    expect(f.overview.show(b, 'usable-lift-agl', first.id, 0.7)).toBe(true);
    const source = f.sources.get(f.overview.id) as unknown as {
      image: Bitmap; _imageDirty: boolean; texture: object | null;
      tiles: Record<string, { state: string; tileID: { canonical: unknown } }>;
    };
    const firstBitmap = source.image;
    source._imageDirty = false; source.texture = {}; source.tiles = { 0: { state: 'loaded', tileID: { canonical: tileID } } };
    expect(f.overview.painted()).toBe(true);

    f.view(FOCUSED, 9); f.overview.select(b, 'usable-lift-agl', second.id);
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', second.id)).toBe(true));
    expect(f.overview.show(b, 'usable-lift-agl', second.id, 0)).toBe(true);
    const target = f.sources.get(`${f.overview.id}-stage`) as unknown as typeof source;
    target.tiles = {};
    expect(f.overview.painted()).toBe(false);
    expect(firstBitmap.close).not.toHaveBeenCalled();
    target._imageDirty = false; target.texture = {}; target.tiles = { 0: { state: 'loaded', tileID: { canonical: tileID } } };
    expect(f.overview.painted()).toBe(true);
    expect(firstBitmap.close).not.toHaveBeenCalled();
    expect(f.overview.show(b, 'usable-lift-agl', second.id, 0.7)).toBe(true);
    expect(f.overview.painted()).toBe(true);
    expect(firstBitmap.close).toHaveBeenCalledOnce();
  } finally { f.overview.destroy(); }
});

it('does not let a background coarse job with one compressed and one stalled tile delay a newly selected coarse frame', async () => {
  const f = fixture(true, 12, true, {}, true), b = build(3), [first, second, third] = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', first.id);
    const secondRequests = f.requests.filter(req => req.url.includes(`/${second.id}/`));
    expect(secondRequests.length).toBeGreaterThanOrEqual(2);
    // Background frame has 1 compressed tile and its remaining tiles permanently stalled.
    secondRequests[0]!.resolve({ data: new ArrayBuffer(12) });
    await Promise.resolve();
    expect(canvases[0]?.context.drawImage.mock.calls.length ?? 0).toBe(0);

    // Select third frame and deliver all of its tiles: must compose immediately with 0 ms timer delay.
    f.overview.select(b, 'usable-lift-agl', third.id);
    const thirdRequests = f.requests.filter(req => req.url.includes(`/${third.id}/`));
    expect(thirdRequests.length).toBeGreaterThan(0);
    for (const req of thirdRequests) req.resolve({ data: new ArrayBuffer(12) });
    for (let tick = 0; tick < 8 && !f.overview.ready(b, 'usable-lift-agl', third.id); tick++) {
      await Promise.resolve();
    }
    expect(f.overview.ready(b, 'usable-lift-agl', third.id)).toBe(true);
    expect(f.overview.quality(b, 'usable-lift-agl', third.id)).toBe('overview');
  } finally { f.overview.destroy(); }
});

it('copies the current view of a ready frame, centre-cropped to the target, and reports pending or unavailable otherwise', async () => {
  const f = fixture(), b = build(3), frames = b.manifest.frames;
  const target = { drawImage: vi.fn() };
  const draw = (frame: string, width = 60, height = 36, layer: 'usable-lift-agl' | 'usable-lift-msl' = 'usable-lift-agl') =>
    f.overview.drawPreview(b, layer, frame, target as unknown as CanvasRenderingContext2D, width, height);
  try {
    expect(draw(frames[0].id)).toBe('unavailable');
    f.view(LOCAL, 4);
    f.overview.select(b, 'usable-lift-agl', frames[0].id);
    expect(draw(frames[2].id)).toBe('pending');
    expect(draw(frames[0].id, 60, 36, 'usable-lift-msl')).toBe('pending');
    expect(draw('not-a-frame')).toBe('unavailable');
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(3));
    expect(draw(frames[2].id)).toBe('ready');
    const [image, , , sw, sh, dx, dy, dw, dh] = target.drawImage.mock.calls[0]!;
    expect((image as Bitmap).kind).toBe('overview');
    expect([dx, dy, dw, dh]).toEqual([0, 0, 60, 36]);
    expect((sw as number) / (sh as number)).toBeCloseTo(60 / 36, 5);
    expect(bitmaps.filter(bitmap => bitmap.kind === 'overview').every(bitmap => bitmap.close.mock.calls.length === 0)).toBe(true);
  } finally { f.overview.destroy(); }
});

it('prepares the selected frame neighbour, then preferred frames, before the rest', async () => {
  const f = fixture(true), b = build(30), frames = b.manifest.frames;
  try {
    f.view(LOCAL, 4);
    f.overview.preferFrames([frames[24].id]);
    f.overview.select(b, 'usable-lift-agl', frames[0].id);
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(0));
    const perFrame = f.requests.filter(request => request.url.includes(frames[0].id)).length;
    for (let index = 0; index < perFrame; index++) f.finish(index);
    await vi.waitFor(() => expect(f.requests.some(request => request.url.includes(frames[24].id))).toBe(true));
    const firstOther = f.requests.find(request => !request.url.includes(frames[0].id));
    expect(firstOther?.url).toContain(frames[1].id);
    const at = (frame: string) => f.requests.findIndex(request => request.url.includes(frame));
    expect(at(frames[24].id)).toBeLessThan(at(frames[2].id) < 0 ? Infinity : at(frames[2].id));
  } finally { f.overview.destroy(); }
});
