import { expect, it } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { outlineMeetsView } from './client-view.js';
import { coverageParallels, seamLabel, seamLines, syncCoverageSeam, SEAM_HALO_ID, SEAM_LABEL_ID, SEAM_LINE_ID, SEAM_SOURCE_ID, type SeamMap } from './client-seam.js';
import { fixtureBuild } from '../../../tests/forecast-fixture.js';

it('draws coverage parallels off exact ±180 and leaves a wrapped grid without a ring', () => {
  const gfs = getProduct('gfs')!.grid;
  const lines = seamLines(gfs, [-180, -55, 180, 65]);
  expect(lines).toEqual(coverageParallels([-180, -55, 180, 65]));
  expect(lines.map(line => line.map(point => point.lon).at(0))).toEqual([-179.9, -179.9]);
  expect(lines.map(line => line.at(-1)!.lon)).toEqual([179.9, 179.9]);
  expect(lines.map(line => line[0]!.lat)).toEqual([65, -55]);
});

it('counts an endpoint and a dateline-shifted segment, and ignores a ring that only contains the view', () => {
  const edge = [[{ lat: 10, lon: 0 }, { lat: 10, lon: 5 }]];
  expect(outlineMeetsView(edge, { west: 4, south: 9, east: 6, north: 11 })).toBe(true);
  expect(outlineMeetsView(edge, { west: 1, south: 1, east: 2, north: 2 })).toBe(false);
  expect(outlineMeetsView([[{ lat: 0, lon: -179 }, { lat: 0, lon: -175 }]], { west: 170, south: -1, east: -170, north: 1 })).toBe(true);
  expect(outlineMeetsView(coverageParallels([-180, -55, 180, 65]), { west: -250, south: 60, east: -220, north: 70 })).toBe(true);
  const icon = seamLines(getProduct('icon-eu')!.grid, [-23.5, 29.5, 62.5, 70.5]);
  expect(outlineMeetsView(icon, { west: 0, south: 40, east: 10, north: 50 })).toBe(false);
  expect(outlineMeetsView(icon, { west: 60, south: 28, east: 64, north: 32 })).toBe(true);
});

it('installs the dashed seam with a glyph label and removes the source when the view leaves the edge', () => {
  const build = fixtureBuild({ model: 'icon-eu' });
  const map = fakeMap({ west: 60, south: 28, east: 64, north: 32 });
  syncCoverageSeam(map, build, 'usable-lift-msl', true);
  expect(map.sources.has(SEAM_SOURCE_ID)).toBe(true);
  expect(map.layers.has(SEAM_HALO_ID)).toBe(true);
  expect((map.layers.get(SEAM_LINE_ID)!.paint as { 'line-dasharray': number[] })['line-dasharray']).toEqual([2, 2]);
  expect(haloHasDash(map)).toBe(false);
  const data = map.sources.get(SEAM_SOURCE_ID)!.data as { features: { properties: { label: string } }[] };
  expect(data.features[0]!.properties.label).toBe(seamLabel('icon-eu'));
  expect(map.layers.has(SEAM_LABEL_ID)).toBe(true);
  map.bounds = { west: 0, south: 40, east: 10, north: 50 };
  syncCoverageSeam(map, build, 'usable-lift-msl', true);
  expect(map.sources.has(SEAM_SOURCE_ID)).toBe(false);
  expect(map.layers.size).toBe(0);
});

function haloHasDash(map: ReturnType<typeof fakeMap>): boolean {
  return 'line-dasharray' in (map.layers.get(SEAM_HALO_ID)!.paint as object);
}

function fakeMap(bounds: { west: number; south: number; east: number; north: number }): SeamMap & {
  bounds: typeof bounds; sources: Map<string, { data?: unknown; setData?: (value: unknown) => void }>; layers: Map<string, { id: string; paint?: object }>;
} {
  const sources = new Map<string, { data?: unknown; setData?: (value: unknown) => void }>();
  const layers = new Map<string, { id: string; paint?: object }>();
  const map = {
    bounds, sources, layers,
    addSource(id: string, source: object) { sources.set(id, source as { data?: unknown }); },
    getSource(id: string) { return sources.get(id); },
    removeSource(id: string) { sources.delete(id); },
    addLayer(layer: object) { const spec = layer as { id: string; paint?: object }; layers.set(spec.id, spec); },
    getLayer(id: string) { return layers.get(id); },
    removeLayer(id: string) { layers.delete(id); },
    getBounds() { return { getWest: () => map.bounds.west, getSouth: () => map.bounds.south, getEast: () => map.bounds.east, getNorth: () => map.bounds.north }; }
  };
  return map;
}
