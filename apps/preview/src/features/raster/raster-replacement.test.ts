import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { RasterOverlay, type OverlayState } from './raster-overlay';

vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn(), removeProtocol: vi.fn() }));
class Bitmap {
  readonly width = 256;
  readonly height = 256;
  readonly close = vi.fn();
}
class Canvas {
  readonly context = { clearRect: vi.fn(), drawImage: vi.fn() };
  constructor(public width: number, public height: number) {}
  getContext() { return this.context; }
  transferToImageBitmap() { return new Bitmap(); }
}
const ARMENIA = { west: 44.27798057856188, east: 44.72201942143812, south: 40.104612670852696, north: 40.29538732914732 };
const WIDE = { west: -80, east: 80, south: -50, north: 50 };

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-30T00:00:00Z'));
  vi.stubGlobal('OffscreenCanvas', Canvas);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80), {
    headers: { 'content-type': 'image/webp', 'content-length': '12' }
  })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  const handlers = new globalThis.Map<string, Set<(event: never) => void>>();
  const sources = new globalThis.Map<string, unknown>(), opacity = new globalThis.Map<string, number>(), loaded = new Set<string>();
  const states: OverlayState[] = [];
  let moving = false, zoom = 4, bounds = WIDE;
  const map = {
    on: (name: string, listener: (event: never) => void) => { const set = handlers.get(name) ?? new Set(); set.add(listener); handlers.set(name, set); },
    off: (name: string, listener: (event: never) => void) => handlers.get(name)?.delete(listener),
    addSource: (id: string, source: unknown) => sources.set(id, { ...(source as object), updateImage: vi.fn(), setCoordinates: vi.fn() }), getSource: (id: string) => sources.get(id), removeSource: (id: string) => sources.delete(id),
    addLayer: (layer: { id: string; paint: Record<string, number> }) => opacity.set(layer.id, layer.paint['raster-opacity']),
    getLayer: (id: string) => opacity.has(id), removeLayer: (id: string) => opacity.delete(id),
    setPaintProperty: (id: string, _property: string, value: number) => opacity.set(id, value),
    isSourceLoaded: (id: string) => loaded.has(id), isMoving: () => moving, getZoom: () => zoom,
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }), getCenter: () => ({ lng: 0, lat: 0 }),
    coveringTiles: (options?: { minzoom?: number; maxzoom?: number }) => [{ canonical: { z: Math.max(options?.minzoom ?? 0, Math.min(options?.maxzoom ?? 22, Math.round(zoom))) } }],
    getBounds: () => ({ getWest: () => bounds.west, getEast: () => bounds.east, getSouth: () => bounds.south, getNorth: () => bounds.north })
  };
  const overlay = new RasterOverlay(map as unknown as Map, 'https://api.test', 0.7, state => states.push(state));
  const emit = (name: string, event: object = {}) => {
    if (name === 'movestart') moving = true;
    if (name === 'moveend') moving = false;
    for (const handler of handlers.get(name) ?? []) handler(event as never);
  };
  return { overlay, states, emit, setZoom: (value: number) => { zoom = value; }, setBounds: (value: typeof bounds) => { bounds = value; }, markLoaded: (id: string) => loaded.add(id) };
}

async function settle(view: ReturnType<typeof fixture>, rounds = 200) {
  for (let i = 0; i < rounds; i++) { await vi.advanceTimersByTimeAsync(5); view.emit('idle'); view.emit('render'); }
}

it('keeps the replacement frame axis alive through render and idle while decode is pending', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => new Bitmap()));
  const view = fixture(), build = fixtureBuild(), frame = build.manifest.frames[0]!.id;
  try {
    view.overlay.select(build, 'usable-lift-agl', frame);
    await settle(view);
    expect(view.states.at(-1)).toMatchObject({ quality: 'overview', overviewTotal: 8 });

    const pending: ((bitmap: Bitmap) => void)[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise<Bitmap>(resolve => { pending.push(resolve); })));
    view.setBounds(ARMENIA); view.setZoom(10);
    view.overlay.select(build, 'usable-lift-agl', frame);
    await settle(view, 20);
    expect(view.states.at(-1)).toMatchObject({ overviewTotal: 8, overviewReady: 0 });
    for (let round = 0; round < 40 && (view.states.at(-1)?.overviewReady ?? 0) < 8; round++) {
      for (const resolve of pending.splice(0)) resolve(new Bitmap());
      await settle(view, 10);
    }
    expect(view.states.at(-1)).toMatchObject({ overviewTotal: 8, overviewReady: 8 });
  } finally { view.overlay.destroy(); }
});
