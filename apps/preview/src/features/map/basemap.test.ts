import { expect, it, vi } from 'vitest';
import { WEATHER_CEILING_ID } from '@av/client';
import {
  applyBasemapTheme,
  CLASSIC_BASEMAP_ID,
  compositeBasemapStyle,
  naturalBasemapStyle,
  TERRAIN_BG_ID,
  TERRAIN_HILLSHADE_BASE_ID,
  TERRAIN_RELIEF_ID
} from './basemap';
import { MAP_THEMES } from './visual-theme';

it('uses XC Skies natural terrain plus the road and label overlay', () => {
  const style = naturalBasemapStyle();
  expect(style.sources?.basemap).toMatchObject({
    type: 'raster',
    tiles: [
      'https://s3rend1.xcskies.com/natural/{z}/{x}/{y}.jpg',
      'https://s3rend2.xcskies.com/natural/{z}/{x}/{y}.jpg',
      'https://s3rend3.xcskies.com/natural/{z}/{x}/{y}.jpg'
    ],
    tileSize: 256,
    minzoom: 2,
    maxzoom: 16,
    attribution: expect.stringContaining('https://xcskies.com/')
  });
  expect(style.glyphs).toBe('https://xcskies.com/static/fonts/{fontstack}/{range}.pbf');
  expect(style.sprite).toBe('https://xcskies.com/static/styles/osm-bright/sprite');
  expect(style.sources?.xcskies).toMatchObject({
    type: 'vector',
    tiles: [
      'https://vtlabel1.xcskies.com/vt/{z}/{x}/{y}.pbf',
      'https://vtlabel2.xcskies.com/vt/{z}/{x}/{y}.pbf',
      'https://vtlabel3.xcskies.com/vt/{z}/{x}/{y}.pbf'
    ]
  });
  expect(style.layers?.[0]).toMatchObject({ id: 'basemap', type: 'raster', source: 'basemap' });
  expect(style.layers?.some(layer => layer.type === 'background')).toBe(false);
  expect(style.layers?.some(layer => layer.type === 'symbol')).toBe(true);
  expect(style.layers?.some(layer => layer.id === 'road_major_motorway')).toBe(true);
});

it('requests XC Skies retina natural tiles at a device pixel ratio of 2', () => {
  const style = naturalBasemapStyle(2);
  expect(style.sources?.basemap).toMatchObject({
    tiles: [
      'https://s3rend1.xcskies.com/natural/{z}/{x}/{y}@2x.jpg',
      'https://s3rend2.xcskies.com/natural/{z}/{x}/{y}@2x.jpg',
      'https://s3rend3.xcskies.com/natural/{z}/{x}/{y}@2x.jpg'
    ]
  });
});

it('builds all 8 soaring themes and toggles cleanly between DEM relief and Classic XC Skies raster', () => {
  for (const theme of MAP_THEMES) {
    const style = compositeBasemapStyle(theme, 2);
    expect(style.sources?.['terrain-dem']).toMatchObject({ type: 'raster-dem', encoding: 'terrarium', maxzoom: 12 });
    expect(style.sources?.[CLASSIC_BASEMAP_ID]).toMatchObject({ type: 'raster' });
  }

  const stone = compositeBasemapStyle('stone');
  const slate = compositeBasemapStyle('slate');
  const xcskies = compositeBasemapStyle('xcskies');
  const ids = stone.layers.map(layer => layer.id);
  expect(ids.slice(0, 5)).toEqual([
    TERRAIN_BG_ID,
    CLASSIC_BASEMAP_ID,
    TERRAIN_RELIEF_ID,
    TERRAIN_HILLSHADE_BASE_ID,
    WEATHER_CEILING_ID
  ]);
  expect((stone.layers[1] as { layout?: { visibility?: string } }).layout?.visibility).toBe('none');
  expect((xcskies.layers[1] as { layout?: { visibility?: string } }).layout?.visibility).toBe('visible');
  expect((xcskies.layers[2] as { layout?: { visibility?: string } }).layout?.visibility).toBe('none');
  expect((stone.layers[0] as { paint: Record<string, unknown> }).paint['background-color'])
    .not.toBe((slate.layers[0] as { paint: Record<string, unknown> }).paint['background-color']);

  const setPaintProperty = vi.fn();
  const setLayoutProperty = vi.fn();
  applyBasemapTheme({ getLayer: id => ids.includes(id), setPaintProperty, setLayoutProperty }, 'slate');
  expect(setPaintProperty).toHaveBeenCalledWith(TERRAIN_BG_ID, 'background-color', '#0f1722');
  expect(setPaintProperty).toHaveBeenCalledWith(WEATHER_CEILING_ID, 'hillshade-exaggeration', 0.52);
  expect(setLayoutProperty).toHaveBeenCalledWith(CLASSIC_BASEMAP_ID, 'visibility', 'none');

  setLayoutProperty.mockClear();
  applyBasemapTheme({ getLayer: id => ids.includes(id), setPaintProperty, setLayoutProperty }, 'xcskies');
  expect(setLayoutProperty).toHaveBeenCalledWith(CLASSIC_BASEMAP_ID, 'visibility', 'visible');
  expect(setLayoutProperty).toHaveBeenCalledWith(TERRAIN_RELIEF_ID, 'visibility', 'none');
});
