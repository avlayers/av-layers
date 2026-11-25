import type { Map as MapLibreMap } from 'maplibre-gl';
import { clampOpacity } from '@av/client';
import { rainContourStrokePair, type ResolvedChannelStyles } from '../map/channel-styles';
import type { PrecipField } from './precip-field';
import { buildRainContourGeoJson, type RainContourGeoJson } from './rain-contours';
import { weatherContourBeforeId } from './sky-layer-order';

interface GeoJsonSourceLike {
  setData?: (data: unknown) => void;
}

const RAIN_CONTOUR_SOURCE_ID = 'av-rain-contours';
const RAIN_CONTOUR_HALO_ID = 'av-rain-contours-halo';
const RAIN_CONTOUR_SHOWER_ID = 'av-rain-contours-shower';
const RAIN_CONTOUR_SQUALL_ID = 'av-rain-contours-squall';
const MAX_RAIN_CONTOUR_CACHE = 64;

/** Owns the `av-rain-contours` GeoJSON source and its halo, shower and squall line layers below text labels. */
export class RainContourLayer {
  private readonly cache = new Map<string, RainContourGeoJson>();
  private shownKey = '';
  private lastStyleSig = '';

  constructor(private readonly map: MapLibreMap) {}

  paint(field: PrecipField, styles: ResolvedChannelStyles, visible: boolean): void {
    const contourKey = field.key;

    let geo = this.cache.get(contourKey);
    if (geo) {
      this.cache.delete(contourKey);
      this.cache.set(contourKey, geo);
    } else {
      geo = buildRainContourGeoJson(field);
      if (this.cache.size >= MAX_RAIN_CONTOUR_CACHE) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(contourKey, geo);
    }

    const src = this.map.getSource(RAIN_CONTOUR_SOURCE_ID) as GeoJsonSourceLike | undefined;
    if (src?.setData) {
      if (this.shownKey !== contourKey) {
        src.setData(geo);
        this.shownKey = contourKey;
      }
      return;
    }

    const re = styles.rainEdge;
    const { haloColor, showerColor } = rainContourStrokePair(styles);
    const vis = visible ? 'visible' : 'none';
    const beforeId = weatherContourBeforeId(this.map);
    this.lastStyleSig = '';
    this.shownKey = contourKey;

    this.map.addSource(RAIN_CONTOUR_SOURCE_ID, { type: 'geojson', data: geo });
    this.map.addLayer({
      id: RAIN_CONTOUR_HALO_ID,
      type: 'line',
      source: RAIN_CONTOUR_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': haloColor,
        'line-width': ['case', ['==', ['get', 'tier'], 'squall'], 4.4, 4.2],
        'line-blur': 0.65,
        'line-opacity': 0.94
      }
    }, beforeId);
    this.map.addLayer({
      id: RAIN_CONTOUR_SHOWER_ID,
      type: 'line',
      source: RAIN_CONTOUR_SOURCE_ID,
      filter: ['==', ['get', 'tier'], 'shower'],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': showerColor,
        'line-width': 2.1
      }
    }, beforeId);
    this.map.addLayer({
      id: RAIN_CONTOUR_SQUALL_ID,
      type: 'line',
      source: RAIN_CONTOUR_SOURCE_ID,
      filter: ['==', ['get', 'tier'], 'squall'],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': re.coreStrokeColor,
        'line-width': 2.0
      }
    }, beforeId);
  }

  syncStyle(styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    const hasHaloLayer = Boolean(this.map.getLayer(RAIN_CONTOUR_HALO_ID));
    const re = styles.rainEdge;
    const { haloColor, showerColor } = rainContourStrokePair(styles);
    const alphaScale = clampOpacity(0.66 + opacity * 0.34);

    const sig = `${hasHaloLayer}:${visible}:${alphaScale.toFixed(3)}:${haloColor}:${showerColor}:${re.coreStrokeColor}`;
    if (sig === this.lastStyleSig) return;
    this.lastStyleSig = sig;

    const vis = visible ? 'visible' : 'none';
    for (const id of [RAIN_CONTOUR_HALO_ID, RAIN_CONTOUR_SHOWER_ID, RAIN_CONTOUR_SQUALL_ID]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }

    if (hasHaloLayer) {
      this.map.setPaintProperty(RAIN_CONTOUR_HALO_ID, 'line-color', haloColor);
      this.map.setPaintProperty(RAIN_CONTOUR_HALO_ID, 'line-opacity', 0.94 * alphaScale);
    }
    if (this.map.getLayer(RAIN_CONTOUR_SHOWER_ID)) {
      this.map.setPaintProperty(RAIN_CONTOUR_SHOWER_ID, 'line-color', showerColor);
      this.map.setPaintProperty(RAIN_CONTOUR_SHOWER_ID, 'line-opacity', 0.96 * alphaScale);
    }
    if (this.map.getLayer(RAIN_CONTOUR_SQUALL_ID)) {
      this.map.setPaintProperty(RAIN_CONTOUR_SQUALL_ID, 'line-color', re.coreStrokeColor);
      this.map.setPaintProperty(RAIN_CONTOUR_SQUALL_ID, 'line-opacity', 0.98 * alphaScale);
    }
  }

  /** Removes the line layers and source and drops cached GeoJSON. */
  clear(): void {
    this.shownKey = '';
    this.lastStyleSig = '';
    if (typeof this.map.getLayer === 'function') {
      for (const id of [RAIN_CONTOUR_SQUALL_ID, RAIN_CONTOUR_SHOWER_ID, RAIN_CONTOUR_HALO_ID]) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      }
    }
    if (typeof this.map.getSource === 'function' && this.map.getSource(RAIN_CONTOUR_SOURCE_ID)) {
      this.map.removeSource(RAIN_CONTOUR_SOURCE_ID);
    }
    this.cache.clear();
  }
}
