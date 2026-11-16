import { expect, it } from 'vitest';
import { fixtureBuild } from '../../../tests/forecast-fixture.js';
import { syncPluginSeam, watchPluginSeam } from './coverage-seam.js';

it('draws the line on a map that can add a source and ignores a map that cannot', () => {
  const build = fixtureBuild({ model: 'icon-eu' });
  const bare = { on: () => { throw new Error('listener'); } };
  expect(() => syncPluginSeam(bare, build, 'usable-lift-msl')).not.toThrow();
  expect(() => watchPluginSeam(bare, () => undefined)).not.toThrow();

  const sources = new Map<string, unknown>();
  const events = new Map<string, () => void>();
  const map = {
    bounds: { west: 60, south: 28, east: 64, north: 32 },
    on(event: string, listener: () => void) { events.set(event, listener); },
    addSource(id: string, source: unknown) { sources.set(id, source); },
    getSource(id: string) { return sources.get(id); },
    removeSource(id: string) { sources.delete(id); },
    addLayer(_layer?: { id: string }) {},
    getLayer() { return undefined; },
    removeLayer() {},
    getBounds() { return { getWest: () => map.bounds.west, getSouth: () => map.bounds.south, getEast: () => map.bounds.east, getNorth: () => map.bounds.north }; }
  };
  const cold = { ...map, isStyleLoaded: () => false };
  syncPluginSeam(cold, build, 'usable-lift-msl');
  expect(sources.has('av-seam')).toBe(false);
  watchPluginSeam(map, () => syncPluginSeam(map, build, 'usable-lift-msl'));
  events.get('moveend')!();
  expect(sources.has('av-seam')).toBe(true);
  const layers = new Map<string, { id: string }>();
  map.addLayer = layer => { if (layer) layers.set(layer.id, layer); };
  sources.clear();
  events.get('style.load')!();
  expect(layers.has('av-seam-line')).toBe(true);
  expect(layers.has('av-seam-label')).toBe(false);
});
