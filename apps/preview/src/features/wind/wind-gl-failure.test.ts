import { afterEach, expect, it, vi } from 'vitest';
import type { CustomLayerInterface, Map } from 'maplibre-gl';
import { createPreparationBudget } from '@av/client';
import { attachWindGl } from './wind-gl';

afterEach(() => vi.unstubAllGlobals());

function context(fail: string, occurrence = 1) {
  const enums = new globalThis.Map<string, number>(), live = new Set<object>();
  const uploads: ArrayBufferView[] = [], deleted = new Set<object>();
  let calls = 0, draws = 0, clears = 0, lost = false, loseAt: string | null = null;
  const gl = new Proxy({} as WebGL2RenderingContext, {
    get(_target, property) {
      const key = String(property);
      if (/^[A-Z0-9_]+$/.test(key)) {
        if (!enums.has(key)) enums.set(key, enums.size + 1);
        return enums.get(key);
      }
      if (key.startsWith('create')) return () => {
        if (key === fail && ++calls === occurrence) return null;
        const object = {}; live.add(object); return object;
      };
      if (key.startsWith('delete')) return (object: object) => {
        live.delete(object); deleted.add(object);
        if (key === fail && ++calls === occurrence) throw new Error('delete failure');
      };
      if (key === 'getExtension') return () => ({});
      if (key === 'isContextLost') return () => lost;
      if (key === 'getParameter') return (value: number) => {
        if (loseAt && value === enums.get(loseAt)) lost = true;
        if (lost) return null;
        if (value === gl.MAX_TEXTURE_SIZE) return 4096;
        if (value === gl.COLOR_CLEAR_VALUE) return new Float32Array(4);
        if (value === gl.COLOR_WRITEMASK) return [true, true, true, true];
        if (value === gl.VIEWPORT) return new Int32Array([0, 0, 512, 512]);
        return null;
      };
      if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => key !== fail || ++calls !== occurrence;
      if (key === 'checkFramebufferStatus') return () => key === fail && ++calls === occurrence ? 0 : gl.FRAMEBUFFER_COMPLETE;
      if (key === 'drawArrays') return () => { draws++; if (fail === key) throw new Error('draw failure'); };
      if (key === 'clear') return () => { clears++; };
      if (key === 'texImage2D') return (...args: unknown[]) => {
        if (ArrayBuffer.isView(args[8])) uploads.push(args[8]);
        if (key === fail && ++calls === occurrence) throw new Error('allocation failure');
      };
      return () => { if (key === fail && ++calls === occurrence) throw new Error('allocation failure'); };
    }
  });
  return { gl, live, uploads, deleted, get draws() { return draws; }, get clears() { return clears; },
    lose(query: string | null = null) { loseAt = query; lost = query === null; } };
}

function mount(first: ReturnType<typeof context>, loaded = true, removeFails = false) {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  const budget = createPreparationBudget(128 * 1024 * 1024), handlers = new globalThis.Map<string, Set<() => void>>();
  let layer: CustomLayerInterface | null = null;
  const listen = (name: string, handler: () => void) => { const listeners = handlers.get(name) ?? new Set(); listeners.add(handler); handlers.set(name, listeners); };
  const map = {
    addLayer: vi.fn((value: CustomLayerInterface) => { layer = value; value.onAdd!(map as unknown as Map, first.gl); }),
    getLayer: () => layer,
    removeLayer: vi.fn(() => { if (removeFails) throw new Error('layer removal failure'); layer?.onRemove?.(map as unknown as Map, first.gl); layer = null; }),
    getStyle: () => ({ layers: [{ id: 'av-wind-particles' }] }), moveLayer() {}, on: listen, once: listen,
    off(name: string, handler: () => void) { handlers.get(name)?.delete(handler); },
    isStyleLoaded: () => loaded,
    getCanvas: () => ({ width: 512, height: 512, clientWidth: 512, clientHeight: 512 }),
    getZoom: () => 8, getCenter: () => ({ lng: 0.5, lat: 0.5 }), project: () => ({ x: 0, y: 0 }), triggerRepaint() {}
  };
  const ready = vi.fn(), renderer = attachWindGl(map as unknown as Map, ready, budget)!;
  const draw = (gl: WebGL2RenderingContext) => {
    layer!.prerender!(gl, { modelViewProjectionMatrix: new Float32Array(16) } as never);
    layer!.render!(gl, {} as never);
  };
  return { budget, handlers, map, ready, renderer, draw, get layer() { return layer; } };
}

it.each([
  ['createProgram', 1], ['createShader', 2], ['shaderSource', 2], ['getShaderParameter', 1], ['linkProgram', 2], ['getProgramParameter', 2],
  ['createVertexArray', 1], ['createTexture', 2], ['texParameteri', 5],
  ['createFramebuffer', 2], ['framebufferTexture2D', 3], ['checkFramebufferStatus', 2], ['texImage2D', 5]
] as const)('cleans partial GL initialization when %s fails at %i and restores current field', async (stage, occurrence) => {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const budget = createPreparationBudget(128 * 1024 * 1024), first = context(stage, occurrence), next = context('');
  let layer: CustomLayerInterface | null = null;
  const map = {
    addLayer(value: CustomLayerInterface) { layer = value; value.onAdd!(map as unknown as Map, first.gl); },
    getLayer: () => layer,
    removeLayer() { layer?.onRemove?.(map as unknown as Map, next.gl); layer = null; },
    getStyle: () => ({ layers: [{ id: 'av-wind-particles' }] }), moveLayer() {}, on() {}, off() {}, once() {},
    isStyleLoaded: () => true,
    getCanvas: () => ({ width: 512, height: 512, clientWidth: 512, clientHeight: 512 }),
    triggerRepaint() {}
  };
  const ready = vi.fn(), renderer = attachWindGl(map as unknown as Map, ready, budget)!;
  await Promise.resolve();
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(first.live.size).toBe(0);
  expect(budget.used).toBe(0);
  const prepared = { bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(128 * 128 * 4), size: 128, height: 'surface' as const, key: 'current' };
  renderer.setPrepared(prepared); renderer.setMotion(false, false);
  (layer as unknown as CustomLayerInterface).onAdd!(map as unknown as Map, next.gl);
  await Promise.resolve();
  expect(ready).toHaveBeenLastCalledWith(true);
  (layer as unknown as CustomLayerInterface).render!(next.gl, {} as never);
  expect(next.draws).toBe(1);
  renderer.destroy();
  expect(next.live.size).toBe(0);
  expect(budget.used).toBe(0);
});

it('releases GL objects on render failure and recovers on a new context', async () => {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const budget = createPreparationBudget(128 * 1024 * 1024), first = context('drawArrays'), next = context('');
  let layer: CustomLayerInterface | null = null;
  const map = {
    addLayer(value: CustomLayerInterface) { layer = value; value.onAdd!(map as unknown as Map, first.gl); },
    getLayer: () => layer,
    removeLayer() { layer?.onRemove?.(map as unknown as Map, next.gl); layer = null; },
    getStyle: () => ({ layers: [{ id: 'av-wind-particles' }] }), moveLayer() {}, on() {}, off() {}, once() {},
    isStyleLoaded: () => true,
    getCanvas: () => ({ width: 512, height: 512, clientWidth: 512, clientHeight: 512 }),
    triggerRepaint() {}
  };
  const ready = vi.fn(), renderer = attachWindGl(map as unknown as Map, ready, budget)!;
  renderer.setPrepared({ bounds: [0, 0, 1, 1], data: new Uint8Array(128 * 128 * 4), size: 128, height: 'surface', key: 'current' });
  renderer.setMotion(false, false);
  (layer as unknown as CustomLayerInterface).render!(first.gl, {} as never);
  await Promise.resolve();
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(first.live.size).toBe(0);
  expect(budget.used).toBe(0);
  (layer as unknown as CustomLayerInterface).onAdd!(map as unknown as Map, next.gl);
  await Promise.resolve();
  expect(ready).toHaveBeenLastCalledWith(true);
  (layer as unknown as CustomLayerInterface).render!(next.gl, {} as never);
  expect(next.draws).toBe(1);
  renderer.destroy();
  expect(next.live.size).toBe(0);
  expect(budget.used).toBe(0);
});

it.each([null, 'COLOR_CLEAR_VALUE', 'COLOR_WRITEMASK'])('keeps the latest field through context loss at %s and restoration', async query => {
  const first = context(''), next = context(''), f = mount(first);
  await Promise.resolve();
  const prepared = (key: string) => ({ bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(128 * 128 * 4), size: 128, height: 'surface' as const, key });
  const initial = prepared('initial'), intermediate = prepared('intermediate'), latest = prepared('latest');
  f.renderer.setPrepared(initial); f.renderer.setMotion(false, false); f.draw(first.gl);
  expect(first.uploads.filter(data => data === initial.data)).toHaveLength(1);
  const bytes = f.budget.used;
  first.lose(query);
  expect(() => f.renderer.reset()).not.toThrow();
  expect(first.clears).toBe(0);
  f.renderer.setFields(null, null);
  f.renderer.setPrepared(intermediate); f.renderer.setPrepared(latest);
  expect(() => f.renderer.reset()).not.toThrow();
  f.layer!.onAdd!(f.map as unknown as Map, next.gl);
  await Promise.resolve();
  expect(f.ready).toHaveBeenLastCalledWith(true);
  expect(first.live.size).toBe(0);
  expect(f.budget.used).toBe(bytes);
  f.draw(next.gl); f.draw(next.gl);
  expect(next.uploads.filter(data => data === latest.data)).toHaveLength(1);
  expect(next.uploads).not.toContain(initial.data);
  expect(next.uploads).not.toContain(intermediate.data);
  expect(f.map.addLayer).toHaveBeenCalledOnce();
  f.renderer.destroy(); f.renderer.destroy();
  expect(next.live.size).toBe(0);
  expect(f.budget.used).toBe(0);
  expect([...f.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
});

it('finishes teardown when layer removal and one native deletion throw', () => {
  const first = context('deleteTexture'), f = mount(first, true, true), owned = [...first.live];
  expect(owned).not.toHaveLength(0);
  expect(() => f.renderer.destroy()).not.toThrow();
  expect(first.live.size).toBe(0);
  expect(owned.every(object => first.deleted.has(object))).toBe(true);
  expect(f.budget.used).toBe(0);
  expect([...f.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
  f.renderer.destroy();
  expect(f.map.removeLayer).toHaveBeenCalledOnce();
  f.layer!.onAdd!(f.map as unknown as Map, first.gl);
  expect(first.live.size).toBe(0);
  expect(f.budget.used).toBe(0);
});

it('keeps shader cleanup failure from orphaning the compiled program', async () => {
  const first = context('deleteShader'), f = mount(first);
  await Promise.resolve();
  expect(f.ready).toHaveBeenLastCalledWith(true);
  f.renderer.destroy();
  expect(first.live.size).toBe(0);
  expect(f.budget.used).toBe(0);
});

it('unsubscribes a pending style mount when destroyed before initialization', () => {
  const f = mount(context(''), false);
  expect(f.handlers.get('style.load')?.size).toBe(1);
  f.renderer.destroy(); f.renderer.destroy();
  expect([...f.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
  expect(f.map.addLayer).not.toHaveBeenCalled();
  expect(f.budget.used).toBe(0);
});

it('contains trail allocation failure during pressure relief and releases staged reservations', async () => {
  const first = context('texImage2D', 7), f = mount(first);
  await Promise.resolve();
  expect(f.ready).toHaveBeenLastCalledWith(true);
  expect(() => f.renderer.relievePressure()).not.toThrow();
  await Promise.resolve();
  expect(f.ready).toHaveBeenLastCalledWith(false);
  expect(first.live.size).toBe(0);
  expect(f.budget.used).toBe(0);
  expect(f.renderer.bytes).toBe(0);
  f.renderer.destroy();
});

it('contains trail allocation failure when released capacity restores resolution', async () => {
  const first = context('texImage2D', 9), f = mount(first);
  await Promise.resolve();
  const other = f.budget.reserve('other', 65536)!;
  const pending: VoidFunction[] = [];
  vi.stubGlobal('queueMicrotask', (callback: VoidFunction) => pending.push(callback));
  expect(f.renderer.relievePressure()).toBe(true);
  other.release();
  for (let count = 0; pending.length && count < 8; count++) expect(() => pending.shift()!()).not.toThrow();
  expect(pending).toHaveLength(0);
  expect(f.ready).toHaveBeenLastCalledWith(false);
  expect(first.live.size).toBe(0);
  expect(f.budget.used).toBe(0);
  f.renderer.destroy();
});
