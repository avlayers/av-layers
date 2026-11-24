import type { Map } from 'maplibre-gl';
import { clampOpacity, frameTileUrl, layerMaxZoom, previewRasterLayer, seamInsertBefore, type PinnedBuild, type PreparationBudget, type PreparationLease, type RasterTileHandle, type RasterTileSourceProtocol, type RasterTileSourceTransport } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { MAX_TILE_BYTES, RASTER_TILE_SIZE } from '@av/contracts/format';
import { planRasterCrop, requiredSourceZoom, type RasterCrop } from './raster-crop';
import type { MapTheme } from '../map/visual-theme';
import { canRemapTiles, remapTileToBitmap } from './tile-remap';

export { FOCUS_DWELL_MS } from '../map/viewport-policy';

type Quality = 'overview' | 'detail';
type Coordinates = [[number, number], [number, number], [number, number], [number, number]];
interface Image { bitmap: ImageBitmap; lease: PreparationLease | null }
interface Retired { image: Image; frame: string | null; coordinates: Coordinates | null; sourceId: string; displayLease: PreparationLease | null; previewLease: PreparationLease | null }
interface Tile {
  state: 'waiting' | 'fetching' | 'compressed' | 'decoding' | 'drawn' | 'cancelled';
  handle?: RasterTileHandle;
  data?: ArrayBuffer;
  release?: () => void;
}
interface Job {
  frame: string;
  crop: RasterCrop;
  width: number;
  height: number;
  tiles: Tile[];
  failed: boolean;
  lease: PreparationLease | null;
  partial?: ImageBitmap;
}
interface Context {
  build: PinnedBuild;
  layer: LayerId;
  frames: string[];
  preview: RasterCrop;
  jobs: Job[];
  previewLease: PreparationLease | null;
}
interface ImageSourceLike {
  image?: ImageBitmap;
  _imageDirty?: boolean;
  texture?: unknown;
  tileID?: { equals?: (other: unknown) => boolean };
  tiles?: Record<string, { state?: string; tileID?: { canonical?: unknown } }>;
  updateImage?: (options: { image: ImageBitmap; coordinates: Coordinates }) => void;
  setCoordinates?: (coordinates: Coordinates) => void;
}
interface RasterOverviewState { ready: number; total: number; failed: number }
interface RasterOverviewReadiness { previewReadyFrames: readonly string[]; detailReadyFrames: readonly string[]; limited: boolean }
export interface RasterOverviewOptions { budget?: PreparationBudget; requestLimits?: { maxActive: number; maxPrefetchActive: number }; theme?: MapTheme }

const SELECTED_PREVIEW_SLOTS = 4;
const DECODE_LEASE_BYTES = 4 * (MAX_TILE_BYTES + RASTER_TILE_SIZE ** 2 * 4);
const PREVIEW_RETRY_COOLDOWN_MS = 1_000;
const MAX_PREVIEW_ATTEMPTS = 3;

function bounds(map: Map): [number, number, number, number] {
  const value = map.getBounds();
  let west = value.getWest(), east = value.getEast();
  if (east <= west) east += 360;
  if (east - west > 360) { const middle = (west + east) / 2; west = middle - 180; east = middle + 180; }
  return [west, value.getSouth(), east, value.getNorth()];
}

function canonicalZoom(map: Map, maxzoom: number): number | null {
  if (typeof map.coveringTiles !== 'function') return Math.max(0, Math.min(maxzoom, Math.round(map.getZoom())));
  const covering = map.coveringTiles({ tileSize: RASTER_TILE_SIZE, minzoom: 0, maxzoom, roundZoom: true })
    .map(tile => ({ z: tile?.canonical?.z ?? tile?.overscaledZ })).filter(tile => Number.isFinite(tile.z));
  return requiredSourceZoom(covering);
}

function previewCrop(view: [number, number, number, number], zoom: number): RasterCrop | null {
  for (let z = Math.max(0, zoom - 1); z >= 0; z--) {
    const crop = planRasterCrop(view, z);
    if (crop && crop.tiles.length <= 4) return crop;
  }
  return null;
}

function contains(crop: RasterCrop, view: [number, number, number, number]): boolean {
  const current = planRasterCrop(view, crop.zoom, { marginFractionPerEdge: 0, gutterPixelsPerEdge: 0 });
  if (!current) return false;
  const shift = Math.round((crop.left + crop.right - current.left - current.right) / (2 * crop.worldSize)) * crop.worldSize;
  return current.top >= crop.top && current.bottom <= crop.bottom
    && (crop.right - crop.left >= crop.worldSize || (current.left + shift >= crop.left && current.right + shift <= crop.right));
}

export class RasterOverview {
  readonly id = `av-overview-${crypto.randomUUID()}`;
  readonly supported: boolean;
  private readonly canvas: OffscreenCanvas | null;
  private readonly transport: RasterTileSourceTransport | null;
  private readonly previews = new globalThis.Map<string, Image>();
  private readonly unavailable = new Set<string>();
  private readonly retries = new Set<string>();
  private readonly failureCounts = new globalThis.Map<string, number>();
  private readonly retryAfter = new globalThis.Map<string, number>();
  private context: Context | null = null;
  private selected: string | null = null;
  private direction = 1;
  private shown: Image | null = null;
  private shownId: string = this.id;
  private visibleId: string | null = null;
  private shownFrame: string | null = null;
  private shownCoordinates: Coordinates | null = null;
  private heldLease: PreparationLease | null = null;
  private displayLease: PreparationLease | null = null;
  private readonly retired: Retired[] = [];
  private readonly opacities = new globalThis.Map<string, number>();
  private failedImage: Image | null = null;
  private publishing = false;
  private canvasLease: PreparationLease | null = null;
  private decodeLease: PreparationLease | null = null;
  private composing: Job | null = null;
  private fetching = 0;
  private decoding = 0;
  private pumpVersion = 0;
  private previewEpoch = 0;
  private coverageCache: { key: string; preview: boolean } | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private themeWarmTimer: ReturnType<typeof setTimeout> | null = null;
  private warmingPaused = false;
  private theme: MapTheme;
  private disposed = false;
  private limited = false;
  private deferred: { build: PinnedBuild; layer: LayerId; frame: string } | null = null;
  private readonly unsubscribeBudget: (() => void) | null;

  constructor(private readonly map: Map, private readonly protocol: RasterTileSourceProtocol, private readonly onReady: () => void, private readonly options: RasterOverviewOptions = {}) {
    this.theme = options.theme ?? 'stone';
    this.canvas = typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function' && typeof map.getCanvas === 'function'
      ? new OffscreenCanvas(RASTER_TILE_SIZE, RASTER_TILE_SIZE) : null;
    this.supported = !!this.canvas?.getContext('2d') && typeof this.canvas.transferToImageBitmap === 'function';
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.transport = this.supported ? protocol.createSource(false) : null;
    this.unsubscribeBudget = options.budget?.onRelease(() => {
      if (this.disposed) return;
      if (this.deferred) this.select(this.deferred.build, this.deferred.layer, this.deferred.frame);
      else {
        this.refresh();
        const context = this.context;
        if (context && this.selected && this.needsUpdate(context.build, context.layer, this.selected)) this.onReady();
      }
    }) ?? null;
  }

  get state(): RasterOverviewState {
    const frames = this.context?.frames ?? [];
    const cov = this.coverage();
    let ready = 0, failed = 0;
    for (const frame of frames) {
      const usable = this.isFrameUsable(frame, cov);
      if (usable) ready++;
      else if (this.unavailable.has(frame)) failed++;
    }
    return { ready, total: frames.length, failed };
  }

  readiness(): RasterOverviewReadiness {
    const frames = this.context?.frames ?? [];
    const cov = this.coverage();
    return {
      previewReadyFrames: cov.preview ? frames.filter(frame => this.previews.has(frame)) : [],
      detailReadyFrames: [],
      limited: this.limited
    };
  }

  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (!this.supported || this.disposed) return;
    this.failedImage = null;
    const frames = renderedFrames(build.manifest).map(value => value.id);
    if (build.expiresAtMs <= Date.now() || !build.templates[layer] || !frames.includes(frame)) { this.clear(); return; }
    const view = bounds(this.map), maxzoom = layerMaxZoom(build.manifest, layer);
    const required = canonicalZoom(this.map, maxzoom);
    const previewZoom = required ?? Math.max(0, Math.min(maxzoom, Math.round(this.map.getZoom())));
    const preview = previewCrop(view, previewZoom);
    const previewHeld = !!this.context && !!preview && this.context.build === build && this.context.layer === layer
      && contains(this.context.preview, view)
      && Math.abs(preview.zoom - this.context.preview.zoom) <= 1;
    if (!previewHeld) {
      this.reset(true);
      if (this.context || this.disposed) return;
      if (!preview) { this.selected = frame; this.limited = true; this.onReady(); return; }
      const previewBytes = frames.length * 256 * 256 * 4;
      const previewLease = this.options.budget
        ? (this.options.budget.reserve('raster-preview', previewBytes, 'background')
          ?? this.options.budget.reserve('raster-preview', previewBytes, 'foreground'))
        : null;
      if (this.options.budget && !previewLease && !this.options.budget.canReserve(256 * 256 * 4, 'foreground')) {
        this.deferred = { build, layer, frame }; this.selected = frame; this.markLimited(); return;
      }
      if (this.options.budget && !previewLease) this.markLimited();
      this.deferred = null;
      this.context = { build, layer, frames, preview, jobs: [], previewLease };
      this.protocol.setBuildExpiry(build.manifest.buildId, build.expiresAtMs);
      this.expiry = setTimeout(() => this.refresh(), Math.min(build.expiresAtMs - Date.now(), 2_147_000_000));
      for (const id of frames) this.context.jobs.push(this.job(id, preview));
    }
    if (this.selected !== frame) {
      if (this.selected) this.direction = frames.indexOf(frame) > frames.indexOf(this.selected) ? 1 : -1;
    }
    this.selected = frame;
    this.ensureSelectedPreview(frame);
    const active = this.context;
    if (!active) return;
    for (const job of active.jobs) if (job.frame === frame) for (const tile of job.tiles) tile.handle?.promote();
    this.pump();
  }

  coversView(): boolean { return this.covers(); }
  hasExtent(): boolean { return this.context !== null; }

  ready(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    return !this.disposed && this.context?.build === build && this.context.layer === layer && build.expiresAtMs > Date.now() && this.isFrameUsable(frame);
  }

  quality(build: PinnedBuild, layer: LayerId, frame: string): Quality | null {
    return this.ready(build, layer, frame) ? 'overview' : null;
  }

  needsUpdate(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    if (!this.ready(build, layer, frame)) return false;
    const image = this.previews.get(frame);
    return !!image && image !== this.shown && image !== this.failedImage;
  }

  ownsSource(id: string | undefined): boolean { return id === this.id || id === `${this.id}-stage`; }

  canPaint(): boolean {
    const source = this.map.getSource(this.shownId) as ImageSourceLike | undefined;
    if (!source) return true;
    if ('image' in source && source.image !== this.shown?.bitmap) return false;
    if ('_imageDirty' in source && source._imageDirty !== false) return false;
    if ('texture' in source && !source.texture) return false;
    if ('tiles' in source && source.tiles) {
      return Object.values(source.tiles).some(tile => tile?.state === 'loaded'
        && (!source.tileID?.equals || !tile.tileID?.canonical || source.tileID.equals(tile.tileID.canonical)));
    }
    return true;
  }

  show(build: PinnedBuild, layer: LayerId, frame: string, opacity: number): boolean {
    if (this.publishing || !this.ready(build, layer, frame)) return false;
    const image = this.previews.get(frame);
    if (!image || image === this.failedImage) return false;
    const coordinates = this.context!.preview.coordinates;
    let displayLease: PreparationLease | null = null;
    if (this.shown !== image) {
      displayLease = this.options.budget?.reserve('raster-display', image.bitmap.width * image.bitmap.height * 8, 'foreground') ?? null;
      if (this.shown !== image && this.options.budget && !displayLease) { this.markLimited(); return false; }
    }
    if (image === this.failedImage) { displayLease?.release(); return false; }
    const targetId = this.shown !== image && this.visibleId === this.shownId ? (this.shownId === this.id ? `${this.id}-stage` : this.id) : this.shownId;
    const context = this.context, selected = this.selected, shown = this.shown, visibleId = this.visibleId;
    const previous = targetId === this.shownId ? { image: this.shown, coordinates: this.shownCoordinates }
      : this.retired.findLast(entry => entry.sourceId === targetId);
    const targetOpacity = this.opacities.get(targetId) ?? 0;
    const visibleOpacity = visibleId ? this.opacities.get(visibleId) ?? 0 : 0;
    let created = false;
    let source: ImageSourceLike | undefined;
    this.publishing = true;
    try {
      created = !this.map.getSource(targetId);
      if (created) {
        this.map.addSource(targetId, { type: 'image', coordinates });
        this.map.addLayer({ ...previewRasterLayer(0), id: targetId, source: targetId, paint: { ...previewRasterLayer(0).paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } }, seamInsertBefore(this.map));
        this.opacities.set(targetId, 0);
      }
      source = this.map.getSource(targetId) as ImageSourceLike | undefined;
      if (!source) throw new Error('Raster image source unavailable');
      if (this.shown !== image) {
        source?.updateImage?.({ image: image.bitmap, coordinates });
        if (created) source?.setCoordinates?.(coordinates);
      } else if (this.shownCoordinates !== coordinates) {
        source?.setCoordinates?.(coordinates);
      }
      this.setOpacity(targetId, opacity);
      if (opacity > 0 && visibleId && visibleId !== targetId && this.map.getLayer(visibleId)) this.setOpacity(visibleId, 0);
      if (this.context !== context || this.selected !== selected || this.shown !== shown || this.disposed
        || this.previews.get(frame) !== image) throw new Error('Raster selection changed during publication');
    } catch {
      if (created) {
        try { this.removeSource(targetId); } catch { /* The owning map may already be unavailable. */ }
      } else {
        try {
          if (previous?.image && previous.coordinates) source?.updateImage?.({ image: previous.image.bitmap, coordinates: previous.coordinates });
          this.setOpacity(targetId, targetOpacity);
        } catch { /* Keep the previous display ownership until a later selection can recover. */ }
      }
      if (visibleId && visibleId !== targetId) {
        try { this.setOpacity(visibleId, visibleOpacity); } catch { /* Retain the previous image if its map cannot be updated. */ }
      }
      displayLease?.release();
      if (this.context === context && this.selected === selected) this.failedImage = image;
      return false;
    } finally {
      this.publishing = false;
    }
    if (this.shown !== image) {
      if (this.shown) this.retired.push({ image: this.shown, frame: this.shownFrame, coordinates: this.shownCoordinates, sourceId: this.shownId, displayLease: this.displayLease, previewLease: this.heldLease });
      this.heldLease = null; this.displayLease = displayLease;
      this.shown = image; this.shownId = targetId; this.shownFrame = frame;
    }
    this.shownCoordinates = coordinates;
    if (opacity > 0) this.visibleId = targetId;
    return true;
  }

  hide(): void { for (const id of [this.id, `${this.id}-stage`]) if (this.map.getLayer(id)) this.setOpacity(id, 0); this.visibleId = null; }

  private setOpacity(id: string, value: number): void {
    const opacity = clampOpacity(value);
    if (this.opacities.get(id) === opacity) return;
    try { this.map.setPaintProperty(id, 'raster-opacity', opacity); }
    catch (error) { this.opacities.delete(id); throw error; }
    this.opacities.set(id, opacity);
  }

  cancelStage(opacity: number): boolean {
    const oldId = this.visibleId !== this.shownId ? this.visibleId : this.retired.findLast(entry => entry.sourceId !== this.shownId)?.sourceId;
    if (!oldId) return false;
    if (this.map.getLayer(this.shownId)) this.map.removeLayer(this.shownId);
    this.opacities.delete(this.shownId);
    if (this.map.getSource(this.shownId)) this.map.removeSource(this.shownId);
    if (this.shown) this.retired.push({ image: this.shown, frame: this.shownFrame, coordinates: this.shownCoordinates, sourceId: this.shownId, displayLease: this.displayLease, previewLease: this.heldLease });
    const index = this.retired.findLastIndex(entry => entry.sourceId === oldId);
    const previous = index < 0 ? null : this.retired.splice(index, 1)[0];
    this.shown = previous?.image ?? null; this.shownId = oldId; this.visibleId = oldId; this.shownFrame = previous?.frame ?? null;
    this.shownCoordinates = previous?.coordinates ?? null; this.displayLease = previous?.displayLease ?? null; this.heldLease = previous?.previewLease ?? null;
    if (this.map.getLayer(oldId)) this.setOpacity(oldId, opacity);
    this.releaseRetired();
    return !!this.shown;
  }

  painted(): boolean {
    if (!this.shown) {
      this.releaseRetired();
      return false;
    }
    const source = this.map.getSource(this.shownId) as ImageSourceLike | undefined;
    if (!source) return false;
    if ('image' in source && source.image !== this.shown.bitmap) return false;
    if ('_imageDirty' in source && source._imageDirty !== false) return false;
    if ('texture' in source && !source.texture) return false;
    if ('tiles' in source && source.tiles) {
      const loaded = Object.values(source.tiles).some(tile => tile?.state === 'loaded'
        && (!source.tileID?.equals || !tile.tileID?.canonical || source.tileID.equals(tile.tileID.canonical)));
      if (!loaded) return false;
    }
    if (this.visibleId === this.shownId) this.releaseRetired();
    return true;
  }

  relievePressure(_required = 1): boolean { return false; }

  setTheme(theme: MapTheme): void {
    if (this.theme === theme || this.disposed) return;
    this.theme = theme;
    const context = this.context, selected = this.selected;
    if (context && selected) {
      const { build, layer } = context;
      this.reset(true);
      this.warmingPaused = true;
      this.select(build, layer, selected);
      this.themeWarmTimer = setTimeout(() => {
        this.themeWarmTimer = null;
        if (this.disposed) return;
        this.warmingPaused = false;
        this.pump();
      }, 280);
    }
  }

  refresh(): void {
    const context = this.context;
    if (!context) return;
    if (context.build.expiresAtMs <= Date.now()) { this.clear(); this.onReady(); return; }
    this.pump();
  }
  clear(): void { this.deferred = null; this.reset(false); }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribeBudget?.();
    try { this.clear(); } finally { this.transport?.dispose(); }
  }

  private removeSource(id: string): void {
    let failure: unknown;
    try { if (this.map.getLayer(id)) this.map.removeLayer(id); } catch (error) { failure = error; }
    this.opacities.delete(id);
    try { if (this.map.getSource(id)) this.map.removeSource(id); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }

  private releaseRetired(): void {
    const closed = new Set<Image>();
    let failure: unknown;
    for (const retired of this.retired.splice(0)) {
      if (retired.sourceId !== this.visibleId && retired.sourceId !== this.shownId) {
        try { this.removeSource(retired.sourceId); } catch (error) { failure ??= error; }
      }
      if (!closed.has(retired.image) && retired.image !== this.shown && ![...this.previews.values()].includes(retired.image)) {
        retired.image.bitmap.close(); retired.image.lease?.release();
        closed.add(retired.image);
      }
      retired.displayLease?.release(); retired.previewLease?.release();
    }
    if (failure) throw failure;
  }

  private ensureSelectedPreview(frame: string): void {
    const context = this.context;
    if (!context || this.previews.has(frame) || context.jobs.some(job => job.frame === frame)) return;
    const attempts = this.failureCounts.get(frame) ?? 0;
    if (attempts >= MAX_PREVIEW_ATTEMPTS) return;
    const due = this.retryAfter.get(frame) ?? 0;
    if (!this.retries.has(frame) || Date.now() >= due) {
      if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      this.retries.add(frame);
      this.unavailable.delete(frame);
      context.jobs.push(this.job(frame, context.preview));
      return;
    }
    if (this.retryTimer === null) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.disposed || !this.context || !this.selected) return;
        this.ensureSelectedPreview(this.selected);
        this.pump();
      }, Math.max(0, due - Date.now()));
    }
  }

  private shareLease(lease: PreparationLease, count: number): PreparationLease[] {
    const parts = { n: count };
    return Array.from({ length: count }, (): PreparationLease => {
      let open = true;
      return {
        get bytes() { return open ? lease.bytes : 0; },
        resize: () => false,
        release() { if (!open) return; open = false; if (--parts.n === 0) lease.release(); }
      };
    });
  }

  private reset(keepShown: boolean): void {
    const previous = this.context;
    this.previewEpoch++; this.coverageCache = null;
    for (const job of previous?.jobs ?? []) this.cancelJob(job);
    if (this.context !== previous) return;
    this.context = null; this.selected = null; this.composing = null; this.fetching = 0; this.failedImage = null;
    if (this.expiry !== null) clearTimeout(this.expiry); this.expiry = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer); this.retryTimer = null;
    if (this.themeWarmTimer !== null) clearTimeout(this.themeWarmTimer); this.themeWarmTimer = null;
    this.warmingPaused = false;
    const previewImages = new Set(this.previews.values());
    const ownedShown = !!this.shown && previewImages.has(this.shown);
    const surviving: Image[] = [];
    if (keepShown && this.shown && previewImages.has(this.shown)) surviving.push(this.shown);
    for (const entry of this.retired) if (previewImages.has(entry.image) && !surviving.includes(entry.image)) surviving.push(entry.image);
    for (const image of this.previews.values()) {
      if (surviving.includes(image) || (keepShown && image === this.shown) || this.retired.some(entry => entry.image === image)) continue;
      image.bitmap.close(); image.lease?.release();
    }
    this.previews.clear(); this.unavailable.clear(); this.retries.clear();
    this.failureCounts.clear(); this.retryAfter.clear();
    const previousHeld = this.heldLease;
    let retained: PreparationLease | null = null;
    const group = previous?.previewLease ?? null;
    const uncovered = surviving.filter(image => !image.lease);
    if (group) {
      const bytes = uncovered.reduce((sum, image) => sum + image.bitmap.width * image.bitmap.height * 4, 0);
      if (bytes > 0 && group.resize(bytes)) {
        const shares = this.shareLease(group, uncovered.length);
        for (let index = 0; index < uncovered.length; index++) {
          const image = uncovered[index]!, share = shares[index];
          if (!share) continue;
          if (image === this.shown) retained = share;
          else {
            const retired = this.retired.find(entry => entry.image === image && !entry.previewLease);
            if (retired) retired.previewLease = share; else share.release();
          }
        }
      } else group.release();
    }
    this.heldLease = retained ?? (keepShown && this.shown && !ownedShown ? previousHeld : null);
    if (previousHeld && previousHeld !== this.heldLease) previousHeld.release();
    let failure: unknown;
    if (!(keepShown && this.shown)) {
      retained?.release(); this.heldLease = null;
      if (this.shown && !ownedShown) { this.shown.bitmap.close(); this.shown.lease?.release(); }
      this.shown = null; this.shownFrame = null; this.shownCoordinates = null; this.shownId = this.id; this.visibleId = null;
      this.displayLease?.release(); this.displayLease = null;
      for (const id of [this.id, `${this.id}-stage`]) {
        try { this.removeSource(id); } catch (error) { failure ??= error; }
      }
      try { this.releaseRetired(); } catch (error) { failure ??= error; }
    }
    this.canvasLease?.release(); this.canvasLease = null;
    if (!this.decoding) { this.decodeLease?.release(); this.decodeLease = null; }
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.limited = false;
    if (failure) throw failure;
  }

  private coverage(): { preview: boolean } {
    const context = this.context;
    if (!context) return { preview: false };
    const raw = this.map.getBounds();
    const key = `${raw.getWest()}:${raw.getSouth()}:${raw.getEast()}:${raw.getNorth()}:${this.previewEpoch}`;
    if (this.coverageCache?.key === key) return this.coverageCache;
    const view = bounds(this.map);
    const preview = contains(context.preview, view);
    this.coverageCache = { key, preview };
    return this.coverageCache;
  }
  private covers(): boolean { return this.coverage().preview; }
  private isFrameUsable(frame: string, cov = this.coverage()): boolean {
    return cov.preview && this.previews.has(frame);
  }

  private job(frame: string, crop: RasterCrop): Job {
    const scale = Math.min(1, 256 / Math.max(crop.width, crop.height));
    return { frame, crop, width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale)),
      tiles: crop.tiles.map(() => ({ state: 'waiting' })), failed: false, lease: null };
  }

  private ownsJob(job: Job, context = this.context): boolean {
    return !this.disposed && !!context && context === this.context && !job.failed && context.jobs.includes(job);
  }

  private ordered(jobs: Job[]): Job[] {
    const frames = this.context!.frames, index = frames.indexOf(this.selected ?? '');
    return jobs.sort((a, b) => {
      const deltaA = frames.indexOf(a.frame) - index, deltaB = frames.indexOf(b.frame) - index;
      return Math.abs(deltaA) - Math.abs(deltaB)
        || Number(Math.sign(deltaB) === this.direction) - Number(Math.sign(deltaA) === this.direction);
    });
  }

  private compressedBytes(excludeFrame?: string | null): number {
    let total = 0;
    for (const job of this.context?.jobs ?? []) {
      if (excludeFrame && job.frame === excludeFrame) continue;
      for (const tile of job.tiles) {
        if (tile.state === 'compressed' || tile.state === 'decoding') total += tile.data?.byteLength ?? 0;
      }
    }
    return total;
  }

  private suspendComposition(): void {
    const job = this.composing;
    if (!job || this.decoding > 0) return;
    if (job.tiles.some(tile => tile.state === 'drawn')) {
      job.partial?.close();
      job.partial = undefined;
      try { job.partial = this.canvas!.transferToImageBitmap(); }
      catch { this.fail(job); return; }
    }
    this.composing = null;
  }

  private pump(): void {
    const context = this.context;
    if (!context || this.disposed || context.build.expiresAtMs <= Date.now()) return;
    const version = ++this.pumpVersion;
    const current = () => this.context === context && this.pumpVersion === version && !this.disposed;
    const jobs = this.ordered(context.jobs.filter(job => !job.failed));
    const maxActive = this.options.requestLimits?.maxActive ?? 24;
    const maxBackground = this.options.requestLimits?.maxPrefetchActive ?? 20;
    const maxPendingBytes = maxActive * MAX_TILE_BYTES;
    const maxBackgroundBytes = Math.max(maxBackground, maxActive - SELECTED_PREVIEW_SLOTS) * MAX_TILE_BYTES;
    const inFlightReserve = 16 * 1024;
    let selectedFetching = 0;
    for (const job of jobs) if (job.frame === this.selected) for (const tile of job.tiles) if (tile.state === 'fetching') selectedFetching++;
    for (const job of jobs) {
      if (!current()) return;
      if (!this.ownsJob(job, context)) continue;
      const isSelected = job.frame === this.selected;
      while (this.ownsJob(job, context) && job.tiles.some(tile => tile.state === 'waiting')) {
        if (this.fetching >= maxActive || this.fetching * inFlightReserve + this.compressedBytes() + inFlightReserve > maxPendingBytes) break;
        if (isSelected) {
          if (this.compressedBytes() >= maxPendingBytes) break;
        } else {
          if (this.warmingPaused) break;
          if (this.fetching - selectedFetching >= maxBackground) break;
          if ((this.fetching - selectedFetching) * inFlightReserve + this.compressedBytes(this.selected) + inFlightReserve > maxBackgroundBytes) break;
        }
        if (!context.previewLease && !job.lease && this.options.budget) {
          const priority = isSelected ? 'foreground' : 'background';
          job.lease = this.options.budget.reserve('raster-preview', 256 * 256 * 4, priority);
          if (!job.lease) { this.markLimited(); break; }
        }
        const index = job.tiles.findIndex(tile => tile.state === 'waiting');
        if (isSelected) selectedFetching++;
        this.fetch(job, index);
        if (!current()) return;
      }
    }
    if (!current()) return;
    const readyToCompose = (candidate: Job) => this.ownsJob(candidate, context)
      && candidate.tiles.some(tile => tile.state === 'compressed')
      && candidate.tiles.every(tile => tile.state === 'compressed' || tile.state === 'drawn');
    const nextReady = jobs.find(readyToCompose) ?? null;
    if (this.composing && this.decoding === 0) {
      if (this.composing.tiles.every(tile => tile.state === 'drawn')) {
        this.finish(this.composing);
        return;
      }
      const stalled = !this.composing.tiles.some(tile => tile.state === 'compressed');
      const preempted = !!nextReady && nextReady !== this.composing && jobs.indexOf(nextReady) < jobs.indexOf(this.composing);
      if (stalled || preempted) this.suspendComposition();
    }
    if (!current()) return;
    if (!this.composing) {
      const next = jobs.find(readyToCompose);
      if (next && this.startComposition(next) && current() && this.ownsJob(next, context)) this.composing = next;
    }
    if (!current()) return;
    const job = this.composing;
    if (!job || !this.ownsJob(job, context)) {
      this.composing = null;
      if (!this.decoding) { this.decodeLease?.release(); this.decodeLease = null; }
      return;
    }
    while (this.decoding < 4) {
      const index = job.tiles.findIndex(tile => tile.state === 'compressed');
      if (index < 0) break;
      this.decode(job, index);
    }
    if (job.tiles.every(tile => tile.state === 'drawn')) this.finish(job);
    else if (this.decoding === 0 && !job.tiles.some(tile => tile.state === 'compressed')) this.suspendComposition();
  }

  private startComposition(job: Job): boolean {
    const context = this.context, version = this.pumpVersion;
    if (!this.ownsJob(job, context) || !job.tiles.every(tile => tile.state === 'compressed' || tile.state === 'drawn')) return false;
    const budget = this.options.budget, bytes = job.width * job.height * 4;
    const priority = job.frame === this.selected ? 'foreground' : 'background';
    if (budget) {
      const needed = Math.max(0, bytes - (this.canvasLease?.bytes ?? 0)) + (this.decodeLease ? 0 : DECODE_LEASE_BYTES);
      if (!budget.canReserve(needed, priority) || needed > budget.limit - budget.used) {
        if (!this.ownsJob(job, context) || this.pumpVersion !== version) return false;
        if (!budget.canReserve(needed, priority) || needed > budget.limit - budget.used) { this.markLimited(); return false; }
      }
      if (!this.canvasLease) {
        this.canvasLease = budget.reserve('raster-canvas', bytes, priority);
      } else if (!this.canvasLease.resize(bytes)) {
        if (priority === 'foreground') {
          const previousBytes = this.canvasLease.bytes;
          this.canvasLease.release();
          this.canvasLease = budget.reserve('raster-canvas', bytes, 'foreground') ?? budget.reserve('raster-canvas', previousBytes, 'background');
          if (!this.canvasLease || this.canvasLease.bytes !== bytes) { this.markLimited(); return false; }
        } else {
          this.markLimited();
          return false;
        }
      }
      if (!this.decodeLease) this.decodeLease = budget.reserve('raster-decode', DECODE_LEASE_BYTES, priority);
      if (!this.canvasLease || !this.decodeLease) { this.markLimited(); return false; }
    }
    try {
      this.canvas!.width = job.width; this.canvas!.height = job.height;
      const ctx = this.canvas!.getContext('2d')!;
      ctx.clearRect(0, 0, job.width, job.height);
      if (job.partial) {
        try { ctx.drawImage(job.partial, 0, 0, job.width, job.height); }
        finally { job.partial.close(); job.partial = undefined; }
      }
    } catch {
      this.fail(job);
      return false;
    }
    return true;
  }

  private fetch(job: Job, index: number): void {
    const context = this.context, tile = job.tiles[index], location = job.crop.tiles[index];
    if (!context || !this.ownsJob(job, context) || tile.state !== 'waiting') return;
    const url = frameTileUrl(context.build.templates[context.layer], job.frame).replaceAll('{z}', String(location.z)).replaceAll('{x}', String(location.canonicalX)).replaceAll('{y}', String(location.y));
    tile.state = 'fetching'; this.fetching++;
    let response: Promise<{ data: ArrayBuffer; release?: () => void }>;
    try {
      if (typeof this.protocol.requestTile === 'function') {
        tile.handle = this.protocol.requestTile(url, { priority: job.frame === this.selected ? 'foreground' : 'background' });
        response = tile.handle.response;
      } else {
        const controller = new AbortController();
        response = this.protocol.load({ url: this.transport!.url(url) }, controller);
        tile.handle = { response: response as RasterTileHandle['response'], promote() {}, cancel: () => controller.abort() };
      }
    } catch {
      this.finishFetch(tile);
      this.fail(job);
      return;
    }
    if (!this.ownsJob(job, context)) tile.handle?.cancel();
    void response.then(value => {
      this.finishFetch(tile); tile.handle = undefined;
      if (!this.ownsJob(job, context)) { value.release?.(); return; }
      if (value.data.byteLength > MAX_TILE_BYTES) { value.release?.(); this.fail(job); return; }
      tile.data = value.data; tile.release = value.release; tile.state = 'compressed'; this.pump();
    }).catch(() => {
      this.finishFetch(tile); tile.handle = undefined;
      this.fail(job);
    });
  }

  private finishFetch(tile: Tile): void {
    if (tile.state !== 'fetching') return;
    tile.state = 'waiting'; this.fetching--;
  }

  private decode(job: Job, index: number): void {
    const context = this.context, tile = job.tiles[index], data = tile.data;
    if (!context || !this.ownsJob(job, context) || this.composing !== job || tile.state !== 'compressed' || !data) return;
    tile.state = 'decoding'; this.decoding++;
    const location = job.crop.tiles[index], theme = this.theme;
    const priority = job.frame === this.selected ? 'foreground' : 'background';
    const prepareBitmap = async (): Promise<ImageBitmap | null> => {
      let maskData: ArrayBuffer | null = null;
      if (context.layer === 'usable-lift-msl' && context.build.templates['usable-lift-agl'] && typeof this.protocol.requestTile === 'function') {
        const aglUrl = frameTileUrl(context.build.templates['usable-lift-agl'], job.frame)
          .replaceAll('{z}', String(location.z)).replaceAll('{x}', String(location.canonicalX)).replaceAll('{y}', String(location.y));
        const maskRes = await this.protocol.requestTile(aglUrl, { priority }).response.catch(() => null);
        if (maskRes) { maskData = maskRes.data; maskRes.release(); }
      }
      if (!this.ownsJob(job, context)) return null;
      return remapTileToBitmap(data, context.layer === 'precip-rate' ? 'rain' : 'lift', theme, maskData, { priority });
    };
    void Promise.resolve().then(() => {
      if (!this.ownsJob(job, context)) return null;
      if (theme === 'classic' || data.byteLength <= 48 || !canRemapTiles()) return createImageBitmap(new Blob([data], { type: 'image/webp' }));
      return prepareBitmap();
    }).then(image => {
      if (!image) return;
      if (!this.ownsJob(job, context) || image.width !== RASTER_TILE_SIZE || image.height !== RASTER_TILE_SIZE) {
        image.close(); this.fail(job); return;
      }
      const location = job.crop.tiles[index], sx = job.width / job.crop.width, sy = job.height / job.crop.height;
      try { this.canvas!.getContext('2d')!.drawImage(image, location.drawX * sx, location.drawY * sy, RASTER_TILE_SIZE * sx, RASTER_TILE_SIZE * sy); }
      finally { image.close(); }
      tile.state = 'drawn';
    }).catch(() => this.fail(job))
      .finally(() => {
        tile.release?.(); tile.release = undefined; tile.data = undefined; this.decoding--;
        if (job.failed) tile.state = 'cancelled';
        if (!this.context && !this.decoding) { this.decodeLease?.release(); this.decodeLease = null; }
        this.pump();
      });
  }

  private finish(job: Job): void {
    const context = this.context;
    if (!context || !this.ownsJob(job, context) || this.composing !== job) return;
    job.partial?.close(); job.partial = undefined;
    let bitmap: ImageBitmap;
    try { bitmap = this.canvas!.transferToImageBitmap(); }
    catch { this.fail(job); return; }
    const image = { bitmap, lease: job.lease };
    job.lease = null;
    this.previews.set(job.frame, image);
    this.unavailable.delete(job.frame);
    this.failureCounts.delete(job.frame);
    this.retryAfter.delete(job.frame);
    context.jobs = context.jobs.filter(value => value !== job);
    this.composing = null;
    if (!this.decoding) { this.decodeLease?.release(); this.decodeLease = null; }
    this.onReady(); this.pump();
  }

  private cancelJob(job: Job): void {
    if (job.failed) return;
    job.failed = true;
    for (const tile of job.tiles) this.finishFetch(tile);
    if (this.composing === job) this.composing = null;
    for (const tile of job.tiles) {
      const handle = tile.handle; tile.handle = undefined;
      handle?.cancel();
      if (tile.state !== 'decoding') { tile.state = 'cancelled'; tile.release?.(); tile.release = undefined; tile.data = undefined; }
    }
    job.partial?.close(); job.partial = undefined;
    job.lease?.release(); job.lease = null;
  }

  private fail(job: Job): void {
    const context = this.context;
    if (!context || !this.ownsJob(job, context)) return;
    this.cancelJob(job);
    if (context !== this.context || this.disposed) return;
    context.jobs = context.jobs.filter(value => value !== job);
    const attempts = (this.failureCounts.get(job.frame) ?? 0) + 1;
    this.failureCounts.set(job.frame, attempts);
    if (job.frame === this.selected && !this.retries.has(job.frame)) {
      this.retries.add(job.frame);
      this.unavailable.delete(job.frame);
      context.jobs.push(this.job(job.frame, job.crop));
    } else {
      this.unavailable.add(job.frame);
      if (attempts < MAX_PREVIEW_ATTEMPTS) {
        this.retryAfter.set(job.frame, Date.now() + PREVIEW_RETRY_COOLDOWN_MS);
        if (job.frame === this.selected) this.ensureSelectedPreview(job.frame);
      }
    }
    this.onReady(); this.pump();
  }

  private markLimited(): void {
    if (this.limited) return;
    this.limited = true;
    queueMicrotask(() => { if (!this.disposed && this.limited) this.onReady(); });
  }
}
