import type { StyleSpecification } from 'maplibre-gl';
import overlay from './xc-natural-overlay.json';

const TILE_HOSTS = [1, 2, 3] as const;
// XC Skies serves Natural through zoom 16 and uses a @2x JPEG on retina displays.
const NATIVE_MAX_ZOOM = 16;

/** XC Skies Natural shaded relief, with the roads and labels drawn above it. */
export function naturalBasemapStyle(pixelRatio = 1): StyleSpecification {
  const suffix = pixelRatio >= 2 ? '@2x' : '';
  return {
    version: 8,
    glyphs: overlay.glyphs,
    sprite: overlay.sprite,
    sources: {
      basemap: {
        type: 'raster',
        tiles: TILE_HOSTS.map(host => `https://s3rend${host}.xcskies.com/natural/{z}/{x}/{y}${suffix}.jpg`),
        tileSize: 256,
        minzoom: 2,
        maxzoom: NATIVE_MAX_ZOOM,
        attribution: '© <a href="https://xcskies.com/">XC Skies</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      },
      ...overlay.sources
    },
    layers: [
      { id: 'basemap', type: 'raster', source: 'basemap' },
      ...overlay.layers
    ]
  } as StyleSpecification;
}
