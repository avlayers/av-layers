import { describe, expect, it, vi } from 'vitest';
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
  return { map, camera: createMapCamera(map as never, { home: { lat: 40, lng: 0 }, followsPlace: false, initialOffset: 0, browserOffset: 0 }) };
}

describe('map camera', () => {
  it('keeps the browser offset until the map leaves home', () => {
    const test = camera(0);
    expect(test.camera.sync().changed).toBe(false);
    expect(test.camera.offsetMinutes()).toBe(0);
    expect(test.camera.followsPlace()).toBe(false);
  });

  it('switches to the place clock after meaningful movement', () => {
    const test = camera(30);
    expect(test.camera.sync().changed).toBe(true);
    expect(test.camera.followsPlace()).toBe(true);
    expect(test.camera.offsetMinutes()).toBe(120);
  });

  it('computes a metric or imperial scale', () => {
    const test = camera(0);
    expect(test.camera.scale('metric').text).toMatch(/km$/);
    expect(test.camera.scale('imperial').text).toMatch(/mi$/);
  });
});
