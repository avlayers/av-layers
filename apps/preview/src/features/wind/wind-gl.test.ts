import { afterEach, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { createPreparationBudget } from '@av/client';
import { WIND_CANVAS_BYTES } from '../raster/raster-budget';
import { WIND_PARTICLE_UPDATE, attachWindGl, encodeWindByte, mixWindVectors, preparedWorldShift, sampleEncodedWindGrid, trailTargetSize } from './wind-gl';

afterEach(() => { vi.unstubAllGlobals(); });

const decode = (byte: number) => byte / 255 * 200 - 100;

function paint(size: number, cells: ReadonlyArray<readonly [number, number, number, number]>): Uint8Array {
  const data = new Uint8Array(size * size * 4), view = new DataView(data.buffer);
  for (const [x, y, u, v] of cells) {
    const offset = (y * size + x) * 4;
    view.setUint8(offset, encodeWindByte(u));
    view.setUint8(offset + 1, encodeWindByte(v));
    view.setUint8(offset + 3, 255);
  }
  return data;
}

const uv = (texel: number, size: number) => (texel + 0.5) / size;

it('keeps a no-lift hole from decoding as a large opposite wind', () => {
  const size = 2, data = paint(size, [[0, 0, 10, -4]]);
  const encoded = encodeWindByte(10);
  const poisoned = (0.75 * (encoded / 255) + 0.25 * 0) * 200 - 100;
  expect(poisoned).toBeLessThan(-10);
  const beside = sampleEncodedWindGrid(data, uv(0.25, size), uv(0, size), size);
  expect(beside?.u).toBeCloseTo(decode(encoded), 5);
  expect(beside?.v).toBeCloseTo(decode(encodeWindByte(-4)), 5);
  const center = sampleEncodedWindGrid(data, uv(0, size), uv(0, size), size);
  expect(center?.u).toBeCloseTo(decode(encoded), 5);
  const edge = sampleEncodedWindGrid(data, 0, uv(0, size), size);
  expect(edge?.u).toBeCloseTo(decode(encoded), 5);
});

it('interpolates two valid wind texels and rejects an empty neighborhood', () => {
  const size = 2, data = paint(size, [[0, 0, 10, 0], [1, 0, 30, 0]]);
  const blended = sampleEncodedWindGrid(data, uv(0.25, size), uv(0, size), size);
  const expected = 0.75 * decode(encodeWindByte(10)) + 0.25 * decode(encodeWindByte(30));
  expect(blended?.u).toBeCloseTo(expected, 5);
  expect(blended?.v).toBeCloseTo(decode(encodeWindByte(0)), 5);
  expect(sampleEncodedWindGrid(new Uint8Array(size * size * 4), uv(0, size), uv(0, size), size)).toBeNull();
});

it('uses the one reconstructed field during a frame blend', () => {
  const from = { u: 10, v: 0 }, to = { u: 2, v: 6 };
  expect(mixWindVectors(from, to, 0.25)).toEqual({ u: 8, v: 1.5 });
  expect(mixWindVectors(from, to, 1)).toEqual(to);
  expect(mixWindVectors(from, null, 0.25)).toEqual(from);
  expect(mixWindVectors(from, null, 1)).toBeNull();
  expect(mixWindVectors(null, to, 0.25)).toEqual(to);
  expect(mixWindVectors(null, null, 1)).toBeNull();
});

it('samples wind texels with floor and rejects zero alpha before decoding', () => {
  const alpha = WIND_PARTICLE_UPDATE.indexOf('s.a>0.5'), scale = WIND_PARTICLE_UPDATE.indexOf('*200.0');
  expect(alpha).toBeGreaterThan(-1);
  expect(scale).toBeGreaterThan(alpha);
  expect(WIND_PARTICLE_UPDATE).toContain('texelFetch');
  expect(WIND_PARTICLE_UPDATE).toContain('floor');
  expect(WIND_PARTICLE_UPDATE).toContain('uv*float(128)-0.5');
  expect(WIND_PARTICLE_UPDATE).toContain('ivec2(127)');
  expect(WIND_PARTICLE_UPDATE).toContain('u_mix>=1.0?b.xy');
  expect(WIND_PARTICLE_UPDATE).toContain('mix(a.xy,b.xy,u_mix)');
  expect(WIND_PARTICLE_UPDATE).toContain('vb?b.xy:a.xy');
  expect(WIND_PARTICLE_UPDATE).not.toMatch(/texture\(u_[ab]/);
});

it('keeps each trail target at the drawing-buffer size inside the canvas reserve', () => {
  expect(trailTargetSize(3456, 2234)).toEqual({ width: 3456, height: 2234 });
  expect(trailTargetSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  const full = trailTargetSize(4096, 4096);
  expect(full).toEqual({ width: 4096, height: 4096 });
  expect(full.width * full.height * 2).toBe(WIND_CANVAS_BYTES);
  expect(trailTargetSize(8000, 1000)).toEqual({ width: 4096, height: 512 });
  expect(trailTargetSize(0, -5)).toEqual({ width: 1, height: 1 });
});

it('reserves GL targets before allocation, degrades and recovers, and releases without GC', async () => {
  const budget = createPreparationBudget(128 * 1024 * 1024);
  const other = budget.reserve('other', 127 * 1024 * 1024)!;
  const enums = new globalThis.Map<string, number>();
  let maxReserved = 0, clearCount = 0, failedResizeCall = 0;
  const gl = new Proxy({} as WebGL2RenderingContext, {
    get(_target, property) {
      const key = String(property);
      if (/^[A-Z0-9_]+$/.test(key)) {
        if (!enums.has(key)) enums.set(key, enums.size + 1);
        return enums.get(key);
      }
      if (key === 'getParameter') return (value: number) => {
        if (value === gl.MAX_TEXTURE_SIZE) return 4096;
        if (value === gl.COLOR_CLEAR_VALUE) return [0, 0, 0, 0];
        if (value === gl.COLOR_WRITEMASK) return [true, true, true, true];
        return null;
      };
      if (key === 'getExtension' || key.startsWith('create')) return () => ({});
      if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
      if (key === 'checkFramebufferStatus') return () => gl.FRAMEBUFFER_COMPLETE;
      if (key === 'isEnabled') return () => false;
      if (key === 'clear') return () => { clearCount++; };
      if (key === 'texImage2D') return () => {
        const reserved = budget.snapshot()['wind-display-gl'] ?? 0;
        expect(reserved).toBeGreaterThan(0);
        maxReserved = Math.max(maxReserved, reserved);
        if (failedResizeCall && ++failedResizeCall === 3) throw new Error('texture allocation failed');
      };
      return () => {};
    }
  });
  let layer: { id: string; onAdd(map: unknown, context: WebGL2RenderingContext): void; onRemove(): void } | null = null;
  const map = {
    addLayer(value: typeof layer) { layer = value; layer!.onAdd(map, gl); },
    getLayer: () => layer,
    removeLayer() { layer?.onRemove(); layer = null; },
    getStyle: () => ({ layers: [{ id: 'av-wind-particles' }] }),
    moveLayer: () => {}, on: () => {}, off: () => {}, once: () => {}, isStyleLoaded: () => true,
    getCanvas: () => ({ width: 2048, height: 2048, clientWidth: 1024, clientHeight: 1024 }),
    triggerRepaint: () => {}
  };
  vi.stubGlobal('window', { devicePixelRatio: 2 });
  const renderer = attachWindGl(map as unknown as Map, () => {}, budget)!;
  expect(renderer.limited).toBe(true);
  expect(budget.snapshot()['wind-display-gl']).toBe(renderer.bytes);
  const reduced = renderer.bytes;
  renderer.setMotion(true, true); renderer.reset();
  expect(clearCount).toBe(2);
  other.release();
  await Promise.resolve();
  expect(renderer.limited).toBe(false);
  expect(renderer.bytes).toBeGreaterThan(reduced);
  expect(maxReserved).toBeGreaterThan(renderer.bytes);
  expect(budget.used).toBe(renderer.bytes);
  const full = renderer.bytes;
  expect(renderer.relievePressure()).toBe(true);
  expect(renderer.bytes).toBeLessThan(full);
  const numeric = budget.reserve('wind-numeric', 1024)!;
  await Promise.resolve();
  expect(renderer.bytes).toBeLessThan(full);
  numeric.release();
  await Promise.resolve();
  expect(renderer.bytes).toBe(full);
  failedResizeCall = 1;
  expect(() => renderer.relievePressure()).toThrow('texture allocation failed');
  expect(budget.used).toBe(renderer.bytes);
  expect(renderer.bytes).toBeGreaterThan(full);
  renderer.destroy();
  expect(budget.used).toBe(0);
  expect(renderer.bytes).toBe(0);
});


it('translates a dateline prepared interval into the displayed world copy', () => {
  const bounds = [179.85, 0, 180.15, 1] as const;
  for (const center of [179.97, -179.97, 180, -180]) {
    const shift = preparedWorldShift(bounds, center);
    const middle = (bounds[0] + bounds[2]) / 2 + shift;
    expect(Math.abs(middle - center)).toBeLessThanOrEqual(180);
    expect(bounds[2] + shift - (bounds[0] + shift)).toBeCloseTo(0.3, 8);
  }
  expect(preparedWorldShift(bounds, -179.97)).toBe(-360);
  expect(preparedWorldShift(bounds, 179.97)).toBe(0);
});
