import { afterEach, expect, it, vi } from 'vitest';
import type { CustomLayerInterface, Map } from 'maplibre-gl';
import { createPreparationBudget, type PreparationBudget } from '@av/client';
import { barbGeometry } from '../../../../../packages/windgram/src/wind-barb';
import { WIND_CANVAS_BYTES, WIND_TRAIL_PIXELS } from '../raster/raster-budget';
import { WindOverlay, type WindField } from './wind-overlay';

class Canvas extends EventTarget {
  style: Record<string, string> = {};
  private backingWidth = 0;
  private backingHeight = 0;
  onSize = (): void => {};
  get width(): number { return this.backingWidth; }
  set width(value: number) { this.backingWidth = value; this.onSize(); }
  get height(): number { return this.backingHeight; }
  set height(value: number) { this.backingHeight = value; this.onSize(); }
  removed = false;
  context = {
    setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), stroke: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(), closePath: vi.fn(), fill: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn()
  };
  getContext(): typeof this.context { return this.context; }
  setAttribute(): void {}
  remove(): void { this.removed = true; }
}

function fixture(width = 256, height = 256, containerHeight = height, budget?: PreparationBudget, useGl = false) {
  const canvases: Canvas[] = [], frames = new globalThis.Map<number, FrameRequestCallback>();
  const handlers = new globalThis.Map<string, Set<() => void>>();
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => { const canvas = new Canvas(); canvases.push(canvas); return canvas; } });
  const container = { clientWidth: width, clientHeight: containerHeight, appendChild: vi.fn() };
  const map = {
    getCanvasContainer: () => container,
    getCanvas: () => ({ clientWidth: width, clientHeight: height }),
    on: (name: string, listener: () => void) => { const listeners = handlers.get(name) ?? new Set(); listeners.add(listener); handlers.set(name, listeners); },
    off: (name: string, listener: () => void) => handlers.get(name)?.delete(listener),
    getBounds: () => ({ getWest: () => -45, getEast: () => 45, getNorth: () => 45, getSouth: () => -45 }),
    getZoom: () => 0,
    getBearing: () => 0,
    getPitch: () => 0,
    project: ([lon, lat]: number[]) => ({ x: (lon + 45) * width / 90, y: (45 - lat) * height / 90 }),
    unproject: ([x, y]: number[]) => ({ lng: x * 90 / width - 45, lat: 45 - y * 90 / height })
  };
  let allocations = 0, addedLayers = 0, lost = false, lostClears = 0, layer: CustomLayerInterface | null = null;
  const uploads: ArrayBufferView[] = [];
  let drawGl = () => {}, restoreGl = () => {}, removeGl = () => {};
  if (useGl) {
    const enums = new globalThis.Map<string, number>();
    const gl = new Proxy({} as WebGL2RenderingContext, {
      get(_target, property) {
        const key = String(property);
        if (/^[A-Z0-9_]+$/.test(key)) { if (!enums.has(key)) enums.set(key, enums.size + 1); return enums.get(key); }
        if (key === 'isContextLost') return () => lost;
        if (key === 'getParameter') return (value: number) => lost ? null : value === gl.MAX_TEXTURE_SIZE ? 4096 : value === gl.COLOR_CLEAR_VALUE ? [0, 0, 0, 0] : value === gl.COLOR_WRITEMASK ? [true, true, true, true] : value === gl.VIEWPORT ? [0, 0, width, height] : null;
        if (key === 'getExtension' || key.startsWith('create')) return () => ({});
        if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
        if (key === 'checkFramebufferStatus') return () => gl.FRAMEBUFFER_COMPLETE;
        if (key === 'isEnabled') return () => false;
        if (key === 'texImage2D') return (...args: unknown[]) => { allocations++; if (ArrayBuffer.isView(args[8])) uploads.push(args[8]); };
        if (key === 'clear') return () => { if (lost) lostClears++; };
        return () => {};
      }
    });
    Object.assign(map, {
      addLayer(value: CustomLayerInterface) { addedLayers++; layer = value; value.onAdd!(map as unknown as Map, gl); },
      getLayer: () => layer,
      removeLayer() { layer?.onRemove?.(map as unknown as Map, gl); layer = null; },
      getStyle: () => ({ layers: [{ id: 'av-wind-particles' }] }), moveLayer() {}, once() {}, isStyleLoaded: () => true, triggerRepaint() {}
    });
    drawGl = () => { layer!.prerender!(gl, { modelViewProjectionMatrix: new Float32Array(16) } as never); layer!.render!(gl, {} as never); };
    removeGl = () => { layer?.onRemove?.(map as unknown as Map, gl); layer = null; };
    restoreGl = () => {
      lost = false;
      if (layer) layer.onAdd!(map as unknown as Map, gl); else emit('styledata');
      emit('webglcontextrestored'); emit('styledata'); emit('idle');
    };
  }
  let next = 0;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { devicePixelRatio: 3 });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { const id = ++next; frames.set(id, fn); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const overlay = new WindOverlay(map as unknown as Map, { budget });
  const tick = (time: number) => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); };
  const emit = (name: string) => handlers.get(name)?.forEach(handler => handler());
  return { overlay, canvases, frames, tick, emit, handlers, doc, map, uploads, drawGl, restoreGl, allocations: () => allocations,
    loseGl: (dropLayer = false) => { lost = true; if (dropLayer) removeGl(); emit('webglcontextlost'); }, addedLayers: () => addedLayers, lostClears: () => lostClears };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('keeps real overlay GL and canvas pressure relief stable until wind admission', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024);
  const f = fixture(800, 600, 600, budget, true);
  await Promise.resolve();
  f.overlay.setOptions({ style: 'hybrid' });
  const other = budget.reserve('other', budget.limit - budget.used - 1_048_576)!;
  expect(budget.reserve('wind-numeric', 4_194_304)).toBeNull();
  const before = budget.used;
  expect(f.overlay.relievePressure()).toBe(true);
  const reduced = budget.used, allocations = f.allocations();
  expect(reduced).toBeLessThan(before);
  await Promise.resolve(); await Promise.resolve();
  expect(budget.used).toBe(reduced);
  expect(f.allocations()).toBe(allocations);
  const wind = budget.reserve('wind-numeric', 4_194_304);
  expect(wind).not.toBeNull();
  wind!.release(); other.release(); f.overlay.destroy();
  expect(budget.used).toBe(0);
});

it.each([false, true])('restores latest matching wind after GL loss with custom layer removed: %s', async dropLayer => {
  const budget = createPreparationBudget(128 * 1024 * 1024), f = fixture(800, 600, 600, budget, true);
  await Promise.resolve();
  f.overlay.setOptions({ style: 'hybrid' });
  const grid = (height: 'surface' | number, key: string) => ({ bounds: [-45, -45, 45, 45] as [number, number, number, number], data: new Uint8Array(128 * 128 * 4), size: 128, height, key });
  const first = grid('surface', 'first'), intermediate = grid(500, 'intermediate'), latest = grid(1500, 'latest');
  f.overlay.install({ sample: () => ({ status: 0, u: 10, v: 0 }) }, first); f.drawGl();
  f.loseGl(dropLayer);
  expect(f.frames.size).toBe(0);
  expect(() => f.overlay.clear()).not.toThrow();
  expect(() => f.overlay.install({ sample: () => ({ status: 0, u: 5, v: 0 }) }, intermediate)).not.toThrow();
  expect(() => f.overlay.install({ sample: () => ({ status: 0, u: 20, v: 0 }) }, latest)).not.toThrow();
  expect(f.lostClears()).toBe(0);
  f.canvases[1].context.fillText.mockClear(); f.uploads.length = 0;
  f.restoreGl(); await Promise.resolve();
  f.drawGl(); f.drawGl();
  expect(f.uploads.filter(data => data === latest.data)).toHaveLength(1);
  expect(f.uploads).not.toContain(first.data);
  expect(f.uploads).not.toContain(intermediate.data);
  expect(f.canvases[1].context.fillText).toHaveBeenCalledWith('72', expect.any(Number), expect.any(Number));
  expect(f.addedLayers()).toBe(dropLayer ? 2 : 1);
  expect(f.frames.size).toBe(1);
  f.loseGl();
  expect(() => f.overlay.destroy()).not.toThrow();
  f.overlay.destroy();
  expect(f.frames.size).toBe(0);
  expect(budget.used).toBe(0);
  expect(f.canvases.every(canvas => canvas.removed && canvas.width === 0 && canvas.height === 0)).toBe(true);
  expect([...f.handlers.values()].every(handlers => handlers.size === 0)).toBe(true);
});

it('bounds canvas backing at 128 MiB, retains clear ownership, and recovers on release', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024);
  const other = budget.reserve('other', 127 * 1024 * 1024)!;
  const f = fixture(1200, 800, 800, budget);
  const actual = () => f.canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0);
  for (const canvas of f.canvases) canvas.onSize = () => expect(actual()).toBeLessThanOrEqual(budget.snapshot()['wind-display-canvas'] ?? 0);
  f.overlay.setOptions({ style: 'hybrid' });
  expect(f.overlay.displayMemory.limited).toBe(true);
  expect(f.overlay.displayMemory.canvasBytes).toBe(actual());
  expect(budget.used).toBe(other.bytes + actual());
  const reduced = actual();
  f.overlay.clear();
  expect(budget.used).toBe(other.bytes + reduced);
  other.release();
  await Promise.resolve();
  expect(actual()).toBeGreaterThan(reduced);
  expect(f.overlay.displayMemory.limited).toBe(false);
  expect(budget.used).toBe(actual());
  const full = actual();
  expect(f.overlay.relievePressure()).toBe(true);
  expect(actual()).toBeLessThan(full);
  const use = budget.reserve('wind-numeric', 131_072)!;
  await Promise.resolve();
  expect(actual()).toBeLessThan(full);
  use.release();
  await Promise.resolve();
  expect(actual()).toBe(full);
  for (const style of ['barbs', 'hybrid', 'trails', 'hybrid'] as const) {
    f.overlay.setOptions({ style });
    expect(budget.used).toBe(actual());
  }
  f.overlay.destroy();
  expect(actual()).toBe(0);
  expect(budget.used).toBe(0);
  expect(f.overlay.displayMemory).toEqual({ canvasBytes: 0, glBytes: 0, limited: false });
});

it('clears CPU trail and barb pixels before installing a different time', () => {
  const f = fixture();
  f.overlay.setOptions({ style: 'hybrid' });
  f.overlay.setField({ sample: () => ({ status: 0, u: 10, v: 0 }) });
  f.tick(100); f.tick(200);
  for (const canvas of f.canvases) canvas.context.clearRect.mockClear();
  f.overlay.clear();
  for (const canvas of f.canvases) expect(canvas.context.clearRect).toHaveBeenCalled();
  f.overlay.setField({ sample: () => ({ status: 0, u: -10, v: 0 }) }, 'swap');
  f.overlay.destroy();
});

it('sizes and renders against the map canvas when its append container has zero height', () => {
  const f = fixture(1200, 800, 0);
  f.overlay.setOptions({ style: 'hybrid' });
  f.overlay.setField({ sample: () => ({ status: 0, u: 10, v: 0 }) });
  for (const canvas of f.canvases) {
    expect(canvas.height).toBeGreaterThan(1);
    expect(canvas.style.width).toBe('1200px');
    expect(canvas.style.height).toBe('800px');
  }
  expect(f.canvases[1].context.fillText).toHaveBeenCalled();
  expect(f.frames.size).toBe(1);
  f.overlay.destroy();
});

it('clears the presented GPU frame when the style switches to barbs', () => {
  const f = fixture(256, 256, 256, undefined, true);
  f.overlay.setOptions({ style: 'hybrid' });
  f.overlay.setField({ sample: () => ({ status: 0, u: 10, v: 0 }) }, 'replace', 'f001');
  f.drawGl();
  expect(f.overlay.renderState?.frame).toBe('f001');
  f.overlay.setOptions({ style: 'barbs' });
  expect(f.overlay.renderState?.frame).toBeNull();
  f.overlay.destroy();
});

it('uses valid paired samples for barb labels and never renders missing wind as calm', () => {
  const f = fixture();
  const field: WindField = { sample: () => ({ status: 2, u: 0, v: 0 }) };
  f.overlay.setOptions({ style: 'barbs' }); f.overlay.setField(field);
  const context = f.canvases[1].context;
  expect(context.fillText).not.toHaveBeenCalled();
  f.overlay.setField({ sample: () => ({ status: 0, u: 0, v: 0 }) });
  expect(context.arc).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 2.5, 0, Math.PI * 2);
  expect(context.fillText).not.toHaveBeenCalled();
  context.fillText.mockClear();
  f.overlay.setField({ sample: () => ({ status: 0, u: 10, v: 0 }) });
  expect(context.fillText).toHaveBeenCalledWith('36', expect.any(Number), expect.any(Number));
  expect(context.rotate).toHaveBeenCalledWith(0);
  f.overlay.setOptions({ units: 'imperial' });
  expect(context.fillText).toHaveBeenCalledWith('22', expect.any(Number), expect.any(Number));
  expect(f.frames.size).toBe(0);
  f.overlay.destroy();
});

it.each(['metric', 'imperial'] as const)('uses shared 2.5-knot calm thresholds and agrees with windgram barb geometry in %s', units => {
  const f = fixture();
  f.overlay.setOptions({ style: 'barbs', units });
  const ctx = f.canvases[1].context;
  const knotsPerMps = 1.9438444924, displayFactor = units === 'metric' ? 3.6 : 2.2369362921;
  for (const kt of [0, 0.4, 1.5, 2.49, 2.5, 5, 10, 20, 48, 65]) {
    const mps = kt / knotsPerMps;
    const wg = barbGeometry(kt, 270, 21, false);
    let sampled = false;
    ctx.fillText.mockClear(); ctx.arc.mockClear(); ctx.fill.mockClear(); ctx.lineTo.mockClear();
    f.overlay.setField({ sample: () => {
      if (sampled) return { status: 2, u: null, v: null };
      sampled = true; return { status: 0, u: mps, v: 0 };
    } });
    if (wg.calm) {
      expect(ctx.arc).toHaveBeenCalled();
      expect(ctx.fillText).not.toHaveBeenCalled();
    } else {
      expect(ctx.arc).not.toHaveBeenCalled();
      expect(ctx.fillText).toHaveBeenCalledWith(String(Math.trunc(mps * displayFactor)), expect.any(Number), expect.any(Number));
      const pennants = wg.flags.filter(flag => flag.endsWith('Z')).length;
      expect(ctx.fill).toHaveBeenCalledTimes(pennants);
      expect(ctx.lineTo).toHaveBeenCalledTimes(1 + pennants + wg.flags.length);
    }
  }
  f.overlay.destroy();
});

it.each(['metric', 'imperial'] as const)('draws WMO/ICAO knot pennants and feathers while formatting %s labels', units => {
  const f = fixture();
  f.overlay.setOptions({ style: 'barbs', units });
  const ctx = f.canvases[1].context;
  const knotsPerMps = 1.9438444924, displayFactor = units === 'metric' ? 3.6 : 2.2369362921;
  for (const [kt, flags, full, half] of [
    [2.5, 0, 0, 1], [3, 0, 0, 1], [7, 0, 0, 1], [8, 0, 1, 0], [20, 0, 2, 0],
    [47, 0, 4, 1], [48, 1, 0, 0], [52, 1, 0, 0], [53, 1, 0, 1],
    [57, 1, 0, 1], [58, 1, 1, 0], [98, 2, 0, 0], [100, 2, 0, 0], [145, 2, 4, 1]
  ]) {
    let sampled = false;
    const mps = (kt + 0.001) / knotsPerMps;
    ctx.fill.mockClear(); ctx.lineTo.mockClear(); ctx.fillText.mockClear();
    f.overlay.setField({ sample: () => {
      if (sampled) return { status: 2, u: null, v: null };
      sampled = true; return { status: 0, u: mps, v: 0 };
    } });
    expect(ctx.fillText).toHaveBeenCalledWith(String(Math.trunc(mps * displayFactor)), expect.any(Number), expect.any(Number));
    expect(ctx.fill).toHaveBeenCalledTimes(flags);
    expect(ctx.lineTo).toHaveBeenCalledTimes(1 + 2 * flags + full + half);
    if (half) {
      const halfEnd = ctx.lineTo.mock.calls.at(-1) as unknown as number[];
      expect(halfEnd[1]).toBe(-3);
    }
  }
  f.overlay.destroy();
});

it.each([
  [5, 0, 0], [0, 5, -Math.PI / 2], [-5, 0, Math.PI], [0, -5, Math.PI / 2]
])('points the staff downwind for u=%s v=%s', (u, v, angle) => {
  const f = fixture();
  f.overlay.setOptions({ style: 'barbs' });
  f.overlay.setField({ sample: () => ({ status: 0, u, v }) });
  expect(f.canvases[1].context.rotate).toHaveBeenCalled();
  for (const call of f.canvases[1].context.rotate.mock.calls) expect((call as unknown as number[])[0]).toBeCloseTo(angle);
  f.overlay.destroy();
});

it('clears connected trails when the field is swapped', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const f = fixture();
  f.overlay.setField({ sample: () => ({ status: 0, u: 10, v: 0 }) });
  f.tick(1000); f.tick(1100);
  f.canvases[0].context.clearRect.mockClear();
  f.overlay.setField({ sample: () => ({ status: 0, u: 0, v: 10 }) }, 'swap');
  expect(f.canvases[0].context.clearRect).toHaveBeenCalled();
  f.overlay.destroy();
});

it('advects connected trails downwind and clears them on replacement', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const f = fixture(), field: WindField = { sample: () => ({ status: 0, u: 10, v: 0 }) };
  f.overlay.setField(field); f.tick(1000); f.tick(1100);
  const context = f.canvases[0].context;
  expect(context.moveTo).toHaveBeenCalled();
  const start = context.moveTo.mock.calls[0] as unknown as number[], end = context.lineTo.mock.calls[0] as unknown as number[];
  expect(end[0]).toBeGreaterThan(start[0]); expect(end[1]).toBeCloseTo(start[1]);
  context.clearRect.mockClear();
  f.overlay.setField({ sample: () => ({ status: 2, u: null, v: null }) });
  expect(context.clearRect).toHaveBeenCalled();
  context.lineTo.mockClear(); f.tick(1200); f.tick(1300);
  expect(context.lineTo).not.toHaveBeenCalled();
  f.overlay.destroy();
});

it('advances trails on successive display frames without a 30 Hz cap', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const f = fixture();
  f.overlay.setField({ sample: () => ({ status: 0, u: 10, v: 0 }) });
  f.tick(1000); f.tick(1016.7); f.tick(1033.4);
  expect(f.canvases[0].context.stroke).toHaveBeenCalledTimes(2);
  f.overlay.destroy();
});

it('reuses each validated destination on the next animation step', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const f = fixture(), sample = vi.fn(() => ({ status: 0, u: 10, v: 0 }));
  f.overlay.setField({ sample }); f.tick(1000); f.tick(1100);
  const count = Math.ceil(256 * 256 / 3000);
  const firstSamples = sample.mock.calls.length;
  expect(firstSamples).toBeGreaterThan(count);
  expect(f.canvases[0].context.moveTo).toHaveBeenCalledTimes(count);
  sample.mockClear(); f.tick(1200);
  expect(sample).toHaveBeenCalledTimes(firstSamples - count);
  f.overlay.destroy();
});

it.each([2, 1, 3])('stops a trail before entering a cell with status %s', status => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const f = fixture();
  f.overlay.setField({ sample: (_lat, lon) => lon > 0 ? { status, u: null, v: null } : { status: 0, u: 10, v: 0 } });
  f.tick(1000); f.tick(1100);
  expect(f.canvases[0].context.lineTo).not.toHaveBeenCalled();
  f.overlay.destroy();
});

it.each([0, 6, 16])('keeps normal wind visible at zoom %s and checks gaps within its path', zoom => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const f = fixture();
  f.map.getZoom = () => zoom;
  const pixelsPerDegree = 512 * 2 ** zoom / 360;
  f.map.project = ([lon, lat]) => ({ x: 128 + lon * pixelsPerDegree, y: 128 - lat * pixelsPerDegree });
  f.map.unproject = ([x, y]) => ({ lng: (x - 128) / pixelsPerDegree, lat: (128 - y) / pixelsPerDegree });
  f.overlay.setField({ sample: () => ({ status: 0, u: 20, v: 0 }) });
  f.tick(1000); f.tick(1100);
  const ctx = f.canvases[0].context;
  expect(ctx.lineTo).toHaveBeenCalled();
  const endpoint = (ctx.lineTo.mock.calls[0] as unknown as number[])[0];
  expect(endpoint).toBeGreaterThan(130);
  expect(endpoint).toBeLessThan(158);
  ctx.lineTo.mockClear();
  f.overlay.setField({ sample: (_lat, lon) => {
    const x = lon * pixelsPerDegree;
    return x > 2 && x < 4 ? { status: 2, u: null, v: null } : { status: 0, u: 20, v: 0 };
  } });
  f.tick(1200); f.tick(1300);
  expect(ctx.lineTo).not.toHaveBeenCalled();
  f.overlay.destroy();
});

it('anchors sparse barbs to a subset of the full world lattice', () => {
  const f = fixture(), sample = vi.fn(() => ({ status: 0, u: 5, v: 0 }));
  f.overlay.setOptions({ style: 'barbs' }); f.overlay.setField({ sample });
  const full = new Set(sample.mock.calls.map(call => JSON.stringify(call)));
  const ctx = f.canvases[1].context;
  const positions = new Set(ctx.translate.mock.calls.map(call => JSON.stringify(call)));
  expect(full.size).toBeGreaterThan(0);
  sample.mockClear(); ctx.translate.mockClear(); f.overlay.setOptions({ style: 'hybrid', paused: true });
  expect(sample).not.toHaveBeenCalled();
  const sparse = ctx.translate.mock.calls.map(call => JSON.stringify(call));
  expect(sparse.length).toBeGreaterThan(0);
  expect(sparse.length).toBeLessThan(positions.size);
  expect(sparse.every(point => positions.has(point))).toBe(true);
  f.overlay.destroy();
});

it.each([2.9, 3, 3.1])('keeps 32 px world-anchored barb spacing at zoom %s while panning', zoom => {
  const f = fixture(), size = 512 * 2 ** zoom;
  let centerX = size / 2;
  const centerY = size / 2;
  const lat = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI;
  const worldY = (latitude: number) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) * size / 2;
  f.map.getZoom = () => zoom;
  f.map.getBounds = () => ({
    getWest: () => (centerX - 128) / size * 360 - 180,
    getEast: () => (centerX + 128) / size * 360 - 180,
    getNorth: () => lat(centerY - 128),
    getSouth: () => lat(centerY + 128)
  });
  f.map.project = ([lon, latitude]: number[]) => ({ x: (lon + 180) / 360 * size - centerX + 128, y: worldY(latitude) - centerY + 128 });
  const sample = vi.fn((_lat: number, _lon: number) => ({ status: 0, u: 5, v: 0 }));
  f.overlay.setOptions({ style: 'barbs' }); f.overlay.setField({ sample });
  if (zoom === 3) expect(sample).toHaveBeenCalledTimes(64);
  const positions = (f.canvases[1].context.translate.mock.calls as unknown as number[][]);
  const xs = [...new Set(positions.map(([x]) => Number(x.toFixed(6))))].sort((a, b) => a - b);
  const ys = [...new Set(positions.map(([, y]) => Number(y.toFixed(6))))].sort((a, b) => a - b);
  expect(xs.length).toBeGreaterThan(1); expect(ys.length).toBeGreaterThan(1);
  for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(32, 5);
  for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(32, 5);
  const original = new Set(sample.mock.calls.map(call => JSON.stringify(call)));
  sample.mockClear(); centerX += 7; f.emit('move'); f.tick(1000);
  const moved = sample.mock.calls.map(call => JSON.stringify(call));
  expect(moved.every(point => !original.has(point))).toBe(true);
  expect(moved.length).toBeLessThan(original.size / 2);
  sample.mockClear(); f.emit('move'); f.tick(1016); expect(sample).not.toHaveBeenCalled();
  if (zoom === 3) {
    centerX -= 7; f.overlay.setField({ sample });
    expect(sample).toHaveBeenCalledTimes(64);
    sample.mockClear(); centerX += 32; f.emit('move'); f.tick(1032);
    expect(sample).toHaveBeenCalledTimes(8);
    sample.mockClear(); f.overlay.setField({ sample });
    expect(sample).toHaveBeenCalledTimes(64);
    sample.mockClear();
  }
  f.map.getZoom = () => zoom + 0.1; f.emit('move'); f.tick(1048); expect(sample).toHaveBeenCalled();
  f.overlay.destroy();
});

it('translates trail history during pan and clears it on zoom', () => {
  const f = fixture();
  let offset = 0, zoom = 0;
  f.map.project = ([lon, lat]: number[]) => ({ x: lon + offset, y: -lat });
  f.map.getZoom = () => zoom;
  f.emit('resize');
  const ctx = f.canvases[0].context;
  ctx.clearRect.mockClear(); offset = 10; f.emit('move');
  expect(ctx.drawImage).toHaveBeenCalled();
  expect(ctx.clearRect).not.toHaveBeenCalled();
  zoom = 1; f.emit('move'); expect(ctx.clearRect).toHaveBeenCalled();
  f.overlay.destroy();
});

it('bounds canvas memory within WIND_CANVAS_BYTES across styles and viewports and suspends frames appropriately', () => {
  for (const [w, h] of [[1200, 800], [1920, 1000], [2027, 815], [6000, 4000]] as const) {
    const check = fixture(w, h);
    for (const style of ['trails', 'barbs', 'hybrid'] as const) {
      check.overlay.setOptions({ style, visible: true });
      const totalBytes = check.canvases.reduce((sum, c) => sum + c.width * c.height * 4, 0);
      expect(totalBytes).toBeLessThanOrEqual(WIND_CANVAS_BYTES);
      expect(check.canvases[0].width * check.canvases[0].height).toBeLessThanOrEqual(WIND_TRAIL_PIXELS);
    }
    check.overlay.destroy();
  }
  const f = fixture(6000, 4000);
  expect(f.canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)).toBeLessThanOrEqual(WIND_TRAIL_PIXELS);
  f.overlay.setField({ sample: () => ({ status: 0, u: 1, v: 1 }) });
  expect(f.frames.size).toBe(1);
  f.overlay.setOptions({ paused: true }); expect(f.frames.size).toBe(0);
  f.overlay.setOptions({ paused: false }); expect(f.frames.size).toBe(1);
  f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange')); expect(f.frames.size).toBe(0);
  f.doc.hidden = false; f.doc.dispatchEvent(new Event('visibilitychange')); expect(f.frames.size).toBe(1);
  f.emit('webglcontextlost'); expect(f.frames.size).toBe(0);
  f.canvases[0].dispatchEvent(new Event('contextlost'));
  f.emit('webglcontextrestored'); expect(f.frames.size).toBe(0);
  f.canvases[0].dispatchEvent(new Event('contextrestored')); expect(f.frames.size).toBe(1);
  f.overlay.setOptions({ visible: false }); expect(f.frames.size).toBe(0);
  f.overlay.setOptions({ visible: true }); expect(f.frames.size).toBe(1);
  f.overlay.destroy(); expect(f.frames.size).toBe(0);
  expect(f.canvases.every(canvas => canvas.removed)).toBe(true);
  expect([...f.handlers.values()].every(handlers => handlers.size === 0)).toBe(true);
});

it('releases both backing stores before allocating resized canvases', () => {
  const f = fixture(6000, 4000);
  const sizes: number[] = [];
  for (const canvas of f.canvases) canvas.onSize = () => sizes.push(f.canvases.reduce((sum, item) => sum + item.width * item.height, 0));
  f.map.getCanvas = () => ({ clientWidth: 4000, clientHeight: 6000 });
  f.emit('resize');
  expect(sizes).toContain(0);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(2_097_152);
  expect(f.canvases.every(canvas => canvas.width > 0 && canvas.height > 0)).toBe(true);
  f.overlay.destroy();
});

it.each(['map', 'trails', 'barbs'] as const)('clears both canvases and redraws only after %s context restoration', source => {
  const f = fixture();
  f.overlay.setOptions({ style: 'hybrid' });
  f.overlay.setField({ sample: () => ({ status: 0, u: 10, v: 0 }) });
  const [trails, barbs] = f.canvases;
  expect(barbs.context.fillText).toHaveBeenCalled();
  trails.context.clearRect.mockClear(); barbs.context.clearRect.mockClear(); barbs.context.fillText.mockClear();
  if (source === 'map') f.emit('webglcontextlost');
  else (source === 'trails' ? trails : barbs).dispatchEvent(new Event('contextlost'));
  expect(trails.context.setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, 0);
  expect(trails.context.clearRect).toHaveBeenCalledWith(0, 0, trails.width, trails.height);
  expect(barbs.context.clearRect).toHaveBeenCalledWith(0, 0, barbs.width, barbs.height);
  expect(f.frames.size).toBe(0);
  f.emit('move'); f.overlay.setOptions({ units: 'imperial' });
  expect(barbs.context.fillText).not.toHaveBeenCalled();
  if (source === 'map') f.emit('webglcontextrestored');
  else (source === 'trails' ? trails : barbs).dispatchEvent(new Event('contextrestored'));
  expect(barbs.context.fillText).toHaveBeenCalled();
  expect(f.frames.size).toBe(1);
  f.overlay.destroy();
});


it('gives barb labels a full 2x Retina backing store, pixel alignment and contrast halo', () => {
  const f = fixture(1200, 800);
  f.overlay.setOptions({ style: 'barbs' });
  f.overlay.setField({ sample: () => ({ status: 0, u: 4, v: 0 }) });
  const [trails, barbs] = f.canvases;
  expect([barbs.width, barbs.height]).toEqual([2400, 1600]);
  expect(barbs.width).toBeGreaterThan(trails.width);
  expect(barbs.context.strokeText.mock.calls).toEqual(barbs.context.fillText.mock.calls);
  expect(barbs.context.fillText).toHaveBeenCalledWith('14', expect.any(Number), expect.any(Number));
  f.overlay.destroy();
});

it('keeps desktop barbs at 2x Retina resolution, throttles 120 Hz fade quantization, and boosts light-wind visibility', () => {
  const f = fixture(2027, 815);
  const [trails, barbs] = f.canvases;
  for (const style of ['barbs', 'hybrid', 'trails', 'barbs'] as const) {
    f.overlay.setOptions({ style });
    if (style !== 'trails') expect([barbs.width, barbs.height]).toEqual([4054, 1630]);
    else expect([barbs.width, barbs.height]).toEqual([1, 1]);
    if (style === 'barbs') expect([trails.width, trails.height]).toEqual([1, 1]);
  }
  f.overlay.setOptions({ style: 'trails' });
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  f.overlay.setField({ sample: () => ({ status: 0, u: 0, v: -1.2 }) });
  trails.context.stroke.mockClear();
  f.tick(1000);
  f.tick(1008.3);
  expect(trails.context.stroke).not.toHaveBeenCalled();
  f.tick(1016.7);
  expect(trails.context.stroke).toHaveBeenCalledOnce();
  f.overlay.setOptions({ visible: false });
  expect(f.canvases.every(canvas => canvas.width === 1 && canvas.height === 1)).toBe(true);
  f.overlay.destroy();
});

it('coalesces barb drawing during map motion into one display frame', () => {
  const f = fixture(), sample = vi.fn(() => ({ status: 0, u: 5, v: 0 }));
  f.overlay.setOptions({ style: 'barbs' }); f.overlay.setField({ sample });
  const ctx = f.canvases[1].context;
  ctx.clearRect.mockClear(); sample.mockClear();
  f.emit('move'); f.emit('move'); f.emit('move');
  expect(ctx.clearRect).not.toHaveBeenCalled();
  expect(f.frames.size).toBe(1);
  f.tick(1000);
  expect(ctx.clearRect).toHaveBeenCalledTimes(1);
  expect(sample).not.toHaveBeenCalled();
  expect(f.frames.size).toBe(0);
  f.overlay.destroy();
});

it('flips barb feathers in the Southern Hemisphere, formats knots, and accumulates sub-pixel pans', () => {
  const f = fixture();
  f.overlay.setOptions({ style: 'barbs', units: 'knots' });
  const barbCtx = f.canvases[1].context;
  f.overlay.setField({ sample: lat => lat < 0 ? { status: 0, u: 10, v: 0 } : { status: 2, u: null, v: null } });
  expect(barbCtx.fillText).toHaveBeenCalledWith('19', expect.any(Number), expect.any(Number));
  const featherEnds = barbCtx.lineTo.mock.calls.filter(([, y]) => y !== 0) as unknown as number[][];
  expect(featherEnds.length).toBeGreaterThan(0);
  expect(featherEnds.every(([, y]) => y > 0)).toBe(true);

  let offset = 0;
  f.map.project = ([lon, lat]: number[]) => ({ x: lon + offset, y: -lat });
  f.overlay.setOptions({ style: 'trails' });
  const trailCtx = f.canvases[0].context;
  trailCtx.drawImage.mockClear();
  offset = 0.4; f.emit('move');
  expect(trailCtx.drawImage).not.toHaveBeenCalled();
  offset = 1.1; f.emit('move');
  expect(trailCtx.drawImage).toHaveBeenCalledWith(f.canvases[0], 1, 0);
  f.overlay.destroy();
});
