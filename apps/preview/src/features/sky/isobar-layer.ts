import type { Map as MapLibreMap } from 'maplibre-gl';
import type { IsobarThemeTokens } from '../../themes/theme';
import { buildIsobarGeoJson, type IsobarGeoJson } from './isobars';
import { isobarLabelBeforeId, weatherContourBeforeId } from './sky-layer-order';
import type { SynopticField } from './synoptic-sampler';

interface GeoJsonSourceLike {
  setData?: (data: unknown) => void;
}

const ISOBAR_LINE_SOURCE_ID = 'av-isobars-lines';
const ISOBAR_CENTER_SOURCE_ID = 'av-isobars-centers';
const ISOBAR_HALO_ID = 'av-isobars-halo';
const ISOBAR_LINE_ID = 'av-isobars-line';
const ISOBAR_LABEL_ID = 'av-isobars-label';
const ISOBAR_CENTER_ID = 'av-isobars-hl';
const MAX_ISOBAR_CACHE = 64;

/**
 * Dedicated Sea-Level Pressure Isobar (`mslp-hpa`) vector layer controller.
 * Isobar lines sit cleanly below place/peak/airport text labels, while inline pressure numbers
 * and H/L centers participate in symbol collision avoidance so town names stay crisp.
 */
export class IsobarLayerController {
  private readonly geoCache = new Map<string, IsobarGeoJson>();
  private shownGeoKey = '';
  private lastStyleKey = '';

  constructor(private readonly map: MapLibreMap) {}

  paint(field: SynopticField, iso: IsobarThemeTokens, visible: boolean): void {
    if (!field.hasMslp) return;
    const zoom = this.map.getZoom();
    const minorStep = zoom < 4.3 ? 4 : 2;
    const geoKey = `${field.id}:${minorStep}`;
    let geo = this.geoCache.get(geoKey);
    if (geo) {
      this.geoCache.delete(geoKey);
      this.geoCache.set(geoKey, geo);
    } else {
      geo = buildIsobarGeoJson(field.mslp, field.cols, field.rows, field, zoom);
      if (this.geoCache.size >= MAX_ISOBAR_CACHE) {
        const oldest = this.geoCache.keys().next().value;
        if (oldest !== undefined) this.geoCache.delete(oldest);
      }
      this.geoCache.set(geoKey, geo);
    }

    const vis = visible ? 'visible' : 'none';
    const lineBeforeId = weatherContourBeforeId(this.map);
    const labelBeforeId = isobarLabelBeforeId(this.map);

    const lineSrc = this.map.getSource(ISOBAR_LINE_SOURCE_ID) as GeoJsonSourceLike | undefined;
    const centerSrc = this.map.getSource(ISOBAR_CENTER_SOURCE_ID) as GeoJsonSourceLike | undefined;

    if (lineSrc?.setData && centerSrc?.setData) {
      if (this.shownGeoKey !== geoKey) {
        lineSrc.setData(geo.lines);
        centerSrc.setData(geo.centers);
        this.shownGeoKey = geoKey;
      }
      this.syncStyleAndVisibility(iso, visible);
      return;
    }

    this.lastStyleKey = '';
    this.shownGeoKey = geoKey;

    if (lineSrc?.setData) {
      lineSrc.setData(geo.lines);
    } else {
      this.map.addSource(ISOBAR_LINE_SOURCE_ID, { type: 'geojson', data: geo.lines });
      this.map.addLayer({
        id: ISOBAR_HALO_ID,
        type: 'line',
        source: ISOBAR_LINE_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
        paint: {
          'line-color': iso.haloColor,
          'line-width': ['case', ['get', 'major'], 3.8, 2.5],
          'line-opacity': 0.84
        }
      }, lineBeforeId);
      this.map.addLayer({
        id: ISOBAR_LINE_ID,
        type: 'line',
        source: ISOBAR_LINE_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
        paint: {
          'line-color': ['case', ['get', 'major'], iso.majorColor, iso.minorColor],
          'line-width': ['case', ['get', 'major'], 1.7, 1.0]
        }
      }, lineBeforeId);
      this.map.addLayer({
        id: ISOBAR_LABEL_ID,
        type: 'symbol',
        source: ISOBAR_LINE_SOURCE_ID,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 360,
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['case', ['get', 'major'], 10.5, 9.5],
          'text-keep-upright': true,
          'text-allow-overlap': false,
          'text-padding': 4,
          visibility: vis
        },
        paint: {
          'text-color': iso.textColor,
          'text-halo-color': iso.haloColor,
          'text-halo-width': 2.3
        }
      }, labelBeforeId);
    }

    if (centerSrc?.setData) {
      centerSrc.setData(geo.centers);
    } else {
      this.map.addSource(ISOBAR_CENTER_SOURCE_ID, { type: 'geojson', data: geo.centers });
      this.map.addLayer({
        id: ISOBAR_CENTER_ID,
        type: 'symbol',
        source: ISOBAR_CENTER_SOURCE_ID,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 13,
          'text-line-height': 1.05,
          'text-allow-overlap': false,
          'text-padding': 3,
          visibility: vis
        },
        paint: {
          'text-color': ['case', ['==', ['get', 'kind'], 'H'], iso.highColor, iso.lowColor],
          'text-halo-color': iso.haloColor,
          'text-halo-width': 2.8
        }
      }, labelBeforeId);
    }
    this.syncStyleAndVisibility(iso, visible);
  }

  syncStyleAndVisibility(iso: IsobarThemeTokens, visible: boolean): void {
    const hasHalo = Boolean(this.map.getLayer(ISOBAR_HALO_ID));
    const hasCenter = Boolean(this.map.getLayer(ISOBAR_CENTER_ID));
    const sig = `${hasHalo}:${hasCenter}:${visible}:${iso.haloColor}:${iso.majorColor}:${iso.minorColor}:${iso.textColor}:${iso.highColor}:${iso.lowColor}`;
    if (sig === this.lastStyleKey) return;
    this.lastStyleKey = sig;

    const vis = visible ? 'visible' : 'none';
    for (const id of [ISOBAR_HALO_ID, ISOBAR_LINE_ID, ISOBAR_LABEL_ID, ISOBAR_CENTER_ID]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }
    if (hasHalo) {
      this.map.setPaintProperty(ISOBAR_HALO_ID, 'line-color', iso.haloColor);
    }
    if (this.map.getLayer(ISOBAR_LINE_ID)) {
      this.map.setPaintProperty(ISOBAR_LINE_ID, 'line-color', ['case', ['get', 'major'], iso.majorColor, iso.minorColor]);
    }
    if (this.map.getLayer(ISOBAR_LABEL_ID)) {
      this.map.setPaintProperty(ISOBAR_LABEL_ID, 'text-color', iso.textColor);
      this.map.setPaintProperty(ISOBAR_LABEL_ID, 'text-halo-color', iso.haloColor);
    }
    if (hasCenter) {
      this.map.setPaintProperty(ISOBAR_CENTER_ID, 'text-color', ['case', ['==', ['get', 'kind'], 'H'], iso.highColor, iso.lowColor]);
      this.map.setPaintProperty(ISOBAR_CENTER_ID, 'text-halo-color', iso.haloColor);
    }
  }

  clear(): void {
    if (typeof this.map.getLayer === 'function') {
      for (const id of [ISOBAR_CENTER_ID, ISOBAR_LABEL_ID, ISOBAR_LINE_ID, ISOBAR_HALO_ID]) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      }
    }
    if (typeof this.map.getSource === 'function') {
      for (const src of [ISOBAR_CENTER_SOURCE_ID, ISOBAR_LINE_SOURCE_ID]) {
        if (this.map.getSource(src)) this.map.removeSource(src);
      }
    }
    this.shownGeoKey = '';
    this.lastStyleKey = '';
    this.geoCache.clear();
  }
}
