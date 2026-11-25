import { expect, it } from 'vitest';
import type { Map } from 'maplibre-gl';
import { contains, previewCrop, viewBounds } from './overview-geometry';

const mapWith = (west: number, south: number, east: number, north: number) => ({
  getBounds: () => ({ getWest: () => west, getSouth: () => south, getEast: () => east, getNorth: () => north })
}) as unknown as Map;

it('unwraps dateline views and caps them at one world', () => {
  expect(viewBounds(mapWith(170, -10, -170, 10))).toEqual([170, -10, 190, 10]);
  expect(viewBounds(mapWith(-300, -10, 300, 10))).toEqual([-180, -10, 180, 10]);
});

it('picks a coarser crop of at most four tiles that keeps covering its view', () => {
  const view: [number, number, number, number] = [-118, 32, -116, 34];
  const crop = previewCrop(view, 9)!;
  expect(crop.zoom).toBeLessThan(9);
  expect(crop.tiles.length).toBeLessThanOrEqual(4);
  expect(contains(crop, view)).toBe(true);
  expect(contains(crop, [-118 + 360, 32, -116 + 360, 34])).toBe(true);
  expect(contains(crop, [10, 32, 12, 34])).toBe(false);
});
