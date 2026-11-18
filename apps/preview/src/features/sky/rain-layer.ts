import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  clampOpacity, createSourceRasterTileProtocol, frameTileUrl, layerMaxZoom, previewRasterLayer,
  type ForecastRequestHandle, type ForecastRequestSpec, type PinnedBuild, type RasterTileHandle, type RasterTileSourceProtocol
} from '@av/client';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { rainContourStrokePair, type ResolvedChannelStyles } from '../map/channel-styles';
import { planRasterCrop, type RasterCrop } from '../raster/raster-crop';
import {
  buildRainContourGeoJson,
  decodePrecipRgbaToField,
  RainAnimator,
  renderRainInnerVignetteRgba,
  type PrecipField,
  type RainContourGeoJson
} from './rain-animation';
import {
  isBitmapPendingOnImageSource,
  OwnedImageBitmapRetirer,
  RAIN_CUFF_LAYER_ID,
  rainCuffBeforeId,
  weatherContourBeforeId
} from './sky-layer-order';
import { pilotHorizonFrameOrder, type ViewportBounds } from './synoptic-sampler';

type Coordinates = [[number, number], [number, number], [number, number], [number, number]];
interface ImageSourceLike {
  updateImage?: (options: { image: ImageBitmap; coordinates: Coordinates }) => void;
}
interface GeoJsonSourceLike {
  setData?: (data: unknown) => void;
}

interface CachedRainCuff {
  readonly hasCuff: boolean;
  readonly bitmap: ImageBitmap | null;
  readonly coordinates: Coordinates;
}

const RAIN_CUFF_SOURCE_ID = RAIN_CUFF_LAYER_ID;
const RAIN_CONTOUR_SOURCE_ID = 'av-rain-contours';
const RAIN_CONTOUR_HALO_ID = 'av-rain-contours-halo';
const RAIN_CONTOUR_SHOWER_ID = 'av-rain-contours-shower';
const RAIN_CONTOUR_SQUALL_ID = 'av-rain-contours-squall';
const RAIN_CONTOUR_TICK_ID = 'av-rain-contours-tick';

const RAIN_FIELD_SIZE = 224;
const MAX_RAIN_FIELD_CACHE = 80;
const MAX_CUFF_CACHE = 48;
const MAX_RAIN_CONTOUR_CACHE = 64;

function planRainCrop(raw: ViewportBounds, mapZoom: number, maxzoom: number): RasterCrop | null {
  const view: [number, number, number, number] = [raw.west, raw.south, raw.east, raw.north];
  const topZ = Math.max(0, Math.min(maxzoom, Math.round(mapZoom)));
  for (let z = topZ; z >= 0; z--) {
    const wide = planRasterCrop(view, z, { marginFractionPerEdge: 0.28, gutterPixelsPerEdge: 1 });
    if (wide && wide.tiles.length <= 6) return wide;
    const tight = planRasterCrop(view, z, { marginFractionPerEdge: 0.14, gutterPixelsPerEdge: 1 });
    if (tight && tight.tiles.length <= 6) return tight;
  }
  return null;
}

/**
 * Checks whether a cached `PrecipField` covers the viewport without over-coarsening relative to
 * the layer's native `maxzoom` (e.g., GFS `precip-rate` `maxzoom = 4..6`, where 1 tile spans 5.6°–22.5°).
 */
function precipFieldCoversView(field: PrecipField, raw: ViewportBounds, maxzoom: number): boolean {
  const viewSpanLon = raw.east - raw.west;
  if (viewSpanLon >= 145) return field.east - field.west >= 320;
  if (raw.west < field.west || raw.east > field.east || raw.south < field.south || raw.north > field.north) {
    return false;
  }
  const minNativeSpanDeg = (360 / Math.pow(2, Math.max(0, maxzoom))) * 2.25;
  const maxAllowedSpan = Math.max(minNativeSpanDeg, viewSpanLon * 2.75);
  return (field.east - field.west) <= maxAllowedSpan;
}

export interface LiveRainRenderState {
  readonly styles: ResolvedChannelStyles;
  readonly opacity: number;
  readonly visible: boolean;
}

/**
 * Dedicated Precipitation (`precip-rate`) controller managing:
 * 1. Foreground + background horizon-warmed `precip-rate` crop decoding + 80-frame LRU cache,
 * 2. Pre-cached Asymmetric Inner Vignette Cuff (`#1`) WebGL `ImageSource` (`av-rain-cuff`) with safe `ImageBitmap` retirement,
 * 3. Pre-cached Crisp Dry-Halo / SIGWX Scallop / Inward-Tick / Wet-Lens vector perimeter (`av-rain-contours`) below text labels,
 * 4. Screen-space 60 fps `RainAnimator` raindrops & splash ripples.
 */
export class RainLayerController {
  private readonly decodeCanvas: OffscreenCanvas | null;
  private readonly cuffCanvas: OffscreenCanvas | null;
  private readonly animator: RainAnimator | null;
  private readonly protocol: RasterTileSourceProtocol | null;
  private readonly cuffBitmaps = new OwnedImageBitmapRetirer();
  private readonly fieldCache = new Map<string, PrecipField>();
  private readonly cuffCache = new Map<string, CachedRainCuff>();
  private readonly contourCache = new Map<string, RainContourGeoJson>();
  private activeField: PrecipField | null = null;
  private activeFgHandles: RasterTileHandle[] = [];
  private activeWarmHandles: RasterTileHandle[] = [];
  private shownCuffBitmap: ImageBitmap | null = null;
  private shownCuffKey = '';
  private cuffDryHidden = false;
  private shownContourKey = '';
  private lastStyleSig = '';
  private jobToken = 0;
  private warmToken = 0;
  private disposed = false;

  constructor(
    private readonly map: MapLibreMap,
    baseUrl: string,
    supported: boolean,
    options: {
      styles: ResolvedChannelStyles;
      opacity: number;
      visible: boolean;
      fetchImpl?: typeof fetch;
      request?: (spec: ForecastRequestSpec) => ForecastRequestHandle;
    }
  ) {
    this.decodeCanvas = supported ? new OffscreenCanvas(RAIN_FIELD_SIZE, RAIN_FIELD_SIZE) : null;
    this.cuffCanvas = supported ? new OffscreenCanvas(RAIN_FIELD_SIZE, RAIN_FIELD_SIZE) : null;
    this.animator = supported
      ? new RainAnimator(map, { darkChrome: options.styles.darkChrome, opacity: options.opacity, visible: options.visible })
      : null;
    this.protocol = supported
      ? createSourceRasterTileProtocol(baseUrl, {
          maxSources: 2,
          fetchImpl: options.fetchImpl,
          request: options.request,
          maxActive: 8,
          maxPrefetchActive: 6
        })
      : null;
  }

  findCachedField(build: PinnedBuild, frame: string, raw: ViewportBounds): PrecipField | null {
    if (!build.templates['precip-rate']) return null;
    const maxzoom = layerMaxZoom(build.manifest, 'precip-rate');
    const prefix = `${build.manifest.buildId}:${frame}:`;
    if (this.activeField?.key.startsWith(prefix) && precipFieldCoversView(this.activeField, raw, maxzoom)) {
      return this.activeField;
    }
    const crop = planRainCrop(raw, this.map.getZoom(), maxzoom);
    if (crop) {
      const exactKey = `${prefix}${crop.zoom}:${crop.left}:${crop.top}:${crop.right}:${crop.bottom}`;
      const exact = this.fieldCache.get(exactKey);
      if (exact) {
        this.touchFieldCache(exactKey, exact);
        return exact;
      }
    }
    for (const [key, candidate] of this.fieldCache) {
      if (candidate.key.startsWith(prefix) && precipFieldCoversView(candidate, raw, maxzoom)) {
        this.touchFieldCache(key, candidate);
        return candidate;
      }
    }
    return null;
  }

  /** Synchronously paints a cached `PrecipField` in 0 ms without yielding across an async boundary. */
  tryPaintCached(
    build: PinnedBuild,
    frame: string,
    raw: ViewportBounds,
    state: LiveRainRenderState
  ): boolean {
    if (this.disposed || !this.protocol || !this.decodeCanvas) return false;
    if (!build.templates['precip-rate']) {
      this.clear();
      return true;
    }
    if (!state.visible) {
      this.syncStyleAndVisibility(state.styles, state.opacity, false);
      return true;
    }
    const hit = this.findCachedField(build, frame, raw);
    if (!hit) return false;
    this.cancelForegroundHandles();
    this.jobToken++;
    this.activeField = hit;
    this.applyField(hit, raw, state.styles, state.opacity, state.visible);
    return true;
  }

  pauseWarming(): void {
    this.warmToken++;
    for (const handle of this.activeWarmHandles.splice(0)) handle.cancel();
  }

  async refresh(
    build: PinnedBuild,
    frame: string,
    raw: ViewportBounds,
    initial: LiveRainRenderState,
    readLive?: () => LiveRainRenderState | null
  ): Promise<boolean> {
    if (this.disposed || !this.protocol || !this.decodeCanvas) return false;
    if (!initial.visible) {
      this.syncStyleAndVisibility(initial.styles, initial.opacity, false);
      return false;
    }

    if (this.tryPaintCached(build, frame, raw, initial)) return true;

    const template = build.templates['precip-rate'];
    if (!template) {
      this.clear();
      return false;
    }

    const maxzoom = layerMaxZoom(build.manifest, 'precip-rate');
    const crop = planRainCrop(raw, this.map.getZoom(), maxzoom);
    if (!crop) return false;

    this.pauseWarming();
    this.cancelForegroundHandles();
    const token = ++this.jobToken;
    const handles: RasterTileHandle[] = [];
    this.activeFgHandles = handles;

    const field = await this.decodeCropField(build, frame, crop, 'foreground', handles, () => !this.disposed && token === this.jobToken);
    if (this.activeFgHandles === handles) this.activeFgHandles = [];
    if (!field || this.disposed || token !== this.jobToken) return false;

    const live = readLive ? readLive() : initial;
    if (!live) return false;

    this.activeField = field;
    this.applyField(field, raw, live.styles, live.opacity, live.visible);
    return true;
  }

  /**
   * Politely warms `precip-rate` fields across the forecast horizon in pilot scrub order
   * (`+1..+8h` and multi-day same-hour jumps first) at low priority, one frame at a time.
   */
  warmHorizon(build: PinnedBuild, anchorFrame: string, raw: ViewportBounds): void {
    if (this.disposed || !this.protocol || !this.decodeCanvas || !build.templates['precip-rate']) return;
    const maxzoom = layerMaxZoom(build.manifest, 'precip-rate');
    const crop = planRainCrop(raw, this.map.getZoom(), maxzoom);
    if (!crop) return;

    this.pauseWarming();
    const token = this.warmToken;
    const ordered = pilotHorizonFrameOrder(build, anchorFrame);

    void (async () => {
      for (const frame of ordered) {
        if (this.disposed || token !== this.warmToken || build.expiresAtMs <= Date.now()) return;
        if (this.findCachedField(build, frame, raw)) continue;
        const handles: RasterTileHandle[] = [];
        this.activeWarmHandles = handles;
        await this.decodeCropField(build, frame, crop, 'background', handles, () => !this.disposed && token === this.warmToken);
        if (this.activeWarmHandles === handles) this.activeWarmHandles = [];
      }
    })();
  }

  repaintCurrent(raw: ViewportBounds, styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    this.animator?.setDarkChrome(styles.darkChrome);
    this.animator?.setOpacity(opacity);
    if (this.activeField && visible) {
      this.paintCuff(this.activeField, styles, opacity, visible);
      this.paintContours(this.activeField, raw, styles, visible);
    }
    this.syncStyleAndVisibility(styles, opacity, visible);
  }

  syncStyleAndVisibility(styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    this.animator?.setDarkChrome(styles.darkChrome);
    this.animator?.setOpacity(opacity);
    this.animator?.setVisible(visible);

    const hasCuffLayer = Boolean(this.map.getLayer(RAIN_CUFF_SOURCE_ID));
    const hasHaloLayer = Boolean(this.map.getLayer(RAIN_CONTOUR_HALO_ID));
    const cuffOpacity = visible && !this.cuffDryHidden ? clampOpacity(0.66 + opacity * 0.34) : 0;
    const re = styles.rainEdge;
    const { haloColor, showerColor } = rainContourStrokePair(styles);
    const alphaScale = clampOpacity(0.66 + opacity * 0.34);
    const isCuffOrLens = styles.rainStyle === 'vignette-cuff' || styles.rainStyle === 'wet-lens';

    const sig = `${hasCuffLayer}:${hasHaloLayer}:${visible}:${cuffOpacity.toFixed(3)}:${alphaScale.toFixed(3)}:${styles.rainStyle}:${haloColor}:${showerColor}:${re.coreStrokeColor}`;
    if (sig === this.lastStyleSig) return;
    this.lastStyleSig = sig;

    if (hasCuffLayer) {
      this.map.setPaintProperty(RAIN_CUFF_SOURCE_ID, 'raster-opacity', cuffOpacity);
    }

    const vis = visible ? 'visible' : 'none';
    for (const id of [RAIN_CONTOUR_HALO_ID, RAIN_CONTOUR_SHOWER_ID, RAIN_CONTOUR_SQUALL_ID, RAIN_CONTOUR_TICK_ID]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }

    if (hasHaloLayer) {
      this.map.setPaintProperty(RAIN_CONTOUR_HALO_ID, 'line-color', haloColor);
      this.map.setPaintProperty(RAIN_CONTOUR_HALO_ID, 'line-opacity', 0.94 * alphaScale);
      this.map.setPaintProperty(RAIN_CONTOUR_HALO_ID, 'line-blur', isCuffOrLens ? 0.65 : 0.25);
      this.map.setPaintProperty(
        RAIN_CONTOUR_HALO_ID,
        'line-width',
        ['case', ['==', ['get', 'tier'], 'squall'], 4.4, isCuffOrLens ? 4.2 : 3.6]
      );
    }
    if (this.map.getLayer(RAIN_CONTOUR_SHOWER_ID)) {
      this.map.setPaintProperty(RAIN_CONTOUR_SHOWER_ID, 'line-color', showerColor);
      this.map.setPaintProperty(RAIN_CONTOUR_SHOWER_ID, 'line-opacity', 0.96 * alphaScale);
      this.map.setPaintProperty(RAIN_CONTOUR_SHOWER_ID, 'line-width', isCuffOrLens ? 2.1 : 1.65);
    }
    if (this.map.getLayer(RAIN_CONTOUR_SQUALL_ID)) {
      this.map.setPaintProperty(RAIN_CONTOUR_SQUALL_ID, 'line-color', re.coreStrokeColor);
      this.map.setPaintProperty(RAIN_CONTOUR_SQUALL_ID, 'line-opacity', 0.98 * alphaScale);
    }
    if (this.map.getLayer(RAIN_CONTOUR_TICK_ID)) {
      this.map.setPaintProperty(RAIN_CONTOUR_TICK_ID, 'line-color', re.coreStrokeColor);
      this.map.setPaintProperty(RAIN_CONTOUR_TICK_ID, 'line-opacity', 0.92 * alphaScale);
    }
  }

  clear(): void {
    this.jobToken++;
    this.pauseWarming();
    this.cancelForegroundHandles();
    this.activeField = null;
    this.shownCuffBitmap = null;
    this.shownCuffKey = '';
    this.cuffDryHidden = false;
    this.shownContourKey = '';
    this.lastStyleSig = '';
    this.animator?.setField(null);
    if (typeof this.map.getLayer === 'function') {
      for (const id of [RAIN_CONTOUR_TICK_ID, RAIN_CONTOUR_SQUALL_ID, RAIN_CONTOUR_SHOWER_ID, RAIN_CONTOUR_HALO_ID, RAIN_CUFF_SOURCE_ID]) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      }
    }
    if (typeof this.map.getSource === 'function') {
      for (const src of [RAIN_CONTOUR_SOURCE_ID, RAIN_CUFF_SOURCE_ID]) {
        if (this.map.getSource(src)) this.map.removeSource(src);
      }
    }
    for (const entry of this.cuffCache.values()) entry.bitmap?.close();
    this.cuffCache.clear();
    this.contourCache.clear();
    this.cuffBitmaps.releaseAllAfterSourceRemoved();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.animator?.destroy();
    this.protocol?.dispose();
    this.fieldCache.clear();
  }

  private cancelForegroundHandles(): void {
    for (const handle of this.activeFgHandles.splice(0)) handle.cancel();
  }

  private touchFieldCache(key: string, field: PrecipField): void {
    this.fieldCache.delete(key);
    this.fieldCache.set(key, field);
  }

  private async decodeCropField(
    build: PinnedBuild,
    frame: string,
    crop: RasterCrop,
    priority: 'foreground' | 'background',
    handlesOut: RasterTileHandle[],
    isCurrent: () => boolean
  ): Promise<PrecipField | null> {
    if (!this.protocol || !this.decodeCanvas) return null;
    const template = build.templates['precip-rate'];
    if (!template) return null;

    const buildId = build.manifest.buildId;
    const cacheKey = `${buildId}:${frame}:${crop.zoom}:${crop.left}:${crop.top}:${crop.right}:${crop.bottom}`;
    const existing = this.fieldCache.get(cacheKey);
    if (existing) {
      this.touchFieldCache(cacheKey, existing);
      return existing;
    }

    this.protocol.setBuildExpiry(buildId, build.expiresAtMs);

    try {
      const tileBitmaps = await Promise.all(crop.tiles.map(async tile => {
        const url = frameTileUrl(template, frame)
          .replaceAll('{z}', String(tile.z))
          .replaceAll('{x}', String(tile.canonicalX))
          .replaceAll('{y}', String(tile.y));
        let data: ArrayBuffer;
        let release: (() => void) | undefined;
        if (typeof this.protocol!.requestTile === 'function') {
          const handle = this.protocol!.requestTile(url, { priority });
          handlesOut.push(handle);
          const res = await handle.response;
          data = res.data;
          release = res.release;
        } else {
          const res = await this.protocol!.load({ url }, new AbortController());
          data = res.data;
        }
        try {
          if (!isCurrent() || data.byteLength <= 48) return null;
          const bmp = await createImageBitmap(new Blob([data], { type: 'image/webp' }));
          return { tile, bmp };
        } finally {
          release?.();
        }
      }));

      if (!isCurrent()) {
        for (const item of tileBitmaps) item?.bmp.close();
        return null;
      }

      const scaleX = RAIN_FIELD_SIZE / crop.width;
      const scaleY = RAIN_FIELD_SIZE / crop.height;
      const ctx = this.decodeCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        for (const item of tileBitmaps) item?.bmp.close();
        return null;
      }
      ctx.clearRect(0, 0, RAIN_FIELD_SIZE, RAIN_FIELD_SIZE);
      for (const item of tileBitmaps) {
        if (!item) continue;
        try {
          ctx.drawImage(
            item.bmp,
            item.tile.drawX * scaleX,
            item.tile.drawY * scaleY,
            RASTER_TILE_SIZE * scaleX,
            RASTER_TILE_SIZE * scaleY
          );
        } finally {
          item.bmp.close();
        }
      }

      const pixels = ctx.getImageData(0, 0, RAIN_FIELD_SIZE, RAIN_FIELD_SIZE).data;
      const west = crop.coordinates[0][0];
      const north = crop.coordinates[0][1];
      const east = crop.coordinates[1][0];
      const south = crop.coordinates[2][1];
      const field = decodePrecipRgbaToField(pixels, RAIN_FIELD_SIZE, RAIN_FIELD_SIZE, {
        west,
        south,
        east: east > west ? east : east + 360,
        north
      }, cacheKey);

      if (this.fieldCache.size >= MAX_RAIN_FIELD_CACHE) {
        const oldest = this.fieldCache.keys().next().value;
        if (oldest !== undefined) this.fieldCache.delete(oldest);
      }
      this.fieldCache.set(cacheKey, field);
      return field;
    } catch {
      return null;
    }
  }

  private applyField(
    field: PrecipField,
    raw: ViewportBounds,
    styles: ResolvedChannelStyles,
    opacity: number,
    visible: boolean
  ): void {
    this.animator?.setDarkChrome(styles.darkChrome);
    this.animator?.setField(field);
    this.paintCuff(field, styles, opacity, visible);
    this.paintContours(field, raw, styles, visible);
    this.syncStyleAndVisibility(styles, opacity, visible);
  }

  private paintCuff(field: PrecipField, styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    const canvas = this.cuffCanvas;
    if (!canvas || this.disposed) return;

    const cuffKey = `${field.key}:${styles.rainStyle}:${styles.rainEdge.cuffRgb.join(',')}:${styles.rainEdge.cuffMaxAlpha}`;
    let entry = this.cuffCache.get(cuffKey);
    if (entry) {
      this.cuffCache.delete(cuffKey);
      this.cuffCache.set(cuffKey, entry);
    } else {
      const coordinates: Coordinates = [
        [field.west, field.north],
        [field.east, field.north],
        [field.east, field.south],
        [field.west, field.south]
      ];
      if (canvas.width !== field.cols) canvas.width = field.cols;
      if (canvas.height !== field.rows) canvas.height = field.rows;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      const img = ctx.createImageData(field.cols, field.rows);
      const hasCuff = renderRainInnerVignetteRgba(field, styles, img.data);
      let bitmap: ImageBitmap | null = null;
      if (hasCuff) {
        ctx.putImageData(img, 0, 0);
        try { bitmap = canvas.transferToImageBitmap(); }
        catch { return; }
      }
      if (this.cuffCache.size >= MAX_CUFF_CACHE) {
        for (const [oldKey, oldVal] of this.cuffCache) {
          if (oldVal.bitmap && oldVal.bitmap === this.shownCuffBitmap) continue;
          this.cuffCache.delete(oldKey);
          if (oldVal.bitmap) {
            if (isBitmapPendingOnImageSource(this.map, RAIN_CUFF_SOURCE_ID, oldVal.bitmap)) {
              this.cuffBitmaps.present(this.map, RAIN_CUFF_SOURCE_ID, oldVal.bitmap);
            } else {
              oldVal.bitmap.close();
            }
          }
          break;
        }
      }
      entry = { hasCuff, bitmap, coordinates };
      this.cuffCache.set(cuffKey, entry);
    }

    if (!entry.hasCuff || !entry.bitmap) {
      // Keep any mounted cuff source intact at opacity 0 instead of removing/re-adding layers on dry<->wet scrubs.
      if (!this.cuffDryHidden) {
        this.cuffDryHidden = true;
        this.lastStyleSig = '';
      }
      if (this.map.getLayer(RAIN_CUFF_SOURCE_ID)) {
        this.map.setPaintProperty(RAIN_CUFF_SOURCE_ID, 'raster-opacity', 0);
      }
      return;
    }

    if (this.cuffDryHidden) {
      this.cuffDryHidden = false;
      this.lastStyleSig = '';
    }

    const existing = this.map.getSource(RAIN_CUFF_SOURCE_ID) as ImageSourceLike | undefined;
    if (!existing) {
      this.shownCuffKey = '';
      this.lastStyleSig = '';
      this.map.addSource(RAIN_CUFF_SOURCE_ID, { type: 'image', coordinates: entry.coordinates });
      const layer = previewRasterLayer(visible ? clampOpacity(0.66 + opacity * 0.34) : 0);
      this.map.addLayer(
        { ...layer, id: RAIN_CUFF_SOURCE_ID, source: RAIN_CUFF_SOURCE_ID, paint: { ...layer.paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } },
        rainCuffBeforeId(this.map)
      );
    }

    if (this.shownCuffKey !== cuffKey) {
      const src = this.map.getSource(RAIN_CUFF_SOURCE_ID) as ImageSourceLike | undefined;
      if (src?.updateImage) {
        src.updateImage({ image: entry.bitmap, coordinates: entry.coordinates });
        this.shownCuffBitmap = entry.bitmap;
        this.shownCuffKey = cuffKey;
        this.cuffBitmaps.flushUploaded(this.map, RAIN_CUFF_SOURCE_ID);
      }
    }
  }

  private paintContours(field: PrecipField, raw: ViewportBounds, styles: ResolvedChannelStyles, visible: boolean): void {
    const spanDeg = Math.max(0.05, raw.east - raw.west);
    const needsScaleQuant = styles.rainStyle === 'sigwx-scallop' || styles.rainStyle === 'inward-comb';
    const scaleTag = needsScaleQuant ? Math.round(Math.log2(spanDeg) * 4) : 0;
    const contourKey = `${field.key}:${styles.rainStyle}:${scaleTag}`;

    let geo = this.contourCache.get(contourKey);
    if (geo) {
      this.contourCache.delete(contourKey);
      this.contourCache.set(contourKey, geo);
    } else {
      geo = buildRainContourGeoJson(field, styles.rainStyle, spanDeg);
      if (this.contourCache.size >= MAX_RAIN_CONTOUR_CACHE) {
        const oldest = this.contourCache.keys().next().value;
        if (oldest !== undefined) this.contourCache.delete(oldest);
      }
      this.contourCache.set(contourKey, geo);
    }

    const src = this.map.getSource(RAIN_CONTOUR_SOURCE_ID) as GeoJsonSourceLike | undefined;
    if (src?.setData) {
      if (this.shownContourKey !== contourKey) {
        src.setData(geo);
        this.shownContourKey = contourKey;
      }
      return;
    }

    const re = styles.rainEdge;
    const { haloColor, showerColor } = rainContourStrokePair(styles);
    const isCuffOrLens = styles.rainStyle === 'vignette-cuff' || styles.rainStyle === 'wet-lens';
    const vis = visible ? 'visible' : 'none';
    const beforeId = weatherContourBeforeId(this.map);
    this.lastStyleSig = '';
    this.shownContourKey = contourKey;

    this.map.addSource(RAIN_CONTOUR_SOURCE_ID, { type: 'geojson', data: geo });
    this.map.addLayer({
      id: RAIN_CONTOUR_HALO_ID,
      type: 'line',
      source: RAIN_CONTOUR_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': haloColor,
        'line-width': ['case', ['==', ['get', 'tier'], 'squall'], 4.4, isCuffOrLens ? 4.2 : 3.6],
        'line-blur': isCuffOrLens ? 0.65 : 0.25,
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
        'line-width': isCuffOrLens ? 2.1 : 1.65
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
    this.map.addLayer({
      id: RAIN_CONTOUR_TICK_ID,
      type: 'line',
      source: RAIN_CONTOUR_SOURCE_ID,
      filter: ['==', ['get', 'tier'], 'tick'],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': re.coreStrokeColor,
        'line-width': 1.35
      }
    }, beforeId);
  }
}
