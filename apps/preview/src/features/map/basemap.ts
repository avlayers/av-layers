import type { ExpressionSpecification, FilterSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { WEATHER_CEILING_ID } from '@av/client';
import type { MapTheme } from './visual-theme';

const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
const DEM_MAX_ZOOM = 12;
const VECTOR_SOURCE_ID = 'openmaptiles';
const VECTOR_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const SPRITE_URL = 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm';
const TERRAIN_BG_ID = 'terrain-background';
const TERRAIN_RELIEF_ID = 'terrain-relief';
const TERRAIN_HILLSHADE_BASE_ID = 'terrain-hillshade-base';
const WATER_FILL_ID = 'water';

interface ThemeTokens {
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
  ocean: '#a6bacb',
  relief: [
    'interpolate', ['linear'], ['elevation'],
    -1, '#a6bacb', 0, '#a6bacb', 0.5, '#d8dfd3', 200, '#dde0d4', 600, '#e2ddd2',
    1200, '#dfd6c8', 2000, '#d8cec0', 3000, '#d2c8ba', 4200, '#dcd7cf', 5500, '#ebe8e2'
  ],
  baseShadow: '#47505c', baseHighlight: '#fffdf9', baseAccent: '#56606e', baseExaggeration: 0.45,
  topShadow: 'rgba(38, 46, 56, 0.42)', topHighlight: 'rgba(255, 253, 248, 0.24)', topAccent: 'rgba(35, 42, 52, 0.34)', topExaggeration: 0.48,
  roadMajor: 'rgba(255, 253, 249, 0.62)', roadMinor: 'rgba(244, 240, 233, 0.44)', roadCase: 'rgba(182, 176, 166, 0.38)',
  railway: 'rgba(138, 132, 122, 0.45)', waterway: '#7fa4c2',
  borderMajor: 'rgba(82, 90, 100, 0.72)', borderMinor: 'rgba(108, 116, 126, 0.50)',
  aeroText: '#144d82', peakText: '#1f5427', waterText: '#2c689e', waterHalo: 'rgba(245, 248, 250, 0.88)',
  placeText: '#1e2730', poiText: '#4f5964', textHalo: 'rgba(250, 248, 244, 0.90)'
};

const SLATE_TOKENS: ThemeTokens = {
  ocean: '#0d1520',
  relief: [
    'interpolate', ['linear'], ['elevation'],
    -1, '#0d1520', 0, '#0d1520', 0.5, '#1a222d', 300, '#1e2733', 900, '#242e3b',
    1800, '#2b3644', 2800, '#323f4e', 4000, '#3b4959', 5500, '#465668'
  ],
  baseShadow: '#05080d', baseHighlight: '#506073', baseAccent: '#090e16', baseExaggeration: 0.46,
  topShadow: 'rgba(4, 7, 12, 0.52)', topHighlight: 'rgba(148, 170, 196, 0.22)', topAccent: 'rgba(5, 9, 15, 0.42)', topExaggeration: 0.48,
  roadMajor: 'rgba(116, 134, 156, 0.34)', roadMinor: 'rgba(92, 108, 128, 0.22)', roadCase: 'rgba(20, 28, 38, 0.42)',
  railway: 'rgba(100, 114, 132, 0.28)', waterway: '#244563',
  borderMajor: 'rgba(148, 163, 184, 0.55)', borderMinor: 'rgba(100, 116, 139, 0.36)',
  aeroText: '#7cc4fa', peakText: '#86efac', waterText: '#60a5fa', waterHalo: 'rgba(10, 16, 24, 0.92)',
  placeText: '#e2e8f0', poiText: '#94a3b8', textHalo: 'rgba(10, 15, 23, 0.92)'
};

const CHART_TOKENS: ThemeTokens = {
  ocean: '#9ec2d8',
  relief: [
    'interpolate', ['linear'], ['elevation'],
    -1, '#9ec2d8', 0, '#9ec2d8', 0.5, '#dde5d0', 250, '#e5e7d3', 700, '#ece6d8',
    1400, '#e6dccb', 2200, '#dfd0bc', 3200, '#d8c5ae', 4500, '#e2d8ca'
  ],
  baseShadow: '#5b5346', baseHighlight: '#fffdf7', baseAccent: '#695f50', baseExaggeration: 0.48,
  topShadow: 'rgba(52, 46, 38, 0.44)', topHighlight: 'rgba(255, 252, 244, 0.25)', topAccent: 'rgba(46, 40, 32, 0.36)', topExaggeration: 0.50,
  roadMajor: 'rgba(255, 254, 250, 0.72)', roadMinor: 'rgba(245, 241, 232, 0.50)', roadCase: 'rgba(168, 158, 142, 0.45)',
  railway: 'rgba(124, 114, 100, 0.50)', waterway: '#699bc2',
  borderMajor: 'rgba(92, 76, 108, 0.76)', borderMinor: 'rgba(116, 102, 128, 0.52)',
  aeroText: '#134074', peakText: '#1b4332', waterText: '#1d6396', waterHalo: 'rgba(250, 248, 242, 0.90)',
  placeText: '#1c1917', poiText: '#57534e', textHalo: 'rgba(253, 251, 246, 0.92)'
};

const ALABASTER_TOKENS: ThemeTokens = {
  ocean: '#b8cad8',
  relief: [
    'interpolate', ['linear'], ['elevation'],
    -1, '#b8cad8', 0, '#b8cad8', 0.5, '#eaede8', 300, '#edeee9', 800, '#efeee9',
    1600, '#eceae4', 2600, '#e7e4dd', 3800, '#e2dfd8', 5200, '#f2f0ec'
  ],
  baseShadow: '#646e78', baseHighlight: '#ffffff', baseAccent: '#737e8a', baseExaggeration: 0.38,
  topShadow: 'rgba(51, 61, 72, 0.36)', topHighlight: 'rgba(255, 255, 255, 0.22)', topAccent: 'rgba(45, 55, 66, 0.30)', topExaggeration: 0.42,
  roadMajor: 'rgba(255, 255, 255, 0.68)', roadMinor: 'rgba(241, 245, 249, 0.46)', roadCase: 'rgba(186, 194, 204, 0.38)',
  railway: 'rgba(148, 163, 184, 0.42)', waterway: '#8bb0cc',
  borderMajor: 'rgba(71, 85, 105, 0.68)', borderMinor: 'rgba(100, 116, 139, 0.46)',
  aeroText: '#0f4c81', peakText: '#166534', waterText: '#2563eb', waterHalo: 'rgba(255, 255, 255, 0.92)',
  placeText: '#0f172a', poiText: '#475569', textHalo: 'rgba(255, 255, 255, 0.92)'
};

const CONVERGENCE_TOKENS: ThemeTokens = {
  ocean: '#96b1c6',
  relief: [
    'interpolate', ['linear'], ['elevation'],
    -1, '#96b1c6', 0, '#96b1c6', 0.5, '#ccd6dc', 250, '#d1d8df', 700, '#d5dce4',
    1500, '#d2d8e0', 2500, '#cdd4dc', 3800, '#c8d0d9', 5200, '#dde3ea'
  ],
  baseShadow: '#3f4c5c', baseHighlight: '#f8fafc', baseAccent: '#4b5a6c', baseExaggeration: 0.46,
  topShadow: 'rgba(30, 41, 59, 0.44)', topHighlight: 'rgba(248, 250, 252, 0.24)', topAccent: 'rgba(30, 41, 59, 0.36)', topExaggeration: 0.48,
  roadMajor: 'rgba(248, 250, 252, 0.58)', roadMinor: 'rgba(226, 232, 240, 0.42)', roadCase: 'rgba(148, 163, 184, 0.38)',
  railway: 'rgba(100, 116, 139, 0.42)', waterway: '#6495b8',
  borderMajor: 'rgba(51, 65, 85, 0.72)', borderMinor: 'rgba(71, 85, 105, 0.48)',
  aeroText: '#0c4a6e', peakText: '#14532d', waterText: '#1e40af', waterHalo: 'rgba(241, 245, 249, 0.90)',
  placeText: '#0f172a', poiText: '#334155', textHalo: 'rgba(248, 250, 252, 0.90)'
};

const BLUEPRINT_TOKENS: ThemeTokens = {
  ocean: '#071322',
  relief: [
    'interpolate', ['linear'], ['elevation'],
    -1, '#071322', 0, '#071322', 0.5, '#0f2136', 300, '#132740', 900, '#172e4a',
    1800, '#1c3756', 2800, '#224063', 4000, '#294b72', 5500, '#325882'
  ],
  baseShadow: '#030912', baseHighlight: '#4b7aa8', baseAccent: '#06101e', baseExaggeration: 0.48,
  topShadow: 'rgba(2, 8, 16, 0.54)', topHighlight: 'rgba(125, 211, 252, 0.22)', topAccent: 'rgba(4, 12, 24, 0.44)', topExaggeration: 0.50,
  roadMajor: 'rgba(125, 211, 252, 0.30)', roadMinor: 'rgba(56, 189, 248, 0.18)', roadCase: 'rgba(8, 21, 38, 0.48)',
  railway: 'rgba(96, 165, 250, 0.26)', waterway: '#0284c7',
  borderMajor: 'rgba(125, 211, 252, 0.58)', borderMinor: 'rgba(56, 189, 248, 0.36)',
  aeroText: '#7dd3fc', peakText: '#6ee7b7', waterText: '#38bdf8', waterHalo: 'rgba(7, 19, 34, 0.94)',
  placeText: '#e0f2fe', poiText: '#7dd3fc', textHalo: 'rgba(8, 19, 34, 0.94)'
};

const COCKPIT_TOKENS: ThemeTokens = {
  ocean: '#8cb4d2',
  relief: [
    'interpolate', ['linear'], ['elevation'],
    -1, '#8cb4d2', 0, '#8cb4d2', 0.5, '#e7ece4', 300, '#ecefe6', 800, '#f0eee5',
    1600, '#ece8dc', 2600, '#e6e0d2', 3800, '#dfd8c8', 5200, '#f5f3ee'
  ],
  baseShadow: '#333b44', baseHighlight: '#ffffff', baseAccent: '#3f4854', baseExaggeration: 0.54,
  topShadow: 'rgba(24, 30, 38, 0.48)', topHighlight: 'rgba(255, 255, 255, 0.28)', topAccent: 'rgba(20, 26, 34, 0.40)', topExaggeration: 0.54,
  roadMajor: 'rgba(255, 255, 255, 0.85)', roadMinor: 'rgba(245, 245, 244, 0.60)', roadCase: 'rgba(115, 115, 115, 0.55)',
  railway: 'rgba(82, 82, 91, 0.58)', waterway: '#4b86b4',
  borderMajor: 'rgba(24, 24, 27, 0.85)', borderMinor: 'rgba(63, 63, 70, 0.62)',
  aeroText: '#072f5f', peakText: '#052e16', waterText: '#0c4a6e', waterHalo: 'rgba(255, 255, 255, 0.96)',
  placeText: '#09090b', poiText: '#27272a', textHalo: 'rgba(255, 255, 255, 0.96)'
};

const CLASSIC_TOKENS: ThemeTokens = {
  ocean: '#a8c8df',
  relief: [
    'interpolate', ['linear'], ['elevation'],
    -1, '#a8c8df', 0, '#a8c8df', 0.5, '#cadbb8', 350, '#d4dfc0', 900, '#e1dcb9',
    1700, '#dfd0ae', 2600, '#d4bf9b', 3600, '#cab292', 4800, '#ddd6cc', 6000, '#f2efe9'
  ],
  baseShadow: '#3f443b', baseHighlight: '#fffef9', baseAccent: '#4b5045', baseExaggeration: 0.56,
  topShadow: 'rgba(34, 38, 30, 0.44)', topHighlight: 'rgba(255, 253, 246, 0.22)', topAccent: 'rgba(30, 34, 26, 0.36)', topExaggeration: 0.48,
  roadMajor: 'hsl(0, 0%, 97%)', roadMinor: 'hsl(0, 0%, 87%)', roadCase: '#dedede',
  railway: 'hsl(34, 12%, 66%)', waterway: 'hsl(205, 56%, 73%)',
  borderMajor: 'hsl(0, 0%, 40%)', borderMinor: 'hsl(0, 0%, 50%)',
  aeroText: 'hsl(209, 100%, 36%)', peakText: 'hsl(115, 100%, 20%)',
  waterText: '#2280dd', waterHalo: '#ffffff',
  placeText: '#000000', poiText: '#666666', textHalo: '#ffffff'
};

function tokensFor(theme: MapTheme): ThemeTokens {
  switch (theme) {
    case 'stone': return STONE_TOKENS;
    case 'slate': return SLATE_TOKENS;
    case 'chart': return CHART_TOKENS;
    case 'alabaster': return ALABASTER_TOKENS;
    case 'convergence': return CONVERGENCE_TOKENS;
    case 'blueprint': return BLUEPRINT_TOKENS;
    case 'cockpit': return COCKPIT_TOKENS;
    case 'classic': return CLASSIC_TOKENS;
  }
}

const NAME_EXPR: ExpressionSpecification = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
const LINE_GEOM: ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
const POINT_GEOM: ExpressionSpecification = ['==', ['geometry-type'], 'Point'];
const NOT_TUNNEL: ExpressionSpecification = ['!=', ['get', 'brunnel'], 'tunnel'];
const NOT_BRUNNEL: ExpressionSpecification = ['!', ['in', ['get', 'brunnel'], ['literal', ['bridge', 'tunnel']]]];
const MAJOR_ROAD_CLASS: ExpressionSpecification = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false];
const SECONDARY_TERTIARY_CLASS: ExpressionSpecification = ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false];
const TRUNK_PRIMARY_CLASS: ExpressionSpecification = ['match', ['get', 'class'], ['trunk', 'primary'], true, false];
const PEAK_CLASS: ExpressionSpecification = ['match', ['get', 'class'], ['peak', 'volcano'], true, false];
const PEAK_LABEL_EXPR: ExpressionSpecification = [
  'case',
  ['all', ['has', 'name'], ['has', 'ele']],
  ['concat', NAME_EXPR, '\n▲\n', ['to-string', ['get', 'ele']], 'm'],
  ['has', 'name'],
  ['concat', NAME_EXPR, '\n▲'],
  '▲'
];

function expWidth(base: number, ...stops: number[]): unknown[] {
  return ['interpolate', ['exponential', base], ['zoom'], ...stops];
}

function lineLayer(
  id: string,
  sourceLayer: string,
  filter: FilterSpecification,
  paint: Record<string, unknown>,
  options: { minzoom?: number; cap?: 'butt' | 'round' | 'square'; join?: 'bevel' | 'miter' | 'round' } = {}
): LayerSpecification {
  const layer: Record<string, unknown> = {
    id,
    type: 'line',
    source: VECTOR_SOURCE_ID,
    'source-layer': sourceLayer,
    filter,
    layout: { 'line-cap': options.cap ?? 'round', 'line-join': options.join ?? 'round' },
    paint
  };
  if (options.minzoom !== undefined) layer.minzoom = options.minzoom;
  return layer as LayerSpecification;
}

function aeroLayer(
  id: string,
  minzoom: number,
  filter: FilterSpecification,
  iconImage: string,
  textField: unknown[],
  t: ThemeTokens,
  maxzoom?: number
): LayerSpecification {
  const layer: Record<string, unknown> = {
    id,
    type: 'symbol',
    source: VECTOR_SOURCE_ID,
    'source-layer': 'aerodrome_label',
    minzoom,
    filter,
    layout: {
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 13],
      'icon-image': iconImage,
      'text-field': textField,
      'text-offset': [0, 0.4],
      'icon-allow-overlap': true,
      'text-anchor': 'top'
    },
    paint: { 'text-color': t.aeroText, 'text-halo-color': t.textHalo, 'text-halo-width': 2 }
  };
  if (maxzoom !== undefined) layer.maxzoom = maxzoom;
  return layer as LayerSpecification;
}

function placeLayer(
  id: string,
  minzoom: number,
  filter: FilterSpecification,
  layout: Record<string, unknown>,
  t: ThemeTokens,
  maxzoom?: number
): LayerSpecification {
  const layer: Record<string, unknown> = {
    id,
    type: 'symbol',
    source: VECTOR_SOURCE_ID,
    'source-layer': 'place',
    minzoom,
    filter,
    layout: { 'text-field': NAME_EXPR, ...layout },
    paint: { 'text-color': t.placeText, 'text-halo-color': t.textHalo, 'text-halo-width': 2 }
  };
  if (maxzoom !== undefined) layer.maxzoom = maxzoom;
  return layer as LayerSpecification;
}

function terrainLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    { id: TERRAIN_BG_ID, type: 'background', paint: { 'background-color': t.ocean } },
    { id: TERRAIN_RELIEF_ID, type: 'color-relief', source: 'terrain-dem', paint: { 'color-relief-color': t.relief as never, 'color-relief-opacity': 1 } },
    {
      id: TERRAIN_HILLSHADE_BASE_ID,
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-method': 'multidirectional',
        'hillshade-illumination-direction': [315, 270, 355, 30] as never,
        'hillshade-illumination-altitude': [30, 35, 35, 45] as never,
        'hillshade-shadow-color': [t.baseShadow, t.baseShadow, t.baseShadow, t.baseShadow] as never,
        'hillshade-highlight-color': [t.baseHighlight, t.baseHighlight, t.baseHighlight, t.baseHighlight] as never,
        'hillshade-accent-color': t.baseAccent,
        'hillshade-exaggeration': t.baseExaggeration
      }
    },
    {
      id: WATER_FILL_ID,
      type: 'fill',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'water',
      filter: ['all', ['!=', ['get', 'intermittent'], 1], NOT_TUNNEL],
      paint: { 'fill-color': t.ocean }
    },
    {
      id: WEATHER_CEILING_ID,
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-method': 'standard',
        'hillshade-illumination-direction': 315,
        'hillshade-illumination-anchor': 'map',
        'hillshade-shadow-color': t.topShadow,
        'hillshade-highlight-color': t.topHighlight,
        'hillshade-accent-color': t.topAccent,
        'hillshade-exaggeration': t.topExaggeration
      }
    }
  ];
}

function buildOverlayLayers(t: ThemeTokens): LayerSpecification[] {
  const majorWidth = expWidth(1.4, 6, 0.5, 20, 13);
  const majorCaseWidth = expWidth(1.4, 6, 1, 20, 15);
  return [
    lineLayer('waterway', 'waterway', ['all', LINE_GEOM, NOT_BRUNNEL], {
      'line-color': t.waterway,
      'line-width': expWidth(1.3, 9, 0.6, 20, 6)
    }),
    lineLayer('tunnel_major_case', 'transportation', ['all', LINE_GEOM, ['==', ['get', 'brunnel'], 'tunnel'], MAJOR_ROAD_CLASS], {
      'line-color': t.roadCase,
      'line-dasharray': [0.3, 0.15],
      'line-width': expWidth(1.4, 6, 1.2, 20, 15)
    }, { cap: 'butt', join: 'miter' }),
    lineLayer('road_minor-case', 'transportation', ['all', LINE_GEOM, NOT_BRUNNEL, ['==', ['get', 'class'], 'minor']], {
      'line-color': t.roadCase,
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 12.5, 1],
      'line-width': expWidth(1.4, 10, 1, 20, 15)
    }),
    lineLayer('road_secondary_tertiary-case', 'transportation', ['all', LINE_GEOM, NOT_BRUNNEL, SECONDARY_TERTIARY_CLASS], {
      'line-color': t.roadCase,
      'line-width': expWidth(1.4, 8, 1.5, 20, 17)
    }),
    lineLayer('road_trunk_primary-case', 'transportation', ['all', LINE_GEOM, NOT_BRUNNEL, TRUNK_PRIMARY_CLASS], {
      'line-color': t.roadCase,
      'line-width': majorCaseWidth
    }),
    lineLayer('road_major_motorway-case', 'transportation', ['all', LINE_GEOM, NOT_BRUNNEL, ['==', ['get', 'class'], 'motorway']], {
      'line-color': t.roadCase,
      'line-width': majorCaseWidth
    }),
    lineLayer('tunnel_major', 'transportation', ['all', LINE_GEOM, ['==', ['get', 'brunnel'], 'tunnel'], MAJOR_ROAD_CLASS], {
      'line-color': t.roadMajor,
      'line-width': majorWidth
    }, { join: 'miter' }),
    lineLayer('road_minor', 'transportation', ['all', LINE_GEOM, NOT_BRUNNEL, ['==', ['get', 'class'], 'minor']], {
      'line-color': t.roadMinor,
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 12.5, 1],
      'line-width': expWidth(1.4, 13, 0.5, 20, 13)
    }),
    lineLayer('road_secondary_tertiary', 'transportation', ['all', LINE_GEOM, NOT_BRUNNEL, SECONDARY_TERTIARY_CLASS], {
      'line-color': t.roadMajor,
      'line-width': expWidth(1.4, 8, 0.5, 20, 13)
    }),
    lineLayer('road_trunk_primary', 'transportation', ['all', LINE_GEOM, NOT_BRUNNEL, TRUNK_PRIMARY_CLASS], {
      'line-color': t.roadMajor,
      'line-width': majorWidth
    }),
    lineLayer('road_major_motorway', 'transportation', ['all', LINE_GEOM, NOT_BRUNNEL, ['==', ['get', 'class'], 'motorway']], {
      'line-color': t.roadMajor,
      'line-width': majorWidth
    }),
    lineLayer('railway', 'transportation', ['all', LINE_GEOM, ['==', ['get', 'class'], 'rail'], NOT_TUNNEL], {
      'line-color': t.railway,
      'line-width': expWidth(1.4, 14, 0.4, 15, 0.75, 20, 2)
    }, { minzoom: 11 }),
    lineLayer('bridge_major_case', 'transportation', ['all', LINE_GEOM, ['==', ['get', 'brunnel'], 'bridge'], MAJOR_ROAD_CLASS], {
      'line-color': t.roadCase,
      'line-width': majorCaseWidth
    }, { cap: 'butt', join: 'miter' }),
    lineLayer('bridge_major', 'transportation', ['all', LINE_GEOM, ['==', ['get', 'brunnel'], 'bridge'], MAJOR_ROAD_CLASS], {
      'line-color': t.roadMajor,
      'line-width': majorWidth
    }, { join: 'miter' }),
    lineLayer('admin_sub', 'boundary', ['all', ['>=', ['get', 'admin_level'], 3], ['<=', ['get', 'admin_level'], 6], ['!=', ['get', 'maritime'], 1]], {
      'line-color': t.borderMinor,
      'line-dasharray': [3, 1, 1, 1],
      'line-width': expWidth(1.4, 4, 0.4, 5, 1, 12, 1.8)
    }, { minzoom: 4 }),
    lineLayer('admin_disputed', 'boundary', ['all', ['==', ['get', 'admin_level'], 2], ['==', ['get', 'disputed'], 1], ['!=', ['get', 'maritime'], 1]], {
      'line-color': t.borderMajor,
      'line-dasharray': [1.5, 1.5],
      'line-width': expWidth(1.1, 3, 0.5, 10, 2)
    }),
    lineLayer('admin_country', 'boundary', ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'disputed'], 1], ['!=', ['get', 'maritime'], 1]], {
      'line-color': t.borderMajor,
      'line-width': expWidth(1.1, 3, 0.5, 10, 2)
    }),
    aeroLayer('aero-strip', 10, ['all', ['!', ['has', 'icao']], ['!', ['has', 'iata']]], 'airfield_11', NAME_EXPR, t),
    aeroLayer('aero-minor', 9, ['all', ['has', 'icao'], ['!', ['has', 'iata']]], 'airfield_11', ['coalesce', ['get', 'icao'], NAME_EXPR], t, 14),
    aeroLayer('aero-major', 8, ['any', ['has', 'iata'], ['has', 'icao']], 'airport_11', ['coalesce', ['get', 'iata'], ['get', 'icao'], NAME_EXPR], t),
    {
      id: 'peak-minor',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'mountain_peak',
      minzoom: 11,
      filter: PEAK_CLASS,
      layout: {
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-field': PEAK_LABEL_EXPR,
        'text-max-width': 6,
        'text-offset': [0, 0.5],
        'text-anchor': 'top'
      },
      paint: { 'text-color': t.peakText, 'text-halo-color': t.textHalo, 'text-halo-width': 2 }
    },
    {
      id: 'peak-main',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'mountain_peak',
      minzoom: 9,
      maxzoom: 11,
      filter: ['all', PEAK_CLASS, ['<=', ['coalesce', ['get', 'rank'], 1], 2]],
      layout: {
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-field': PEAK_LABEL_EXPR,
        'text-max-width': 6,
        'text-offset': [0, 0.5],
        'text-anchor': 'top'
      },
      paint: { 'text-color': t.peakText, 'text-halo-color': t.textHalo, 'text-halo-width': 2 }
    },
    {
      id: 'waterway-name',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'waterway',
      minzoom: 11,
      filter: ['all', LINE_GEOM, ['has', 'name']],
      layout: {
        'text-font': ['Noto Sans Italic'],
        'text-size': 12,
        'text-field': NAME_EXPR,
        'text-max-width': 5,
        'text-rotation-alignment': 'map',
        'symbol-placement': 'line',
        'symbol-spacing': 350
      },
      paint: { 'text-color': t.waterText, 'text-halo-color': t.waterHalo, 'text-halo-width': 1.5 }
    },
    {
      id: 'lake-label',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'water_name',
      minzoom: 9,
      filter: ['all', ['==', ['get', 'class'], 'lake'], ['has', 'name']],
      layout: {
        'text-font': ['Noto Sans Italic'],
        'text-size': 12,
        'text-field': NAME_EXPR,
        'text-max-width': 5,
        'text-rotation-alignment': 'map'
      },
      paint: { 'text-color': t.waterText, 'text-halo-color': t.waterHalo, 'text-halo-width': 1.5 }
    },
    {
      id: 'sea-ocean',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'water_name',
      minzoom: 3,
      filter: ['all', ['match', ['get', 'class'], ['ocean', 'sea', 'bay', 'gulf'], true, false], ['has', 'name']],
      layout: {
        'text-font': ['Noto Sans Italic'],
        'text-size': 13,
        'text-field': NAME_EXPR,
        'text-max-width': 6,
        'text-letter-spacing': 0.15,
        'text-rotation-alignment': 'map'
      },
      paint: { 'text-color': t.waterText, 'text-halo-color': t.waterHalo, 'text-halo-width': 1.5 }
    },
    {
      id: 'park-label',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'park',
      minzoom: 8,
      filter: ['all', POINT_GEOM, ['has', 'name']],
      layout: {
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-max-width': 6,
        'text-field': NAME_EXPR,
        'text-anchor': 'center'
      },
      paint: { 'text-color': t.poiText, 'text-halo-color': t.textHalo, 'text-halo-width': 1.5, 'text-halo-blur': 1 }
    },
    {
      id: 'poi-level-1',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'poi',
      minzoom: 14,
      filter: ['all', POINT_GEOM, ['has', 'name'], ['<=', ['coalesce', ['get', 'rank'], 20], 14]],
      layout: {
        'text-padding': 2,
        'text-font': ['Noto Sans Regular'],
        'text-anchor': 'top',
        'text-field': NAME_EXPR,
        'text-offset': [0, 0.6],
        'text-size': 11,
        'text-max-width': 9
      },
      paint: { 'text-color': t.poiText, 'text-halo-color': t.textHalo, 'text-halo-width': 1, 'text-halo-blur': 0.5 }
    },
    {
      id: 'road_major_label',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'transportation_name',
      minzoom: 11,
      filter: ['all', LINE_GEOM, MAJOR_ROAD_CLASS, ['has', 'name']],
      layout: {
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 8, 14, 11],
        'text-max-angle': 30,
        'text-transform': 'uppercase',
        'symbol-spacing': 320,
        'text-font': ['Noto Sans Regular'],
        'symbol-placement': 'line',
        'text-rotation-alignment': 'map',
        'text-letter-spacing': 0.05,
        'text-field': NAME_EXPR
      },
      paint: { 'text-color': t.poiText, 'text-halo-color': t.textHalo, 'text-halo-width': 1 }
    },
    {
      id: 'highway-shield',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'transportation_name',
      minzoom: 8,
      filter: ['all', LINE_GEOM, ['has', 'ref'], ['<=', ['get', 'ref_length'], 6], ['match', ['get', 'network'], ['us-interstate', 'us-highway', 'us-state'], false, true]],
      layout: {
        'text-size': 9,
        'icon-image': ['concat', 'road_', ['to-string', ['get', 'ref_length']]],
        'icon-rotation-alignment': 'viewport',
        'symbol-spacing': 200,
        'text-font': ['Noto Sans Regular'],
        'symbol-placement': ['step', ['zoom'], 'point', 11, 'line'],
        'text-rotation-alignment': 'viewport',
        'icon-size': 1,
        'text-field': ['to-string', ['get', 'ref']]
      },
      paint: { 'text-color': '#0d0d0d' }
    },
    {
      id: 'highway-shield-us-interstate',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'transportation_name',
      minzoom: 7,
      filter: ['all', LINE_GEOM, ['has', 'ref'], ['<=', ['get', 'ref_length'], 6], ['match', ['get', 'network'], ['us-interstate', 'us-highway', 'us-state'], true, false]],
      layout: {
        'text-size': 9,
        'icon-image': [
          'concat',
          ['get', 'network'],
          '_',
          ['to-string', ['case', ['==', ['get', 'network'], 'us-state'], ['get', 'ref_length'], ['min', ['get', 'ref_length'], 3]]]
        ],
        'icon-rotation-alignment': 'viewport',
        'symbol-spacing': 220,
        'text-font': ['Noto Sans Regular'],
        'symbol-placement': ['step', ['zoom'], 'point', 8, 'line'],
        'text-rotation-alignment': 'viewport',
        'icon-size': 1,
        'text-field': ['to-string', ['get', 'ref']]
      },
      paint: { 'text-color': '#0d0d0d' }
    },
    placeLayer('place-village', 10, ['match', ['get', 'class'], ['village', 'hamlet', 'suburb', 'Water'], true, false], {
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['exponential', 1.2], ['zoom'], 10, 11, 15, 16],
      'text-max-width': 7
    }, t),
    placeLayer('place-town', 7, ['==', ['get', 'class'], 'town'], {
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['exponential', 1.2], ['zoom'], 7, 11, 14, 18],
      'text-max-width': 8
    }, t, 15),
    placeLayer('place-city', 4, ['all', ['==', ['get', 'class'], 'city'], ['!=', ['get', 'capital'], 2]], {
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['exponential', 1.2], ['zoom'], 4, 11, 10, 16, 14, 21],
      'text-max-width': 8
    }, t, 14),
    placeLayer('place-capital', 4, ['all', ['==', ['get', 'class'], 'city'], ['==', ['get', 'capital'], 2]], {
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['exponential', 1.2], ['zoom'], 4, 12, 10, 17, 14, 22],
      'text-max-width': 8
    }, t, 14),
    placeLayer('place-state', 4, ['==', ['get', 'class'], 'state'], {
      'text-font': ['Noto Sans Italic'],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.15,
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 13],
      'text-max-width': 9
    }, t, 9),
    placeLayer('place-country', 2, ['==', ['get', 'class'], 'country'], {
      'text-font': ['Noto Sans Bold'],
      'text-transform': 'uppercase',
      'text-size': ['interpolate', ['cubic-bezier', 0.2, 0, 0.7, 1], ['zoom'], 1, ['step', ['get', 'rank'], 11, 1, 12, 2, 11], 6, ['step', ['get', 'rank'], 15, 1, 19, 2, 16]],
      'text-max-width': 6.25
    }, t, 8),
    placeLayer('place-continent', 0, ['==', ['get', 'class'], 'continent'], {
      'text-font': ['Noto Sans Bold'],
      'text-transform': 'uppercase',
      'text-size': ['interpolate', ['linear'], ['zoom'], 0, 12, 2, 15],
      'text-max-width': 6.25
    }, t, 2)
  ];
}

const THEME_PAINT_KEYS = [
  'background-color',
  'color-relief-color',
  'hillshade-shadow-color',
  'hillshade-highlight-color',
  'hillshade-accent-color',
  'hillshade-exaggeration',
  'fill-color',
  'line-color',
  'text-color',
  'text-halo-color'
] as const;

/** Builds the MapLibre style specification for a soaring theme over DEM terrain and OpenFreeMap vectors. */
export function compositeBasemapStyle(theme: MapTheme = 'stone'): StyleSpecification {
  const t = tokensFor(theme);
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sprite: SPRITE_URL,
    sources: {
      'terrain-dem': {
        type: 'raster-dem',
        tiles: DEM_TILES,
        tileSize: 256,
        maxzoom: DEM_MAX_ZOOM,
        encoding: 'terrarium',
        attribution: '© <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen / AWS Terrain</a>'
      },
      [VECTOR_SOURCE_ID]: {
        type: 'vector',
        url: VECTOR_TILEJSON_URL
      }
    },
    layers: [...terrainLayers(t), ...buildOverlayLayers(t)]
  };
}

/** Updates terrain, hillshade, water, road, border, and label paint properties in place for `theme`. */
export function applyBasemapTheme(
  map: {
    getLayer(id: string): unknown;
    setPaintProperty(layerId: string, name: string, value: unknown): void;
  } | null | undefined,
  theme: MapTheme
): void {
  if (!map) return;
  const t = tokensFor(theme);
  for (const layer of [...terrainLayers(t), ...buildOverlayLayers(t)]) {
    if (!map.getLayer(layer.id) || !('paint' in layer) || !layer.paint) continue;
    const paint = layer.paint as Record<string, unknown>;
    for (const key of THEME_PAINT_KEYS) {
      if (key in paint) map.setPaintProperty(layer.id, key, paint[key]);
    }
  }
}
