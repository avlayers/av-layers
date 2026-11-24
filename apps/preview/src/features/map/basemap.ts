import type { ExpressionSpecification, FilterSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { WEATHER_CEILING_ID } from '@av/client';
import { DEFAULT_THEME, themeOption, type MapTheme } from '../../themes/registry';
import type { BasemapTokens } from '../../themes/theme';
import type { ChannelView, MapChannel } from '../../channels/channel';

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
  t: BasemapTokens,
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
  t: BasemapTokens,
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

function terrainLayers(t: BasemapTokens): LayerSpecification[] {
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

function buildOverlayLayers(t: BasemapTokens): LayerSpecification[] {
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
export function compositeBasemapStyle(theme: MapTheme = DEFAULT_THEME): StyleSpecification {
  const t = themeOption(theme).basemap;
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
  const t = themeOption(theme).basemap;
  for (const layer of [...terrainLayers(t), ...buildOverlayLayers(t)]) {
    if (!map.getLayer(layer.id) || !('paint' in layer) || !layer.paint) continue;
    const paint = layer.paint as Record<string, unknown>;
    for (const key of THEME_PAINT_KEYS) {
      if (key in paint) map.setPaintProperty(layer.id, key, paint[key]);
    }
  }
}

type PaintableMap = Parameters<typeof applyBasemapTheme>[0];

/** The basemap as a map channel: repaints relief, hillshade and vector layers when the theme changes. */
export class BasemapChannel implements MapChannel {
  constructor(private readonly map: PaintableMap, private theme: MapTheme) {}

  update(view: ChannelView): void {
    if (view.theme === this.theme) return;
    this.theme = view.theme;
    applyBasemapTheme(this.map, view.theme);
  }

  clear(): void {}
  destroy(): void {}
}
