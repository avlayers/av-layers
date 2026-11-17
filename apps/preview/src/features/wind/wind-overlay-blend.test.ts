import { afterEach, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { createPreparationBudget } from '@av/client';
import { WindDataCache, WindDataSource } from '@av/client/wind';
import { WIND_FINE_CELL_BYTES } from '@av/contracts/wind-data';
import { encodeWindColumns } from '@av/forecast/wind';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { PLAYBACK_STEP_MS } from '../timeline/timeline-model';
import { WindOverlay } from './wind-overlay';

const gl = vi.hoisted(() => ({ setFields: vi.fn(), setPrepared: vi.fn(), setMotion: vi.fn(), reset: vi.fn(), destroy: vi.fn() }));
vi.mock('./wind-gl', () => ({ attachWindGl: () => gl }));

class Canvas extends EventTarget {
  style: Record<string, string> = {};
  width = 0;
  height = 0;
  getContext(): object {
    return { setTransform: () => {}, clearRect: () => {}, fillRect: () => {}, beginPath: () => {}, stroke: () => {} };
  }
  setAttribute(): void {}
  remove(): void {}
}

function overlay(): WindOverlay {
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => new Canvas() });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const map = {
    getCanvasContainer: () => ({ appendChild: () => {} }),
    getCanvas: () => ({ clientWidth: 64, clientHeight: 64 }),
    on: () => {},
    off: () => {},
    getBounds: () => ({ getWest: () => -1, getEast: () => 1, getNorth: () => 1, getSouth: () => -1 }),
    getZoom: () => 0,
    getBearing: () => 0,
    getPitch: () => 0,
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lng: 0, lat: 0 })
  };
  return new WindOverlay(map as unknown as Map);
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); gl.setFields.mockReset(); gl.setPrepared.mockReset(); gl.destroy.mockReset(); gl.reset.mockReset(); });

it('replaces the GPU field without a playback blend', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
  const view = overlay();
  const previous = { sample: () => ({ status: 0, u: 10, v: 0 }) };
  const next = { sample: () => ({ status: 2, u: null, v: null }) };
  view.setField(previous);
  view.setField(next, 'swap');
  view.setOptions({ paused: true });
  expect(gl.setFields).toHaveBeenLastCalledWith(null, next);
  now.mockReturnValue(1_000 + PLAYBACK_STEP_MS);
  view.setOptions({ paused: false });
  expect(gl.setFields).toHaveBeenLastCalledWith(null, next);
  view.destroy();
});


it('uploads a prepared lattice instead of reconstructing it from a field', () => {
  const view = overlay();
  const prepared = { bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(16), size: 2, height: 'surface' as const, key: 'prepared:surface' };
  view.setPrepared(prepared);
  expect(gl.setPrepared).toHaveBeenLastCalledWith(prepared);
  expect(gl.setFields).not.toHaveBeenCalled();
  view.setField({ sample: () => ({ status: 0, u: 1, v: 1 }) });
  expect(gl.setFields).toHaveBeenCalled();
});

it('installs field and prepared data before renderer synchronization', () => {
  const view = overlay();
  const prepared = { bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(16), size: 2, height: 'surface' as const, key: 'prepared:install' };
  view.install({ sample: () => ({ status: 0, u: 1, v: 1 }) }, prepared);
  expect(gl.setPrepared).toHaveBeenLastCalledWith(prepared);
  expect(gl.setFields).not.toHaveBeenCalled();
});

it('clears GPU trails before installing another time', () => {
  const view = overlay();
  const first = { sample: () => ({ status: 0, u: 1, v: 0 }) };
  const second = { sample: () => ({ status: 0, u: 2, v: 0 }) };
  const third = { sample: () => ({ status: 0, u: 3, v: 0 }) };
  view.setField(first);
  view.setField(second, 'swap');
  expect(gl.setFields).toHaveBeenLastCalledWith(null, second);
  view.clear();
  expect(gl.setFields).toHaveBeenLastCalledWith(null, null);
  view.setField(third, 'swap');
  expect(gl.setFields).toHaveBeenLastCalledWith(null, third);
  view.destroy();
});

it('retains prepared grids until the renderer detaches them without GC', () => {
  const budget = createPreparationBudget(1024), view = overlay();
  let attached: object | null = null;
  gl.setPrepared.mockImplementation(value => { attached = value; });
  gl.setFields.mockImplementation(() => { attached = null; });
  gl.destroy.mockImplementation(() => { attached = null; });
  const makeGrid = (height: 'surface' | number) => {
    const lease = budget.reserve('wind-prepared', 16)!;
    let owners = 1;
    const drop = () => { if (--owners === 0) lease.release(); };
    const grid = {
      bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(16), size: 2, height, key: `p:${height}`,
      retain: vi.fn(() => { owners++; return () => { expect(attached).not.toBe(grid); drop(); }; })
    };
    return { grid, releaseOwner: drop };
  };
  const field = { sample: () => ({ status: 0, u: 1, v: 1 }) };
  const first = makeGrid('surface');
  view.setOptions({ visible: false, paused: true });
  view.install(field, first.grid);
  view.install(field, first.grid);
  view.setPrepared(first.grid);
  expect(first.grid.retain).toHaveBeenCalledTimes(1);
  first.releaseOwner();
  expect(budget.used).toBe(16);
  const second = makeGrid(500);
  view.install(field, second.grid);
  expect(budget.used).toBe(16);
  second.releaseOwner();
  const borrowed = second.grid.data;
  view.clear();
  expect(budget.used).toBe(0);
  expect(borrowed.byteLength).toBe(16);
  const third = makeGrid(1000);
  view.setPrepared(third.grid);
  third.releaseOwner();
  expect(budget.used).toBe(16);
  view.destroy();
  expect(budget.used).toBe(0);
  expect(gl.reset).toHaveBeenCalled();
});

it('returns the real source and renderer budget to baseline on replacement and disposal', async () => {
  const budget = createPreparationBudget(1024 * 1024), cache = new WindDataCache(undefined, undefined, budget), view = overlay();
  const pinned = fixtureBuild();
  pinned.expiresAtMs = Date.now() + 60_000;
  pinned.manifest.expiresAt = new Date(pinned.expiresAtMs).toISOString();
  pinned.manifest.recipe.id = 'gfs';
  pinned.manifest.descriptors.bounds = [-1, -1, 2, 2];
  const grid = { kind: 'regular-latlon' as const, width: 2, height: 2, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
  for (const surface of pinned.manifest.surfaces) surface.grid = grid;
  const frame = pinned.manifest.frames[0]!.id;
  const column = { surface: { u: 1, v: 2 }, levels: [{ height: 100, wind: { u: 2, v: 4 } }, { height: 1000, wind: { u: 4, v: 8 } }] };
  const wind = encodeWindColumns(Array.from({ length: 256 }, (_, index) => index % 16 < 2 && Math.floor(index / 16) < 2 ? column : null));
  const fine = new Uint8Array(64 * 64 * WIND_FINE_CELL_BYTES), fineView = new DataView(fine.buffer);
  for (let i = 0; i < 64 * 64; i++) {
    fineView.setFloat32(i * WIND_FINE_CELL_BYTES, 100, true);
    fineView.setFloat32(i * WIND_FINE_CELL_BYTES + 4, 550, true);
    fineView.setUint8(i * WIND_FINE_CELL_BYTES + 8, 16);
  }
  const descriptor = JSON.stringify({ version: 3, frame, levels: 2, tileSize: 16, fineTileSize: 64,
    wind: [{ sha256: 'a'.repeat(64), bytes: wind.length, indexSha256: 'b'.repeat(64), count: 1 }],
    fine: [{ sha256: 'c'.repeat(64), bytes: fine.length, indexSha256: 'd'.repeat(64), count: 1 }] });
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor, { headers: { 'content-type': 'application/json' } })
    : new Response(Uint8Array.from(String(url).includes('/wind/') ? wind : fine), { headers: { 'content-type': 'application/octet-stream' } }));
  const source = new WindDataSource('https://api.test', { cache, budget, fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [-1, -1, 2, 2] })).toBe('ready');
  const surface = source.prepare('surface')!, elevated = source.prepare(500)!;
  view.install(source.field('surface'), surface);
  view.install(source.field(500), elevated);
  source.dispose(); cache.clear();
  expect(budget.used).toBe(elevated.data.byteLength);
  const borrowed = elevated.data;
  view.clear();
  expect(budget.used).toBe(0);
  expect(borrowed.byteLength).toBe(elevated.data.byteLength);
  view.destroy();
  expect(budget.used).toBe(0);
});
