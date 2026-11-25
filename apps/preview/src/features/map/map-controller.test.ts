import { describe, expect, it, vi } from 'vitest';
import { resolveCivilTimeZone } from '@av/client/timezone';
import { createMap, createMapCamera, maplibregl } from './map-controller';

vi.mock('maplibre-gl', () => ({ setWorkerUrl: vi.fn(), Map: vi.fn(function () { return {}; }) }));

it('uses the bounded per-source tile cache on every memory class', () => {
  createMap({ container: {} as HTMLElement, offlineFixture: true, camera: null });
  expect(maplibregl.Map).toHaveBeenCalledWith(expect.objectContaining({ maxTileCacheSize: 24, maxTileCacheZoomLevels: 2 }));
});

function camera(lng: number) {
  const map = {
    getCenter: () => ({ lat: 40, lng }), getZoom: () => 5, fitBounds: vi.fn()
  };
  return { map, camera: createMapCamera(map as never, { home: { lat: 40, lng: 0 }, followsPlace: false, browserTimeZone: 'America/Denver', loadZoneLookup: async () => (lat, lon) => resolveCivilTimeZone(lat, lon) }) };
}

describe('map camera', () => {
  it('keeps the browser zone until the map leaves home', async () => {
    const test = camera(0);
    await test.camera.zoneReady;
    expect(test.camera.sync().changed).toBe(false);
    expect(test.camera.timeZone()).toBe('America/Denver');
    expect(test.camera.followsPlace()).toBe(false);
  });

  it('switches to the civil zone of the map centre after meaningful movement', async () => {
    const test = camera(44.5);
    await test.camera.zoneReady;
    expect(test.camera.sync().changed).toBe(true);
    expect(test.camera.followsPlace()).toBe(true);
    expect(test.camera.timeZone()).toBe('Asia/Yerevan');
  });

  it('computes a metric or imperial scale', () => {
    const test = camera(0);
    expect(test.camera.scale('metric').text).toMatch(/km$/);
    expect(test.camera.scale('imperial').text).toMatch(/mi$/);
  });
});
