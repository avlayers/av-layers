import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { PinnedBuild } from '@av/client';
import type { RasterCrop } from '../raster/raster-crop';

const tiles = new Map<string, { resolve: (data: ArrayBuffer) => void; reject: (error: Error) => void }>();
const released: string[] = [];

vi.mock('@av/client', async importActual => ({
  ...await importActual<typeof import('@av/client')>(),
  createSourceRasterTileProtocol: () => ({
    setBuildExpiry() {},
    dispose() {},
    requestTile(url: string) {
      return {
        cancel() {},
        response: new Promise((resolve, reject) => {
          tiles.set(url, { resolve: data => resolve({ data, release: () => released.push(url) }), reject });
        })
      };
    }
  })
}));

const { RainFieldSource } = await import('./rain-field-source');

const bitmaps: { closed: number }[] = [];
let drawError: Error | null = null;

function stubCanvas(): void {
  vi.stubGlobal('createImageBitmap', async () => {
    const bmp = { closed: 0, close() { this.closed++; } };
    bitmaps.push(bmp);
    return bmp;
  });
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() {
      return {
        clearRect() {},
        drawImage() { if (drawError) throw drawError; },
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
      };
    }
  });
}

const build = {
  manifest: { buildId: 'b1' },
  expiresAtMs: Date.now() + 3_600_000,
  templates: { 'precip-rate': 'https://api.test/tiles/{frame}/{z}/{x}/{y}.webp' }
} as unknown as PinnedBuild;

const crop = {
  zoom: 2, left: 0, top: 0, right: 768, bottom: 256, width: 768, height: 256,
  tiles: [0, 1, 2].map(x => ({ z: 2, canonicalX: x, y: 1, drawX: x * 256, drawY: 0 })),
  coordinates: [[-180, 60], [-45, 60], [-45, 0], [-180, 0]]
} as unknown as RasterCrop;

const tileUrl = (x: number) => `https://api.test/tiles/f001/2/${x}/1.webp`;
const body = () => new ArrayBuffer(64);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function start(isCurrent: () => boolean = () => true) {
  stubCanvas();
  const source = new RainFieldSource({ getZoom: () => 2 } as unknown as MapLibreMap, 'https://api.test', {});
  return source.decode(build, 'f001', crop, 'foreground', [], isCurrent);
}

afterEach(() => {
  tiles.clear(); released.length = 0; bitmaps.length = 0; drawError = null;
  vi.unstubAllGlobals();
});

describe('RainFieldSource.decode', () => {
  it('closes every bitmap exactly once when one tile fails between a fast and a late sibling', async () => {
    const result = start();
    tiles.get(tileUrl(0))!.resolve(body());
    await flush();
    tiles.get(tileUrl(1))!.reject(new Error('503'));
    await flush();
    tiles.get(tileUrl(2))!.resolve(body());
    expect(await result).toBeNull();
    expect(bitmaps).toHaveLength(2);
    expect(bitmaps.map(b => b.closed)).toEqual([1, 1]);
    expect(released.sort()).toEqual([tileUrl(0), tileUrl(2)]);
  });

  it('closes bitmaps when the decode is superseded during bitmap creation', async () => {
    let current = true;
    const result = start(() => current);
    tiles.get(tileUrl(0))!.resolve(body());
    tiles.get(tileUrl(1))!.resolve(body());
    await flush();
    current = false;
    tiles.get(tileUrl(2))!.resolve(body());
    expect(await result).toBeNull();
    expect(bitmaps.every(b => b.closed === 1)).toBe(true);
    expect(released).toHaveLength(3);
  });

  it('closes bitmaps when drawing throws', async () => {
    const result = start();
    drawError = new Error('context lost');
    for (const x of [0, 1, 2]) tiles.get(tileUrl(x))!.resolve(body());
    expect(await result).toBeNull();
    expect(bitmaps).toHaveLength(3);
    expect(bitmaps.every(b => b.closed === 1)).toBe(true);
  });

  it('builds a field and closes its bitmaps on success', async () => {
    const result = start();
    for (const x of [0, 1, 2]) tiles.get(tileUrl(x))!.resolve(body());
    const field = await result;
    expect(field?.key).toBe('b1:f001:2:0:0:768:256');
    expect(bitmaps.every(b => b.closed === 1)).toBe(true);
    expect(released).toHaveLength(3);
  });
});
