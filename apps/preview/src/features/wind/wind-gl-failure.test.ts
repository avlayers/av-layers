import { afterEach, expect, it, vi } from 'vitest';
import type { CustomLayerInterface, Map } from 'maplibre-gl';
import { createPreparationBudget } from '@av/client';
import { attachWindGl } from './wind-gl';

afterEach(() => vi.unstubAllGlobals());

function context(fail: string, occurrence = 1) {
  const enums = new globalThis.Map<string, number>(), live = new Set<object>();
  let calls = 0, draws = 0;
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
      if (key.startsWith('delete')) return (object: object) => { live.delete(object); };
      if (key === 'getExtension') return () => ({});
      if (key === 'getParameter') return (value: number) => value === gl.MAX_TEXTURE_SIZE ? 4096 : null;
      if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => key !== fail || ++calls !== occurrence;
      if (key === 'checkFramebufferStatus') return () => key === fail && ++calls === occurrence ? 0 : gl.FRAMEBUFFER_COMPLETE;
      if (key === 'drawArrays') return () => { draws++; if (fail === key) throw new Error('draw failure'); };
      return () => { if (key === fail && ++calls === occurrence) throw new Error('allocation failure'); };
    }
  });
  return { gl, live, get draws() { return draws; } };
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
