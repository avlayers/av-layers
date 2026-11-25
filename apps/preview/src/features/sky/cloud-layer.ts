import type { Map as MapLibreMap } from 'maplibre-gl';
import { clampOpacity, previewRasterLayer } from '@av/client';
import type { ResolvedChannelStyles } from '../map/channel-styles';
import type { CloudStyleId } from '../../themes/theme';
import { contourLines, type GeoPt } from './contours';
import {
  cloudRasterBeforeId,
  isBitmapPendingOnImageSource,
  OwnedImageBitmapRetirer,
  weatherContourBeforeId
} from './sky-layer-order';
import type { SynopticField } from './synoptic-sampler';
import { invMercY, mercY } from './mercator';

type Coordinates = [[number, number], [number, number], [number, number], [number, number]];
interface ImageSourceLike {
  updateImage?: (options: { image: ImageBitmap; coordinates: Coordinates }) => void;
}
interface GeoJsonSourceLike {
  setData?: (data: unknown) => void;
}

const CLOUD_SOURCE_ID = 'av-sky-clouds';
const CLOUD_CONTOUR_SOURCE_ID = 'av-cloud-contours';
const CLOUD_CONTOUR_HALO_ID = 'av-cloud-contours-halo';
const CLOUD_CONTOUR_BROKEN_ID = 'av-cloud-contours-broken';
const CLOUD_CONTOUR_OVERCAST_ID = 'av-cloud-contours-overcast';

const CLOUD_CANVAS_W = 352;
const CLOUD_CANVAS_H = 256;
const CONTOUR_GRID_W = 56;
const CONTOUR_GRID_H = 40;
const MAX_BITMAP_CACHE = 48;
const MAX_CONTOUR_CACHE = 64;
const DEG = Math.PI / 180;

const NOISE_SIZE = 256;
const NOISE_MASK = NOISE_SIZE - 1;
let fbmLut: Float32Array | null = null;

function intHash2(x: number, y: number): number {
  let h = (Math.imul(x & 255, 374761393) + Math.imul(y & 255, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) * (1 / 4294967296);
}

function periodicNoise(px: number, py: number, period: number): number {
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const fx = px - x0, fy = py - y0;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const ix0 = ((x0 % period) + period) % period;
  const iy0 = ((y0 % period) + period) % period;
  const ix1 = (ix0 + 1) % period;
  const iy1 = (iy0 + 1) % period;
  const a = intHash2(ix0, iy0), b = intHash2(ix1, iy0);
  const c = intHash2(ix0, iy1), d = intHash2(ix1, iy1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function getBillowLut(): Float32Array {
  if (fbmLut) return fbmLut;
  const lut = new Float32Array(NOISE_SIZE * NOISE_SIZE);
  for (let y = 0; y < NOISE_SIZE; y++) {
    const ny = y / NOISE_SIZE;
    for (let x = 0; x < NOISE_SIZE; x++) {
      const nx = x / NOISE_SIZE;
      const n1 = periodicNoise(nx * 10, ny * 10, 10);
      const n2 = periodicNoise(nx * 20 + 3.7, ny * 20 + 6.1, 20);
      const n3 = periodicNoise(nx * 40 + 9.2, ny * 40 + 1.9, 40);
      const raw = 0.56 * n1 + 0.30 * n2 + 0.14 * n3;
      lut[y * NOISE_SIZE + x] = Math.min(1, Math.max(0, raw));
    }
  }
  fbmLut = lut;
  return lut;
}

function sampleBillowBilinear(lut: Float32Array, fx: number, fy: number): number {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const ix0 = x0 & NOISE_MASK, iy0 = y0 & NOISE_MASK;
  const ix1 = (ix0 + 1) & NOISE_MASK, iy1 = (iy0 + 1) & NOISE_MASK;
  const a = lut[(iy0 << 8) | ix0]!, b = lut[(iy0 << 8) | ix1]!;
  const c = lut[(iy1 << 8) | ix0]!, d = lut[(iy1 << 8) | ix1]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function sampleGridSmooth(grid: Float32Array, cols: number, rows: number, u: number, v: number): number {
  const gx = Math.max(0, Math.min(cols - 1, u * (cols - 1)));
  const gy = Math.max(0, Math.min(rows - 1, v * (rows - 1)));
  const x0 = gx | 0, y0 = gy | 0;
  const x1 = x0 + 1 < cols ? x0 + 1 : x0;
  const y1 = y0 + 1 < rows ? y0 + 1 : y0;
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const v00 = grid[y0 * cols + x0]!, v10 = grid[y0 * cols + x1]!;
  const v01 = grid[y1 * cols + x0]!, v11 = grid[y1 * cols + x1]!;
  if (Number.isFinite(v00) && Number.isFinite(v10) && Number.isFinite(v01) && Number.isFinite(v11)) {
    return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
  }
  const w00 = (1 - sx) * (1 - sy), w10 = sx * (1 - sy), w01 = (1 - sx) * sy, w11 = sx * sy;
  let sum = 0, wSum = 0;
  if (Number.isFinite(v00)) { sum += v00 * w00; wSum += w00; }
  if (Number.isFinite(v10)) { sum += v10 * w10; wSum += w10; }
  if (Number.isFinite(v01)) { sum += v01 * w01; wSum += w01; }
  if (Number.isFinite(v11)) { sum += v11 * w11; wSum += w11; }
  return wSum > 0 ? sum / wSum : Number.NaN;
}

/** Encodes low boundary-layer cloud cover and upper cirrus into an RGBA viewport buffer. */
export function renderSmoothCloudRgba(
  field: SynopticField,
  style: CloudStyleId,
  darkChrome: boolean,
  outData: Uint8ClampedArray,
  w: number,
  h: number
): void {
  const lut = getBillowLut();
  const yNorth = mercY(field.north), ySouth = mercY(field.south);
  const invSpanLat = 1 / Math.max(1e-5, field.north - field.south);
  const spanLon = Math.max(0.04, field.east - field.west);
  const freq = Math.max(2.2, Math.min(48, 22 / Math.sqrt(spanLon)));

  for (let py = 0; py < h; py++) {
    const my = yNorth - (py / (h - 1)) * (yNorth - ySouth);
    const lat = invMercY(my);
    const v = (field.north - lat) * invSpanLat;
    const nfy = lat * freq;
    const cosLat = Math.max(0.35, Math.cos(lat * DEG));

    for (let px = 0; px < w; px++) {
      const off = (py * w + px) * 4;
      const u = px / (w - 1);
      const tot = sampleGridSmooth(field.total, field.cols, field.rows, u, v);
      const lo = sampleGridSmooth(field.low, field.cols, field.rows, u, v);
      if (!Number.isFinite(tot) || !Number.isFinite(lo)) {
        outData[off + 3] = 0;
        continue;
      }
      const highOnly = Math.max(0, tot - lo);
      // Soaring-weighted optical depth for BL modes; satellite-ir weights upper cold decks directly.
      const opticalCover = style === 'satellite-ir'
        ? Math.min(1, lo * 0.88 + highOnly * 0.92)
        : Math.min(1, lo + highOnly * 0.42);

      if (opticalCover <= 0.12 && tot <= 0.18) {
        outData[off + 3] = 0;
        continue;
      }

      const lon = field.west + u * spanLon;
      const nfx = lon * freq * cosLat;
      const billow = sampleBillowBilinear(lut, nfx, nfy);
      const billowNW = sampleBillowBilinear(lut, nfx - 0.55, nfy + 0.55);
      const sunRelief = Math.max(-1, Math.min(1, (billow - billowNW) * 2.8));

      const puffMask = Math.max(
        0,
        Math.min(1, (opticalCover - 0.11) * 1.30 + (billow - 0.47) * 0.28 * (1 - opticalCover * 0.45))
      );
      if (puffMask <= 0.02) {
        outData[off + 3] = 0;
        continue;
      }

      if (style === 'nephanalysis') {
        const lum = darkChrome ? 212 : 54;
        outData[off] = lum;
        outData[off + 1] = lum + 4;
        outData[off + 2] = lum + 10;
        outData[off + 3] = Math.round(Math.max(0, opticalCover - 0.22) * (darkChrome ? 62 : 52));
        continue;
      }

      if (style === 'satellite-ir') {
        const upperShare = tot > 0.05 ? Math.min(1, highOnly / Math.max(0.20, tot * 0.75)) : 0;
        const warmBase = 136 + 24 * billow + 12 * sunRelief;
        const coldTop = 224 + 20 * billow + 10 * sunRelief;
        const lum = Math.min(252, Math.max(124, Math.round(warmBase * (1 - upperShare) + coldTop * upperShare)));
        const coolTint = Math.round(3 + 3 * upperShare);
        outData[off] = Math.max(0, lum - coolTint);
        outData[off + 1] = lum;
        outData[off + 2] = Math.min(255, lum + coolTint + 1);
        const alphaCap = lo < 0.22 ? 80 : 136;
        outData[off + 3] = Math.min(alphaCap, Math.round(Math.pow(puffMask, 0.88) * (lo < 0.22 ? 86 : 134)));
        continue;
      }

      const lowOvercast = Math.max(0, (lo - 0.56) / 0.34);
      const deepMultiLayer = Math.max(0, (opticalCover - 0.70) / 0.28) * (lo > 0.28 ? 1 : 0.35);
      const overcastBlend = Math.min(1, Math.max(lowOvercast, deepMultiLayer));

      const cuLit = 245 + 10 * sunRelief;
      const odShade = 66 + 32 * billow + 13 * sunRelief;
      const lum = Math.round(cuLit * (1 - overcastBlend) + odShade * overcastBlend);
      outData[off] = lum;
      outData[off + 1] = Math.min(255, lum + 2);
      outData[off + 2] = Math.min(255, lum + 5);

      const cirrusCap = lo < 0.20 ? 54 : 134;
      const baseAlpha = puffMask * (68 + 64 * overcastBlend);
      outData[off + 3] = Math.min(cirrusCap, Math.round(baseAlpha));
    }
  }
}

type CloudContourGeoJson = {
  readonly type: 'FeatureCollection';
  readonly features: Array<{
    readonly type: 'Feature';
    readonly properties: { readonly tier: 'broken' | 'overcast' };
    readonly geometry: { readonly type: 'LineString'; readonly coordinates: GeoPt[] };
  }>;
};

export function buildCloudContourGeoJson(field: SynopticField, style: CloudStyleId): CloudContourGeoJson {
  const features: CloudContourGeoJson['features'] = [];

  if (!field.hasClouds) return { type: 'FeatureCollection' as const, features };

  const grid = new Float32Array(CONTOUR_GRID_W * CONTOUR_GRID_H);
  const yNorth = mercY(field.north), ySouth = mercY(field.south);
  const invSpanLat = 1 / Math.max(1e-5, field.north - field.south);

  let maxCover = 0;
  for (let y = 0; y < CONTOUR_GRID_H; y++) {
    const my = yNorth - (y / (CONTOUR_GRID_H - 1)) * (yNorth - ySouth);
    const lat = invMercY(my);
    const v = (field.north - lat) * invSpanLat;
    for (let x = 0; x < CONTOUR_GRID_W; x++) {
      const u = x / (CONTOUR_GRID_W - 1);
      const tot = sampleGridSmooth(field.total, field.cols, field.rows, u, v);
      const lo = sampleGridSmooth(field.low, field.cols, field.rows, u, v);
      if (!Number.isFinite(tot) || !Number.isFinite(lo)) {
        grid[y * CONTOUR_GRID_W + x] = Number.NaN;
        continue;
      }
      const c = style === 'satellite-ir'
        ? Math.min(1, Math.max(lo, tot * 0.88))
        : Math.min(1, Math.max(lo, lo + Math.max(0, tot - lo) * 0.55));
      grid[y * CONTOUR_GRID_W + x] = c;
      if (c > maxCover) maxCover = c;
    }
  }

  const toGeo = (gx: number, gy: number): GeoPt => {
    const lon = field.west + (gx / (CONTOUR_GRID_W - 1)) * (field.east - field.west);
    const my = yNorth - (gy / (CONTOUR_GRID_H - 1)) * (yNorth - ySouth);
    return [lon, invMercY(my)];
  };

  const levels: Array<{ tier: 'broken' | 'overcast'; threshold: number }> = style === 'nephanalysis'
    ? [{ tier: 'broken', threshold: 0.42 }, { tier: 'overcast', threshold: 0.72 }]
    : [{ tier: 'overcast', threshold: 0.74 }];

  for (const { tier, threshold } of levels) {
    if (maxCover < threshold) continue;
    for (const coordinates of contourLines(grid, CONTOUR_GRID_W, CONTOUR_GRID_H, threshold, toGeo, { minVertices: 4 })) {
      features.push({
        type: 'Feature',
        properties: { tier },
        geometry: { type: 'LineString', coordinates }
      });
    }
  }
  return { type: 'FeatureCollection' as const, features };
}

/**
 * Dedicated Cloud Cover renderer combining smooth zoom-adaptive billowy cloud/shadow bitmaps
 * with razor-sharp WebGL vector nephanalysis/overcast contours placed strictly below map labels.
 */
export class CloudLayerController {
  private readonly canvas: OffscreenCanvas | null;
  private readonly bitmaps = new Map<string, { bitmap: ImageBitmap; coordinates: Coordinates }>();
  private readonly contours = new Map<string, CloudContourGeoJson>();
  private readonly evictedBitmaps = new OwnedImageBitmapRetirer();
  private shownBitmap: ImageBitmap | null = null;
  private shownBitmapKey = '';
  private shownContourKey = '';
  private lastStyleKey = '';

  constructor(private readonly map: MapLibreMap, supported: boolean) {
    this.canvas = supported ? new OffscreenCanvas(CLOUD_CANVAS_W, CLOUD_CANVAS_H) : null;
  }

  paint(field: SynopticField, styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    if (!this.canvas || !field.hasClouds) {
      this.syncVisibilityAndStyle(styles, opacity, false);
      return;
    }
    const bmpKey = `${field.id}:${styles.cloudStyle}:${styles.darkChrome ? 'd' : 'l'}`;
    let entry = this.bitmaps.get(bmpKey);
    if (entry) {
      this.bitmaps.delete(bmpKey);
      this.bitmaps.set(bmpKey, entry);
    } else {
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      const img = ctx.createImageData(CLOUD_CANVAS_W, CLOUD_CANVAS_H);
      renderSmoothCloudRgba(field, styles.cloudStyle, styles.darkChrome, img.data, CLOUD_CANVAS_W, CLOUD_CANVAS_H);
      ctx.putImageData(img, 0, 0);
      let bitmap: ImageBitmap;
      try { bitmap = this.canvas.transferToImageBitmap(); }
      catch { return; }
      const coordinates: Coordinates = [
        [field.west, field.north],
        [field.east, field.north],
        [field.east, field.south],
        [field.west, field.south]
      ];
      if (this.bitmaps.size >= MAX_BITMAP_CACHE) {
        for (const [oldKey, oldVal] of this.bitmaps) {
          if (oldVal.bitmap === this.shownBitmap) continue;
          this.bitmaps.delete(oldKey);
          if (isBitmapPendingOnImageSource(this.map, CLOUD_SOURCE_ID, oldVal.bitmap)) {
            this.evictedBitmaps.present(this.map, CLOUD_SOURCE_ID, oldVal.bitmap);
          } else {
            oldVal.bitmap.close();
          }
          break;
        }
      }
      entry = { bitmap, coordinates };
      this.bitmaps.set(bmpKey, entry);
    }

    const existing = this.map.getSource(CLOUD_SOURCE_ID) as ImageSourceLike | undefined;
    if (!existing) {
      this.shownBitmapKey = '';
      this.lastStyleKey = '';
      this.map.addSource(CLOUD_SOURCE_ID, { type: 'image', coordinates: entry.coordinates });
      const layer = previewRasterLayer(this.effectiveOpacity(opacity, visible));
      this.map.addLayer(
        { ...layer, id: CLOUD_SOURCE_ID, source: CLOUD_SOURCE_ID, paint: { ...layer.paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } },
        cloudRasterBeforeId(this.map)
      );
    }
    if (this.shownBitmapKey !== bmpKey) {
      (this.map.getSource(CLOUD_SOURCE_ID) as ImageSourceLike | undefined)?.updateImage?.({
        image: entry.bitmap,
        coordinates: entry.coordinates
      });
      this.shownBitmap = entry.bitmap;
      this.shownBitmapKey = bmpKey;
      this.evictedBitmaps.flushUploaded(this.map, CLOUD_SOURCE_ID);
    }

    this.paintContours(field, styles, visible);
    this.syncVisibilityAndStyle(styles, opacity, visible);
  }

  syncVisibilityAndStyle(styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    const effOpacity = this.effectiveOpacity(opacity, visible);
    const cc = styles.cloudContours;
    const isNeph = styles.cloudStyle === 'nephanalysis';
    const hasRaster = Boolean(this.map.getLayer(CLOUD_SOURCE_ID));
    const hasContours = Boolean(this.map.getLayer(CLOUD_CONTOUR_HALO_ID));
    const sig = `${hasRaster}:${hasContours}:${visible}:${effOpacity.toFixed(3)}:${isNeph}:${cc.haloColor}:${cc.brokenColor}:${cc.overcastColor}`;
    if (sig === this.lastStyleKey) return;
    this.lastStyleKey = sig;

    if (hasRaster) {
      this.map.setPaintProperty(CLOUD_SOURCE_ID, 'raster-opacity', effOpacity);
    }
    const vis = visible ? 'visible' : 'none';
    for (const id of [CLOUD_CONTOUR_HALO_ID, CLOUD_CONTOUR_BROKEN_ID, CLOUD_CONTOUR_OVERCAST_ID]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }
    if (hasContours) {
      this.map.setPaintProperty(CLOUD_CONTOUR_HALO_ID, 'line-color', cc.haloColor);
      this.map.setPaintProperty(CLOUD_CONTOUR_HALO_ID, 'line-opacity', isNeph ? 0.80 : 0.58);
    }
    if (this.map.getLayer(CLOUD_CONTOUR_BROKEN_ID)) {
      this.map.setPaintProperty(CLOUD_CONTOUR_BROKEN_ID, 'line-color', cc.brokenColor);
    }
    if (this.map.getLayer(CLOUD_CONTOUR_OVERCAST_ID)) {
      this.map.setPaintProperty(CLOUD_CONTOUR_OVERCAST_ID, 'line-color', cc.overcastColor);
      this.map.setPaintProperty(CLOUD_CONTOUR_OVERCAST_ID, 'line-opacity', isNeph ? 0.94 : 0.66);
    }
  }

  clear(): void {
    if (typeof this.map.getLayer === 'function') {
      for (const id of [CLOUD_CONTOUR_OVERCAST_ID, CLOUD_CONTOUR_BROKEN_ID, CLOUD_CONTOUR_HALO_ID, CLOUD_SOURCE_ID]) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      }
    }
    if (typeof this.map.getSource === 'function') {
      for (const src of [CLOUD_CONTOUR_SOURCE_ID, CLOUD_SOURCE_ID]) {
        if (this.map.getSource(src)) this.map.removeSource(src);
      }
    }
    this.shownBitmap = null;
    this.shownBitmapKey = '';
    this.shownContourKey = '';
    this.lastStyleKey = '';
    this.evictedBitmaps.releaseAllAfterSourceRemoved();
    for (const item of this.bitmaps.values()) item.bitmap.close();
    this.bitmaps.clear();
    this.contours.clear();
  }

  private effectiveOpacity(opacity: number, visible: boolean): number {
    if (!visible) return 0;
    return clampOpacity(0.56 + opacity * 0.44);
  }

  private paintContours(field: SynopticField, styles: ResolvedChannelStyles, visible: boolean): void {
    const contourKey = `${field.id}:${styles.cloudStyle}`;
    let geo = this.contours.get(contourKey);
    if (geo) {
      this.contours.delete(contourKey);
      this.contours.set(contourKey, geo);
    } else {
      geo = buildCloudContourGeoJson(field, styles.cloudStyle);
      if (this.contours.size >= MAX_CONTOUR_CACHE) {
        const oldest = this.contours.keys().next().value;
        if (oldest !== undefined) this.contours.delete(oldest);
      }
      this.contours.set(contourKey, geo);
    }

    const src = this.map.getSource(CLOUD_CONTOUR_SOURCE_ID) as GeoJsonSourceLike | undefined;
    if (src?.setData) {
      if (this.shownContourKey !== contourKey) {
        src.setData(geo);
        this.shownContourKey = contourKey;
      }
      return;
    }

    const cc = styles.cloudContours;
    const vis = visible ? 'visible' : 'none';
    const beforeId = weatherContourBeforeId(this.map);
    this.lastStyleKey = '';
    this.shownContourKey = contourKey;

    this.map.addSource(CLOUD_CONTOUR_SOURCE_ID, { type: 'geojson', data: geo });
    this.map.addLayer({
      id: CLOUD_CONTOUR_HALO_ID,
      type: 'line',
      source: CLOUD_CONTOUR_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': cc.haloColor,
        'line-width': ['case', ['==', ['get', 'tier'], 'overcast'], 2.8, 2.0],
        'line-opacity': 0.65
      }
    }, beforeId);
    this.map.addLayer({
      id: CLOUD_CONTOUR_BROKEN_ID,
      type: 'line',
      source: CLOUD_CONTOUR_SOURCE_ID,
      filter: ['==', ['get', 'tier'], 'broken'],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': cc.brokenColor,
        'line-width': 1.05,
        'line-dasharray': [3, 2.5]
      }
    }, beforeId);
    this.map.addLayer({
      id: CLOUD_CONTOUR_OVERCAST_ID,
      type: 'line',
      source: CLOUD_CONTOUR_SOURCE_ID,
      filter: ['==', ['get', 'tier'], 'overcast'],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': cc.overcastColor,
        'line-width': 1.35,
        'line-dasharray': [5, 2]
      }
    }, beforeId);
  }
}
