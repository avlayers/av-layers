import { expect, it, vi } from 'vitest';
import { WEATHER_CEILING_ID } from '@av/client';
import { applyBasemapTheme, compositeBasemapStyle } from './basemap';
import { MAP_THEMES } from '../../themes/registry';

it('builds OpenFreeMap vector overlays and DEM terrain relief across all 8 soaring themes', () => {
  for (const theme of MAP_THEMES) {
    const style = compositeBasemapStyle(theme);
    expect(style.version).toBe(8);
    expect(style.glyphs).toBe('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
    expect(style.sprite).toBe('https://tiles.openfreemap.org/sprites/ofm_f384/ofm');
    expect(style.sources['terrain-dem']).toMatchObject({ type: 'raster-dem', encoding: 'terrarium' });
    expect(style.sources.openmaptiles).toEqual({
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet'
    });
    expect(JSON.stringify(style)).not.toMatch(/xcskies/i);
  }

  const stone = compositeBasemapStyle('stone');
  const bgIndex = stone.layers.findIndex(layer => layer.id === 'terrain-background');
  const reliefIndex = stone.layers.findIndex(layer => layer.id === 'terrain-relief');
  const baseHillshadeIndex = stone.layers.findIndex(layer => layer.id === 'terrain-hillshade-base');
  const waterFillIndex = stone.layers.findIndex(layer => layer.id === 'water');
  const topHillshadeIndex = stone.layers.findIndex(layer => layer.id === WEATHER_CEILING_ID);
  const firstSymbolIndex = stone.layers.findIndex(layer => layer.type === 'symbol');

  expect(bgIndex).toBe(0);
  expect(reliefIndex).toBeGreaterThan(bgIndex);
  expect(baseHillshadeIndex).toBeGreaterThan(reliefIndex);
  expect(waterFillIndex).toBeGreaterThan(baseHillshadeIndex);
  expect(topHillshadeIndex).toBeGreaterThan(waterFillIndex);
  expect(topHillshadeIndex).toBeLessThan(firstSymbolIndex);
  expect(stone.layers.some(layer => layer.id === 'waterway' && layer.type === 'line')).toBe(true);
  expect(stone.layers.some(layer => layer.id === 'road_major_motorway' && layer.type === 'line')).toBe(true);
  expect(stone.layers.some(layer => layer.id === 'aero-strip' && layer.type === 'symbol')).toBe(true);
  expect(stone.layers.some(layer => layer.id === 'place-city' && layer.type === 'symbol')).toBe(true);

  const classic = compositeBasemapStyle('classic');
  const classicBg = classic.layers.find(layer => layer.id === 'terrain-background') as { paint?: Record<string, unknown> };
  expect(classicBg.paint?.['background-color']).toBe('#a8c8df');
});

it('updates terrain, water, road, border, and label paint properties in place when switching themes', () => {
  const style = compositeBasemapStyle('stone');
  const layerIds = new Set(style.layers.map(layer => layer.id));
  const setPaintProperty = vi.fn();
  const map = {
    getLayer: (id: string) => (layerIds.has(id) ? { id } : undefined),
    setPaintProperty
  };

  applyBasemapTheme(map, 'classic');
  expect(setPaintProperty).toHaveBeenCalledWith('terrain-background', 'background-color', '#a8c8df');
  expect(setPaintProperty).toHaveBeenCalledWith('water', 'fill-color', '#a8c8df');
  expect(setPaintProperty).toHaveBeenCalledWith('waterway', 'line-color', 'hsl(205, 56%, 73%)');
  expect(setPaintProperty).toHaveBeenCalledWith('aero-strip', 'text-color', 'hsl(209, 100%, 36%)');
  expect(setPaintProperty).toHaveBeenCalledWith('peak-main', 'text-color', 'hsl(115, 100%, 20%)');

  setPaintProperty.mockClear();
  applyBasemapTheme(map, 'slate');
  expect(setPaintProperty).toHaveBeenCalledWith('terrain-background', 'background-color', '#0d1520');
  expect(setPaintProperty).toHaveBeenCalledWith('water', 'fill-color', '#0d1520');
  expect(setPaintProperty).toHaveBeenCalledWith('waterway', 'line-color', '#244563');
  expect(setPaintProperty).toHaveBeenCalledWith('place-city', 'text-color', '#e2e8f0');
});
