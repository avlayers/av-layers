import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { WEATHER_CEILING_ID } from '@av/client';
import overlay from './xc-natural-overlay.json';
import type { MapTheme } from './visual-theme';

const TILE_HOSTS = [1, 2, 3] as const;
// XC Skies serves Natural through zoom 16 and uses a @2x JPEG on retina displays.
const NATIVE_MAX_ZOOM = 16;
const DEM_MAX_ZOOM = 12;
const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
const MULTI_DIRECTIONS = [270, 315, 0, 45];
const MULTI_ALTITUDES = [30, 30, 30, 30];

export const TERRAIN_BG_ID = 'terrain-background';
export const CLASSIC_BASEMAP_ID = 'basemap';
export const TERRAIN_RELIEF_ID = 'terrain-relief';
export const TERRAIN_HILLSHADE_BASE_ID = 'terrain-hillshade-base';

interface ThemeTokens {
  readonly classicRaster?: boolean;
  readonly ocean: string;
  readonly relief: unknown[];
  readonly baseShadow: string;
  readonly baseHighlight: string;
  readonly baseAccent: string;
  readonly baseExaggeration: number;
  readonly topShadow: string;
  readonly topHighlight: string;
  readonly topAccent: string;
  readonly topExaggeration: number;
  readonly coastline: string;
  readonly roadMajor: string;
  readonly roadMinor: string;
  readonly roadCase: string;
  readonly railway: string;
  readonly waterway: string;
  readonly borderMajor: string;
  readonly borderMinor: string;
  readonly aeroText: string;
  readonly peakText: string;
  readonly waterText: string;
  readonly waterHalo: string;
  readonly placeText: string;
  readonly poiText: string;
  readonly textHalo: string;
}

const STONE_TOKENS: ThemeTokens = {
  ocean: '#cad6e2',
  relief: ['interpolate', ['linear'], ['elevation'], -1, '#cad6e2', 0, '#cad6e2', 0.5, '#e8e3d9', 600, '#e2ddd2', 1800, '#dbd5c9', 3500, '#d5cfc3', 5500, '#ebe7df'],
  baseShadow: '#4d4841', baseHighlight: '#fbf9f4', baseAccent: '#5a544c', baseExaggeration: 0.52,
  topShadow: 'rgba(40, 35, 30, 0.44)', topHighlight: 'rgba(255, 252, 246, 0.22)', topAccent: 'rgba(36, 31, 26, 0.36)', topExaggeration: 0.46,
  coastline: '#5c6c7d', roadMajor: 'rgba(255, 253, 249, 0.62)', roadMinor: 'rgba(244, 240, 233, 0.44)', roadCase: 'rgba(182, 176, 166, 0.38)',
  railway: 'rgba(128, 122, 114, 0.45)', waterway: '#7da5c8', borderMajor: 'rgba(72, 68, 62, 0.54)', borderMinor: 'rgba(96, 91, 84, 0.40)',
  aeroText: '#0f5499', peakText: '#3b3731', waterText: '#2f6694', waterHalo: 'rgba(238, 244, 250, 0.92)',
  placeText: '#1e242c', poiText: '#4c545e', textHalo: 'rgba(251, 249, 245, 0.92)'
};

const SLATE_TOKENS: ThemeTokens = {
  ocean: '#0f1722',
  relief: ['interpolate', ['linear'], ['elevation'], -1, '#0f1722', 0, '#0f1722', 0.5, '#1b222c', 600, '#202834', 1800, '#26303e', 3500, '#2d3949', 5500, '#384659'],
  baseShadow: '#05080d', baseHighlight: '#556579', baseAccent: '#090d14', baseExaggeration: 0.58,
  topShadow: 'rgba(3, 6, 10, 0.62)', topHighlight: 'rgba(178, 196, 218, 0.20)', topAccent: 'rgba(3, 6, 10, 0.50)', topExaggeration: 0.52,
  coastline: '#455970', roadMajor: 'rgba(116, 134, 156, 0.34)', roadMinor: 'rgba(92, 108, 128, 0.22)', roadCase: 'rgba(20, 28, 38, 0.42)',
  railway: 'rgba(104, 120, 140, 0.28)', waterway: '#2c5275', borderMajor: 'rgba(156, 172, 192, 0.42)', borderMinor: 'rgba(124, 140, 160, 0.28)',
  aeroText: '#7dd3fc', peakText: '#cbd5e1', waterText: '#60a5fa', waterHalo: 'rgba(10, 16, 24, 0.90)',
  placeText: '#e2e8f0', poiText: '#94a3b8', textHalo: 'rgba(10, 15, 23, 0.92)'
};

const CHART_TOKENS: ThemeTokens = {
  ocean: '#c9dbe8',
  relief: ['interpolate', ['linear'], ['elevation'], -1, '#c9dbe8', 0, '#c9dbe8', 0.5, '#f2eee4', 700, '#ece6d8', 2000, '#e3dccb', 3800, '#dad1be', 5600, '#f4f1ea'],
  baseShadow: '#5b5042', baseHighlight: '#fffdf8', baseAccent: '#6b5e4c', baseExaggeration: 0.50,
  topShadow: 'rgba(54, 45, 34, 0.42)', topHighlight: 'rgba(255, 253, 248, 0.20)', topAccent: 'rgba(48, 39, 29, 0.34)', topExaggeration: 0.44,
  coastline: '#3b5978', roadMajor: 'rgba(255, 254, 250, 0.72)', roadMinor: 'rgba(245, 241, 232, 0.50)', roadCase: 'rgba(168, 158, 142, 0.45)',
  railway: 'rgba(108, 98, 86, 0.52)', waterway: '#6798c0', borderMajor: 'rgba(88, 62, 108, 0.58)', borderMinor: 'rgba(110, 88, 128, 0.42)',
  aeroText: '#1e3a8a', peakText: '#4a3b2c', waterText: '#255c8a', waterHalo: 'rgba(244, 248, 252, 0.94)',
  placeText: '#1c2128', poiText: '#524b42', textHalo: 'rgba(253, 251, 246, 0.94)'
};

const ALABASTER_TOKENS: ThemeTokens = {
  ocean: '#d6e3ed',
  relief: ['interpolate', ['linear'], ['elevation'], -1, '#d6e3ed', 0, '#d6e3ed', 0.5, '#f5f4f0', 800, '#efeee9', 2200, '#e7e5df', 4000, '#dedcd5', 5800, '#f8f7f4'],
  baseShadow: '#5c6168', baseHighlight: '#ffffff', baseAccent: '#686e76', baseExaggeration: 0.46,
  topShadow: 'rgba(44, 48, 54, 0.38)', topHighlight: 'rgba(255, 255, 255, 0.22)', topAccent: 'rgba(40, 44, 50, 0.30)', topExaggeration: 0.42,
  coastline: '#64748b', roadMajor: 'rgba(255, 255, 255, 0.68)', roadMinor: 'rgba(241, 245, 249, 0.46)', roadCase: 'rgba(186, 194, 204, 0.38)',
  railway: 'rgba(132, 140, 150, 0.42)', waterway: '#7fa8cc', borderMajor: 'rgba(71, 85, 105, 0.50)', borderMinor: 'rgba(100, 116, 139, 0.36)',
  aeroText: '#0369a1', peakText: '#334155', waterText: '#2c6896', waterHalo: 'rgba(248, 250, 252, 0.94)',
  placeText: '#1e293b', poiText: '#475569', textHalo: 'rgba(255, 255, 255, 0.94)'
};

const CONVERGENCE_TOKENS: ThemeTokens = {
  ocean: '#bdcfe0',
  relief: ['interpolate', ['linear'], ['elevation'], -1, '#bdcfe0', 0, '#bdcfe0', 0.5, '#dde3e9', 700, '#d5dce4', 2000, '#cbd4de', 3800, '#c2ccd8', 5600, '#e6ebf0'],
  baseShadow: '#3e4a59', baseHighlight: '#f8fafc', baseAccent: '#475569', baseExaggeration: 0.54,
  topShadow: 'rgba(30, 41, 59, 0.46)', topHighlight: 'rgba(248, 250, 252, 0.22)', topAccent: 'rgba(30, 41, 59, 0.36)', topExaggeration: 0.48,
  coastline: '#475569', roadMajor: 'rgba(248, 250, 252, 0.58)', roadMinor: 'rgba(226, 232, 240, 0.42)', roadCase: 'rgba(148, 163, 184, 0.38)',
  railway: 'rgba(100, 116, 139, 0.42)', waterway: '#6495be', borderMajor: 'rgba(51, 65, 85, 0.54)', borderMinor: 'rgba(71, 85, 105, 0.38)',
  aeroText: '#0f4c81', peakText: '#1e293b', waterText: '#245885', waterHalo: 'rgba(241, 245, 249, 0.92)',
  placeText: '#0f172a', poiText: '#334155', textHalo: 'rgba(248, 250, 252, 0.92)'
};

const BLUEPRINT_TOKENS: ThemeTokens = {
  ocean: '#081322',
  relief: ['interpolate', ['linear'], ['elevation'], -1, '#081322', 0, '#081322', 0.5, '#102238', 700, '#142a44', 2000, '#193352', 3800, '#1f3d61', 5600, '#294d78'],
  baseShadow: '#030811', baseHighlight: '#4b76a6', baseAccent: '#06101e', baseExaggeration: 0.58,
  topShadow: 'rgba(2, 7, 15, 0.64)', topHighlight: 'rgba(147, 197, 253, 0.20)', topAccent: 'rgba(2, 7, 15, 0.52)', topExaggeration: 0.52,
  coastline: '#38bdf8', roadMajor: 'rgba(125, 211, 252, 0.30)', roadMinor: 'rgba(56, 189, 248, 0.18)', roadCase: 'rgba(8, 21, 38, 0.48)',
  railway: 'rgba(125, 211, 252, 0.25)', waterway: '#0284c7', borderMajor: 'rgba(125, 211, 252, 0.46)', borderMinor: 'rgba(56, 189, 248, 0.28)',
  aeroText: '#67e8f9', peakText: '#bae6fd', waterText: '#38bdf8', waterHalo: 'rgba(8, 19, 34, 0.92)',
  placeText: '#e0f2fe', poiText: '#7dd3fc', textHalo: 'rgba(8, 19, 34, 0.94)'
};

const COCKPIT_TOKENS: ThemeTokens = {
  ocean: '#bcd4e6',
  relief: ['interpolate', ['linear'], ['elevation'], -1, '#bcd4e6', 0, '#bcd4e6', 0.5, '#faf9f5', 800, '#f4f2ec', 2200, '#ece9e0', 4000, '#e3dfd4', 5800, '#ffffff'],
  baseShadow: '#262626', baseHighlight: '#ffffff', baseAccent: '#171717', baseExaggeration: 0.62,
  topShadow: 'rgba(15, 15, 15, 0.52)', topHighlight: 'rgba(255, 255, 255, 0.26)', topAccent: 'rgba(10, 10, 10, 0.44)', topExaggeration: 0.54,
  coastline: '#1e293b', roadMajor: 'rgba(255, 255, 255, 0.85)', roadMinor: 'rgba(245, 245, 244, 0.60)', roadCase: 'rgba(115, 115, 115, 0.55)',
  railway: 'rgba(82, 82, 82, 0.58)', waterway: '#3b82f6', borderMajor: 'rgba(15, 23, 42, 0.72)', borderMinor: 'rgba(51, 65, 85, 0.52)',
  aeroText: '#1d4ed8', peakText: '#171717', waterText: '#1d4ed8', waterHalo: 'rgba(255, 255, 255, 0.96)',
  placeText: '#000000', poiText: '#262626', textHalo: 'rgba(255, 255, 255, 0.96)'
};

const XCSKIES_TOKENS: ThemeTokens = {
  ...STONE_TOKENS,
  classicRaster: true,
  coastline: '#000000',
  roadMajor: 'hsl(0, 0%, 97%)',
  roadMinor: 'hsl(0, 0%, 87%)',
  roadCase: '#dedede',
  railway: 'hsl(34, 12%, 66%)',
  waterway: 'hsl(205, 56%, 73%)',
  borderMajor: 'hsl(0, 0%, 40%)',
  borderMinor: 'hsl(0, 0%, 50%)',
  aeroText: 'hsl(209, 100%, 36%)',
  peakText: 'hsl(115, 100%, 20%)',
  waterText: '#2280dd',
  waterHalo: '#ffffff',
  placeText: '#000000',
  poiText: '#666666',
  textHalo: '#ffffff'
};

function tokensFor(theme: MapTheme): ThemeTokens {
  switch (theme) {
    case 'slate': return SLATE_TOKENS;
    case 'chart': return CHART_TOKENS;
    case 'alabaster': return ALABASTER_TOKENS;
    case 'convergence': return CONVERGENCE_TOKENS;
    case 'blueprint': return BLUEPRINT_TOKENS;
    case 'cockpit': return COCKPIT_TOKENS;
    case 'xcskies': return XCSKIES_TOKENS;
    default: return STONE_TOKENS;
  }
}

function overlayPaintOverrides(id: string, type: string, t: ThemeTokens): Record<string, unknown> {
  if (id === 'coastline') return { 'line-color': t.coastline };
  if (id === 'road_bridge_area') return { 'fill-color': t.roadMajor, 'fill-opacity': 0.35 };
  if (id.includes('case')) return { 'line-color': t.roadCase };
  if (id.startsWith('waterway')) return type === 'symbol'
    ? { 'text-color': t.waterText, 'text-halo-color': t.waterHalo }
    : { 'line-color': t.waterway };
  if (id.startsWith('road_') || id.startsWith('tunnel_') || id.startsWith('bridge_')) {
    if (type === 'symbol') return { 'text-color': t.placeText, 'text-halo-color': t.textHalo };
    const major = id.includes('major') || id.includes('trunk') || id.includes('secondary');
    return { 'line-color': major ? t.roadMajor : t.roadMinor };
  }
  if (id.startsWith('railway')) return { 'line-color': t.railway };
  if (id.startsWith('admin_')) {
    const major = id === 'admin_country_a' || id === 'admin_country_hi2';
    return { 'line-color': major ? t.borderMajor : t.borderMinor };
  }
  if (id.startsWith('aero-')) return { 'text-color': t.aeroText, 'text-halo-color': t.textHalo };
  if (id.startsWith('peak-')) return { 'text-color': t.peakText, 'text-halo-color': t.textHalo };
  if (id.startsWith('water-name') || id === 'lake-label' || id === 'sea-ocean') {
    return { 'text-color': t.waterText, 'text-halo-color': t.waterHalo };
  }
  if (id === 'park-label' || id.startsWith('poi-')) {
    return { 'text-color': t.poiText, 'text-halo-color': t.textHalo };
  }
  if (type === 'symbol') return { 'text-color': t.placeText, 'text-halo-color': t.textHalo };
  return {};
}

function themedOverlayLayers(theme: MapTheme): LayerSpecification[] {
  const t = tokensFor(theme);
  return (overlay.layers as LayerSpecification[]).map(layer => {
    const overrides = overlayPaintOverrides(layer.id, layer.type, t);
    return Object.keys(overrides).length
      ? ({ ...layer, paint: { ...(layer.paint ?? {}), ...overrides } } as LayerSpecification)
      : layer;
  });
}

function xcSkiesRasterSource(pixelRatio = 1) {
  const suffix = pixelRatio >= 2 ? '@2x' : '';
  return {
    type: 'raster' as const,
    tiles: TILE_HOSTS.map(host => `https://s3rend${host}.xcskies.com/natural/{z}/{x}/{y}${suffix}.jpg`),
    tileSize: 256,
    minzoom: 2,
    maxzoom: NATIVE_MAX_ZOOM,
    attribution: '© <a href="https://xcskies.com/">XC Skies</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  };
}

/** XC Skies Natural shaded relief, with the roads and labels drawn above it. */
export function naturalBasemapStyle(pixelRatio = 1): StyleSpecification {
  return {
    version: 8,
    glyphs: overlay.glyphs,
    sprite: overlay.sprite,
    sources: {
      basemap: xcSkiesRasterSource(pixelRatio),
      ...overlay.sources
    },
    layers: [
      { id: CLASSIC_BASEMAP_ID, type: 'raster', source: CLASSIC_BASEMAP_ID },
      ...overlay.layers
    ]
  } as StyleSpecification;
}

/**
 * Multi-theme soaring basemap supporting all 7 DEM-shaded cartographic themes plus
 * instant 0 ms in-place switching to/from Classic XC Skies Natural raster tiles.
 */
export function compositeBasemapStyle(theme: MapTheme = 'stone', pixelRatio = 1): StyleSpecification {
  const t = tokensFor(theme);
  const classic = Boolean(t.classicRaster);
  const demVisibility = classic ? 'none' : 'visible';
  return {
    version: 8,
    glyphs: overlay.glyphs,
    sprite: overlay.sprite,
    sources: {
      [CLASSIC_BASEMAP_ID]: xcSkiesRasterSource(pixelRatio),
      'terrain-dem': {
        type: 'raster-dem',
        tiles: DEM_TILES,
        tileSize: 256,
        maxzoom: DEM_MAX_ZOOM,
        encoding: 'terrarium',
        attribution: '© <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen / AWS Terrain</a> · © <a href="https://xcskies.com/">XC Skies</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      },
      ...overlay.sources
    },
    layers: [
      { id: TERRAIN_BG_ID, type: 'background', paint: { 'background-color': t.ocean } },
      { id: CLASSIC_BASEMAP_ID, type: 'raster', source: CLASSIC_BASEMAP_ID, layout: { visibility: classic ? 'visible' : 'none' } },
      { id: TERRAIN_RELIEF_ID, type: 'color-relief', source: 'terrain-dem', layout: { visibility: demVisibility }, paint: { 'color-relief-color': t.relief as never, 'color-relief-opacity': 1 } },
      {
        id: TERRAIN_HILLSHADE_BASE_ID,
        type: 'hillshade',
        source: 'terrain-dem',
        layout: { visibility: demVisibility },
        paint: {
          'hillshade-method': 'multidirectional',
          'hillshade-illumination-anchor': 'map',
          'hillshade-illumination-direction': MULTI_DIRECTIONS,
          'hillshade-illumination-altitude': MULTI_ALTITUDES,
          'hillshade-shadow-color': t.baseShadow,
          'hillshade-highlight-color': t.baseHighlight,
          'hillshade-accent-color': t.baseAccent,
          'hillshade-exaggeration': t.baseExaggeration
        }
      },
      {
        id: WEATHER_CEILING_ID,
        type: 'hillshade',
        source: 'terrain-dem',
        layout: { visibility: demVisibility },
        paint: {
          'hillshade-method': 'standard',
          'hillshade-illumination-anchor': 'map',
          'hillshade-illumination-direction': 315,
          'hillshade-illumination-altitude': 32,
          'hillshade-shadow-color': t.topShadow,
          'hillshade-highlight-color': t.topHighlight,
          'hillshade-accent-color': t.topAccent,
          'hillshade-exaggeration': t.topExaggeration
        }
      },
      ...themedOverlayLayers(theme)
    ]
  } as StyleSpecification;
}

/** Updates terrain, hillshade ceiling, classic XC Skies raster visibility, and vector label paints in place. */
export function applyBasemapTheme(
  map: {
    getLayer?(id: string): unknown;
    setPaintProperty?(layerId: string, name: string, value: unknown): void;
    setLayoutProperty?(layerId: string, name: string, value: unknown): void;
  } | null,
  theme: MapTheme
): void {
  if (!map || typeof map.getLayer !== 'function' || typeof map.setPaintProperty !== 'function') return;
  const t = tokensFor(theme);
  const classic = Boolean(t.classicRaster);
  const demVisibility = classic ? 'none' : 'visible';

  const setPaint = (id: string, prop: string, value: unknown) => {
    if (map.getLayer!(id)) map.setPaintProperty!(id, prop, value);
  };
  const setVis = (id: string, vis: 'visible' | 'none') => {
    if (typeof map.setLayoutProperty === 'function' && map.getLayer!(id)) {
      map.setLayoutProperty(id, 'visibility', vis);
    }
  };

  setVis(CLASSIC_BASEMAP_ID, classic ? 'visible' : 'none');
  setVis(TERRAIN_RELIEF_ID, demVisibility);
  setVis(TERRAIN_HILLSHADE_BASE_ID, demVisibility);
  setVis(WEATHER_CEILING_ID, demVisibility);

  setPaint(TERRAIN_BG_ID, 'background-color', t.ocean);
  if (!classic) {
    setPaint(TERRAIN_RELIEF_ID, 'color-relief-color', t.relief);
    setPaint(TERRAIN_HILLSHADE_BASE_ID, 'hillshade-shadow-color', t.baseShadow);
    setPaint(TERRAIN_HILLSHADE_BASE_ID, 'hillshade-highlight-color', t.baseHighlight);
    setPaint(TERRAIN_HILLSHADE_BASE_ID, 'hillshade-accent-color', t.baseAccent);
    setPaint(TERRAIN_HILLSHADE_BASE_ID, 'hillshade-exaggeration', t.baseExaggeration);
    setPaint(WEATHER_CEILING_ID, 'hillshade-shadow-color', t.topShadow);
    setPaint(WEATHER_CEILING_ID, 'hillshade-highlight-color', t.topHighlight);
    setPaint(WEATHER_CEILING_ID, 'hillshade-accent-color', t.topAccent);
    setPaint(WEATHER_CEILING_ID, 'hillshade-exaggeration', t.topExaggeration);
  }

  for (const layer of overlay.layers) {
    if (!map.getLayer(layer.id)) continue;
    const overrides = overlayPaintOverrides(layer.id, layer.type, t);
    for (const [prop, value] of Object.entries(overrides)) {
      map.setPaintProperty(layer.id, prop, value);
    }
  }
}
