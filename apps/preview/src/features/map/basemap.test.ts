import { expect, it } from 'vitest';
import { naturalBasemapStyle } from './basemap';

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
