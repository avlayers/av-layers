import type { Map } from 'maplibre-gl';
import { clampOpacity, frameTileUrl, layerMaxZoom, previewRasterLayer, seamInsertBefore, type PinnedBuild, type PreparationBudget, type PreparationLease, type RasterTileHandle, type RasterTileSourceProtocol, type RasterTileSourceTransport } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { MAX_TILE_BYTES, RASTER_TILE_SIZE } from '@av/contracts/format';
import { boundsAreaKm2, createViewportWarmth } from '../map/viewport-policy';
import { planRasterCrop, requiredSourceZoom, type RasterCrop } from './raster-crop';

export { FOCUS_DWELL_MS } from '../map/viewport-policy';

type Quality = 'overview' | 'detail';
type Coordinates = [[number, number], [number, number], [number, number], [number, number]];
interface Image { bitmap: ImageBitmap; lease: PreparationLease | null }
interface Retired { image: Image; frame: string | null; coordinates: Coordinates | null; sourceId: string; displayLease: PreparationLease | null; previewLease: PreparationLease | null }
interface Tile {
  state: 'waiting' | 'fetching' | 'compressed' | 'decoding' | 'drawn';
  handle?: RasterTileHandle;
  data?: ArrayBuffer;
  release?: () => void;
}
interface Job {
  frame: string;
  quality: Quality;
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
  native: RasterCrop | null;
  requiredZoom: number | null;
  previewZoom: number;
  warmed: boolean;
  jobs: Job[];
  previewLease: PreparationLease | null;
  nativeScheduled: boolean;
  nativeWindowed: boolean;
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
export interface RasterOverviewState { ready: number; total: number; failed: number }
export interface RasterOverviewReadiness { previewReadyFrames: readonly string[]; detailReadyFrames: readonly string[]; limited: boolean }
export interface RasterOverviewOptions { budget?: PreparationBudget; protectedBytes?: () => number; canExpandNative?: () => boolean; requestLimits?: { maxActive: number; maxPrefetchActive: number } }

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
  private readonly warmth = createViewportWarmth();
  private readonly previews = new globalThis.Map<string, Image>();
  private readonly natives = new globalThis.Map<string, Image>();
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
  private canvasLease: PreparationLease | null = null;
  private decodeLease: PreparationLease | null = null;
  private composing: Job | null = null;
  private fetching = 0;
  private decoding = 0;
  private previewEpoch = 0;
  private nativeEpoch = 0;
  private coverageCache: { key: string; preview: boolean; native: boolean } | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeRested = false;
  private playing = false;
  private disposed = false;
  private limited = false;
  private deferred: { build: PinnedBuild; layer: LayerId; frame: string } | null = null;
  private readonly unsubscribeBudget: (() => void) | null;

  constructor(private readonly map: Map, private readonly protocol: RasterTileSourceProtocol, private readonly onReady: () => void, private readonly options: RasterOverviewOptions = {}) {
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
      detailReadyFrames: cov.native ? frames.filter(frame => this.natives.has(frame)) : [],
      limited: this.limited
    };
  }

  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (!this.supported || this.disposed) return;
    const frames = renderedFrames(build.manifest).map(value => value.id);
    if (build.expiresAtMs <= Date.now() || !build.templates[layer] || !frames.includes(frame)) { this.clear(); return; }
    const view = bounds(this.map), maxzoom = layerMaxZoom(build.manifest, layer);
    const required = canonicalZoom(this.map, maxzoom);
    const previewZoom = required ?? Math.max(0, Math.min(maxzoom, Math.round(this.map.getZoom())));
    const warmed = this.warmth.update(boundsAreaKm2(view));
    const preview = previewCrop(view, previewZoom);
    const previewHeld = !!this.context && !!preview && this.context.build === build && this.context.layer === layer
      && contains(this.context.preview, view)
      && Math.abs(preview.zoom - this.context.preview.zoom) <= 1;
    if (!previewHeld) {
      this.reset(true);
      if (!preview) { this.selected = frame; this.limited = true; this.onReady(); return; }
      const native = warmed && required !== null ? planRasterCrop(view, required) : null;
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
      this.context = { build, layer, frames, preview, native, requiredZoom: required, previewZoom, warmed, jobs: [], previewLease, nativeScheduled: false, nativeWindowed: false };
      this.protocol.setBuildExpiry(build.manifest.buildId, build.expiresAtMs);
      this.expiry = setTimeout(() => this.refresh(), Math.min(build.expiresAtMs - Date.now(), 2_147_000_000));
      for (const id of frames) this.context.jobs.push(this.job(id, 'overview', preview));
    } else {
      const context = this.context!;
      const nativeMissing = warmed && required !== null && !context.native;
      const nativeMoved = !!context.native && !contains(context.native, view);
      if (context.requiredZoom !== required || context.warmed !== warmed || nativeMissing || nativeMoved) {
        this.invalidateNative(required, previewZoom, warmed && required !== null ? planRasterCrop(view, required) : null, warmed);
      } else if (context.previewZoom !== previewZoom) {
        context.previewZoom = previewZoom; this.coverageCache = null;
      }
    }
    if (this.selected !== frame) {
      if (this.selected) this.direction = frames.indexOf(frame) > frames.indexOf(this.selected) ? 1 : -1;
      this.nativeRested = false;
      if (this.nativeTimer !== null) clearTimeout(this.nativeTimer);
      this.nativeTimer = this.playing ? null : setTimeout(() => { this.nativeTimer = null; this.nativeRested = true; this.pump(); }, 100);
    }
    this.selected = frame;
    this.ensureSelectedPreview(frame);
    const active = this.context;
    if (!active) return;
    if (active.nativeWindowed) this.updateNativeWindow();
    if (active.nativeScheduled && active.native && this.previews.has(frame) && !this.natives.has(frame) && !active.jobs.some(job => job.quality === 'detail' && job.frame === frame)) {
      active.jobs.push(this.job(frame, 'detail', active.native));
    }
    for (const job of active.jobs) if (job.frame === frame) for (const tile of job.tiles) tile.handle?.promote();
    this.pump();
  }

  setPlayback(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing; this.nativeRested = false;
    if (this.nativeTimer !== null) clearTimeout(this.nativeTimer);
    this.nativeTimer = !playing && this.selected ? setTimeout(() => { this.nativeTimer = null; this.nativeRested = true; this.pump(); }, 100) : null;
  }
  coversView(): boolean { return this.covers() && (!this.context?.native || contains(this.context.native, bounds(this.map))); }
  hasExtent(): boolean { return this.context !== null; }

  ready(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    return !this.disposed && this.context?.build === build && this.context.layer === layer && build.expiresAtMs > Date.now() && this.isFrameUsable(frame);
  }

  quality(build: PinnedBuild, layer: LayerId, frame: string): Quality | null {
    if (!this.ready(build, layer, frame)) return null;
    if (this.shownFrame === frame && this.shown === this.previews.get(frame) && this.natives.has(frame)) return 'overview';
    return this.natives.has(frame) && this.nativeCovers() ? 'detail' : 'overview';
  }

  needsUpdate(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    if (!this.ready(build, layer, frame)) return false;
    const preview = this.previews.get(frame), native = this.nativeCovers() ? this.natives.get(frame) : undefined;
    const image = native && (native === this.shown || !preview || !this.options.budget
      || this.options.budget.canReserve(native.bitmap.width * native.bitmap.height * 8, 'background')) ? native : preview;
    return !!image && image !== this.shown;
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
    if (!this.ready(build, layer, frame)) return false;
    const native = this.nativeCovers() ? this.natives.get(frame) : undefined;
    const preview = this.previews.get(frame);
    let image = native ?? preview;
    if (!image) return false;
    let coordinates = image === native ? this.context!.native!.coordinates : this.context!.preview.coordinates;
    let displayLease: PreparationLease | null = null;
    if (this.shown !== image) {
      const displayPriority = image === native && preview ? 'background' : 'foreground';
      displayLease = this.options.budget?.reserve('raster-display', image.bitmap.width * image.bitmap.height * 8, displayPriority) ?? null;
      if (this.options.budget && !displayLease && image === native && preview) {
        this.markLimited();
        image = preview;
        coordinates = this.context!.preview.coordinates;
        if (this.shown !== image) {
          displayLease = this.options.budget.reserve('raster-display', image.bitmap.width * image.bitmap.height * 8, 'foreground');
        }
      }
      if (this.shown !== image && this.options.budget && !displayLease) { this.markLimited(); return false; }
    }
    const targetId = this.shown !== image && this.visibleId === this.shownId ? (this.shownId === this.id ? `${this.id}-stage` : this.id) : this.shownId;
    const created = !this.map.getSource(targetId);
    if (created) {
      this.map.addSource(targetId, { type: 'image', coordinates });
      this.map.addLayer({ ...previewRasterLayer(0), id: targetId, source: targetId, paint: { ...previewRasterLayer(0).paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } }, seamInsertBefore(this.map));
      this.opacities.set(targetId, 0);
    }
    const source = this.map.getSource(targetId) as ImageSourceLike | undefined;
    if (this.shown !== image) {
        try {
          source?.updateImage?.({ image: image.bitmap, coordinates });
          if (created) source?.setCoordinates?.(coordinates);
        } catch (error) { displayLease?.release(); throw error; }
        if (this.shown) this.retired.push({ image: this.shown, frame: this.shownFrame, coordinates: this.shownCoordinates, sourceId: this.shownId, displayLease: this.displayLease, previewLease: this.heldLease });
        this.heldLease = null; this.displayLease = displayLease;
        this.shown = image; this.shownId = targetId; this.shownFrame = frame; this.shownCoordinates = coordinates;
    } else if (this.shownCoordinates !== coordinates) {
      source?.setCoordinates?.(coordinates);
      this.shownCoordinates = coordinates;
    }
    this.setOpacity(targetId, opacity);
    if (opacity > 0) {
      if (this.visibleId && this.visibleId !== targetId && this.map.getLayer(this.visibleId)) this.setOpacity(this.visibleId, 0);
      this.visibleId = targetId;
    }
    return true;
  }

  hide(): void { for (const id of [this.id, `${this.id}-stage`]) if (this.map.getLayer(id)) this.setOpacity(id, 0); this.visibleId = null; }

  private setOpacity(id: string, value: number): void {
    const opacity = clampOpacity(value);
    if (this.opacities.get(id) === opacity) return;
    this.opacities.set(id, opacity);
    this.map.setPaintProperty(id, 'raster-opacity', opacity);
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

  relievePressure(required = 1): boolean {
    const budget = this.options.budget, context = this.context;
    if (!budget || !context) return false;
    const before = budget.used;
    this.evictNative(required);
    return budget.used < before;
  }

  refresh(): void {
    const context = this.context;
    if (!context) return;
    if (context.build.expiresAtMs <= Date.now()) { this.clear(); this.onReady(); return; }
    if (this.options.budget) {
      const protectedBytes = Math.max(0, this.options.protectedBytes?.() ?? 0);
      if (!this.nativeAdmitted(protectedBytes)) this.evictNative(protectedBytes);
    }
    if (context.native && this.options.canExpandNative?.() === false && context.nativeScheduled && !context.nativeWindowed) {
      context.nativeWindowed = true; this.updateNativeWindow();
    }
    if (context.native && this.allAxisUsable(context) && !context.jobs.some(job => job.quality === 'overview')) {
      if (!context.nativeScheduled) {
        this.scheduleNative(context);
      } else if (context.nativeWindowed && this.options.canExpandNative?.() !== false) {
        const protectedBytes = Math.max(0, this.options.protectedBytes?.() ?? 0);
        const nativeBytes = context.native.width * context.native.height * 4;
        const unreserved = context.frames.filter(frame => !this.natives.has(frame) && !context.jobs.some(job => job.quality === 'detail' && job.frame === frame && job.lease)).length;
        const staging = Math.max(0, nativeBytes - (this.canvasLease?.bytes ?? 0)) + 8 * MAX_TILE_BYTES * 2;
        if (this.nativeAdmitted(unreserved * nativeBytes + protectedBytes + staging)) {
          context.nativeWindowed = false;
          for (const frame of context.frames) if (!this.natives.has(frame) && !context.jobs.some(job => job.quality === 'detail' && job.frame === frame)) context.jobs.push(this.job(frame, 'detail', context.native));
        } else {
          this.updateNativeWindow();
        }
      }
    }
    this.pump();
  }
  clear(): void { this.deferred = null; this.reset(false); }
  destroy(): void { this.disposed = true; this.unsubscribeBudget?.(); this.clear(); this.transport?.dispose(); }

  private releaseRetired(): void {
    const closed = new Set<Image>();
    for (const retired of this.retired.splice(0)) {
      if (retired.sourceId !== this.visibleId && retired.sourceId !== this.shownId) {
        if (this.map.getLayer(retired.sourceId)) this.map.removeLayer(retired.sourceId);
        this.opacities.delete(retired.sourceId);
        if (this.map.getSource(retired.sourceId)) this.map.removeSource(retired.sourceId);
      }
      if (!closed.has(retired.image) && retired.image !== this.shown && ![...this.previews.values(), ...this.natives.values()].includes(retired.image)) {
        retired.image.bitmap.close(); retired.image.lease?.release();
        closed.add(retired.image);
      }
      retired.displayLease?.release(); retired.previewLease?.release();
    }
  }

  private ensureSelectedPreview(frame: string): void {
    const context = this.context;
    if (!context || this.previews.has(frame) || context.jobs.some(job => job.quality === 'overview' && job.frame === frame)) return;
    const attempts = this.failureCounts.get(frame) ?? 0;
    if (attempts >= MAX_PREVIEW_ATTEMPTS) return;
    const due = this.retryAfter.get(frame) ?? 0;
    if (!this.retries.has(frame) || Date.now() >= due) {
      if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      this.retries.add(frame);
      this.unavailable.delete(frame);
      context.jobs.push(this.job(frame, 'overview', context.preview));
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

  private invalidateNative(required: number | null, previewZoom: number, native: RasterCrop | null, warmed: boolean): void {
    const context = this.context;
    if (!context) return;
    this.nativeEpoch++;
    this.coverageCache = null;
    for (const job of [...context.jobs]) {
      if (job.quality !== 'detail') continue;
      this.cancelJob(job);
      context.jobs = context.jobs.filter(value => value !== job);
    }
    for (const [frame, image] of [...this.natives]) {
      this.natives.delete(frame);
      if (image === this.shown || this.retired.some(entry => entry.image === image)) continue;
      image.bitmap.close(); image.lease?.release();
    }
    context.requiredZoom = required; context.previewZoom = previewZoom; context.native = native; context.warmed = warmed;
    context.nativeScheduled = false; context.nativeWindowed = false;
  }

  private reset(keepShown: boolean): void {
    this.previewEpoch++; this.nativeEpoch++; this.coverageCache = null;
    for (const job of this.context?.jobs ?? []) {
      job.failed = true;
      for (const tile of job.tiles) {
        tile.handle?.cancel();
        if (tile.state !== 'decoding') { tile.release?.(); tile.release = undefined; tile.data = undefined; }
      }
      job.partial?.close(); job.partial = undefined;
      job.lease?.release();
    }
    const previous = this.context;
    this.context = null; this.selected = null; this.composing = null; this.fetching = 0;
    if (this.expiry !== null) clearTimeout(this.expiry); this.expiry = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer); this.retryTimer = null;
    if (this.nativeTimer !== null) clearTimeout(this.nativeTimer); this.nativeTimer = null; this.nativeRested = false;
    const previewImages = new Set(this.previews.values());
    const ownedShown = !!this.shown && [...this.previews.values(), ...this.natives.values()].includes(this.shown);
    const surviving: Image[] = [];
    if (keepShown && this.shown && previewImages.has(this.shown)) surviving.push(this.shown);
    for (const entry of this.retired) if (previewImages.has(entry.image) && !surviving.includes(entry.image)) surviving.push(entry.image);
    for (const image of [...this.previews.values(), ...this.natives.values()]) {
      if (surviving.includes(image) || (keepShown && image === this.shown) || this.retired.some(entry => entry.image === image)) continue;
      image.bitmap.close(); image.lease?.release();
    }
    this.previews.clear(); this.natives.clear(); this.unavailable.clear(); this.retries.clear();
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
    this.heldLease = retained;
    if (previousHeld && previousHeld !== retained) previousHeld.release();
    if (!(keepShown && this.shown)) {
      retained?.release(); this.heldLease = null;
      if (this.shown && !ownedShown) { this.shown.bitmap.close(); this.shown.lease?.release(); }
      this.shown = null; this.shownFrame = null; this.shownCoordinates = null; this.shownId = this.id; this.visibleId = null;
      this.displayLease?.release(); this.displayLease = null;
      for (const id of [this.id, `${this.id}-stage`]) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
        this.opacities.delete(id);
        if (this.map.getSource(id)) this.map.removeSource(id);
      }
      this.releaseRetired();
    }
    this.canvasLease?.release(); this.canvasLease = null;
    if (!this.decoding) { this.decodeLease?.release(); this.decodeLease = null; }
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.limited = false;
  }

  private coverage(): { preview: boolean; native: boolean } {
    const context = this.context;
    if (!context) return { preview: false, native: false };
    const zoom = this.map.getZoom(), raw = this.map.getBounds();
    const canonical = canonicalZoom(this.map, layerMaxZoom(context.build.manifest, context.layer));
    const key = `${zoom}:${canonical}:${raw.getWest()}:${raw.getSouth()}:${raw.getEast()}:${raw.getNorth()}:${context.requiredZoom}:${context.preview.zoom}:${context.preview.left}:${context.preview.top}:${context.native?.zoom ?? ''}:${context.native?.left ?? ''}:${context.warmed}:${this.previewEpoch}:${this.nativeEpoch}`;
    if (this.coverageCache?.key === key) return this.coverageCache;
    const view = bounds(this.map);
    const preview = contains(context.preview, view);
    const native = !!context.native && context.requiredZoom !== null && canonical === context.requiredZoom && contains(context.native, view);
    this.coverageCache = { key, preview, native };
    return this.coverageCache;
  }
  private covers(): boolean { return this.coverage().preview; }
  private nativeCovers(): boolean { return this.coverage().native; }
  private isFrameUsable(frame: string, cov = this.coverage()): boolean {
    return (cov.preview && this.previews.has(frame)) || (cov.native && this.natives.has(frame));
  }
  private allAxisUsable(context: Context): boolean {
    const cov = this.coverage();
    return context.frames.every(frame => this.isFrameUsable(frame, cov));
  }

  private job(frame: string, quality: Quality, crop: RasterCrop): Job {
    const scale = quality === 'overview' ? Math.min(1, 256 / Math.max(crop.width, crop.height)) : 1;
    return { frame, quality, crop, width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale)),
      tiles: crop.tiles.map(() => ({ state: 'waiting' })), failed: false, lease: null };
  }

  private ordered(jobs: Job[]): Job[] {
    const frames = this.context!.frames, index = frames.indexOf(this.selected ?? '');
    const rank = (job: Job, delta: number) => job.quality === 'overview' ? delta === 0 ? 0 : Math.abs(delta) <= 2 ? 2 : 4
      : delta === 0 ? 1 : Math.abs(delta) <= 2 ? 3 : 5;
    return jobs.sort((a, b) => {
      const deltaA = frames.indexOf(a.frame) - index, deltaB = frames.indexOf(b.frame) - index;
      return rank(a, deltaA) - rank(b, deltaB) || Math.abs(deltaA) - Math.abs(deltaB)
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

  private scheduleNative(context: Context): void {
    if (!context.native || context.nativeScheduled) return;
    context.nativeScheduled = true;
    if (this.options.canExpandNative?.() === false) { context.nativeWindowed = true; this.updateNativeWindow(); return; }
    const nativeBytes = context.native.width * context.native.height * 4;
    const budget = this.options.budget;
    const protectedBytes = Math.max(0, this.options.protectedBytes?.() ?? 0);
    const staging = Math.max(0, nativeBytes - (this.canvasLease?.bytes ?? 0)) + 8 * MAX_TILE_BYTES * 2;
    context.nativeWindowed = !!budget && !this.nativeAdmitted(nativeBytes * context.frames.length + protectedBytes + staging);
    if (context.nativeWindowed) { this.markLimited(); this.updateNativeWindow(); }
    else for (const frame of context.frames) if (!this.natives.has(frame) && !context.jobs.some(job => job.quality === 'detail' && job.frame === frame)) context.jobs.push(this.job(frame, 'detail', context.native));
  }

  private suspendComposition(): void {
    const job = this.composing;
    if (!job || this.decoding > 0) return;
    if (job.tiles.some(tile => tile.state === 'drawn')) {
      job.partial?.close();
      job.partial = this.canvas!.transferToImageBitmap();
    }
    this.composing = null;
  }

  private pump(): void {
    const context = this.context;
    if (!context || this.disposed || context.build.expiresAtMs <= Date.now()) return;
    if (this.options.budget) {
      const protectedBytes = Math.max(0, this.options.protectedBytes?.() ?? 0);
      if (!this.nativeAdmitted(protectedBytes)) this.evictNative(protectedBytes);
    }
    if (context.native && this.options.canExpandNative?.() === false && context.nativeScheduled && !context.nativeWindowed) {
      context.nativeWindowed = true; this.updateNativeWindow();
    }
    if (context.native && this.nativeRested && !this.playing) {
      if (!context.nativeScheduled && this.allAxisUsable(context)) {
        this.scheduleNative(context);
      } else if (!context.nativeScheduled && this.selected) {
        const index = context.frames.indexOf(this.selected);
        for (const frame of context.frames.slice(Math.max(0, index - 2), index + 3)) {
          if (this.previews.has(frame) && !this.natives.has(frame) && !context.jobs.some(job => job.quality === 'detail' && job.frame === frame)) context.jobs.push(this.job(frame, 'detail', context.native));
        }
      }
    }
    const jobs = this.ordered(context.jobs.filter(job => !job.failed));
    const maxActive = this.options.requestLimits?.maxActive ?? 24;
    const maxBackground = this.options.requestLimits?.maxPrefetchActive ?? 20;
    const maxPendingBytes = maxActive * MAX_TILE_BYTES;
    const maxBackgroundBytes = (maxActive - SELECTED_PREVIEW_SLOTS) * MAX_TILE_BYTES;
    let selectedFetching = 0;
    for (const job of jobs) if (job.frame === this.selected) for (const tile of job.tiles) if (tile.state === 'fetching') selectedFetching++;
    for (const job of jobs) {
      const isSelected = job.frame === this.selected;
      if (job.quality === 'detail' && (!this.nativeRested || this.playing)) continue;
      while (job.tiles.some(tile => tile.state === 'waiting')) {
        if (this.fetching >= maxActive || this.fetching * MAX_TILE_BYTES + this.compressedBytes() + MAX_TILE_BYTES > maxPendingBytes) break;
        if (job.quality === 'detail' && jobs.some(other => other.quality === 'overview')
          && jobs.filter(other => other.quality === 'detail').flatMap(other => other.tiles).filter(tile => tile.state === 'fetching').length >= SELECTED_PREVIEW_SLOTS) break;
        if (isSelected) {
          if (this.compressedBytes() >= maxPendingBytes) break;
        } else {
          if (this.fetching - selectedFetching >= maxBackground) break;
          if ((this.fetching - selectedFetching) * MAX_TILE_BYTES + this.compressedBytes(this.selected) + MAX_TILE_BYTES > maxBackgroundBytes) break;
        }
        if (job.quality === 'overview' && !context.previewLease && !job.lease && this.options.budget) {
          const priority = isSelected ? 'foreground' : 'background';
          job.lease = this.options.budget.reserve('raster-preview', 256 * 256 * 4, priority);
          if (!job.lease) { this.markLimited(); break; }
        }
        if (job.quality === 'detail' && !job.lease && this.options.budget) {
          const bytes = job.width * job.height * 4;
          const protectedBytes = Math.max(0, this.options.protectedBytes?.() ?? 0);
          const decodeBytes = this.decodeLease ? 0 : DECODE_LEASE_BYTES;
          const staging = Math.max(0, bytes - (this.canvasLease?.bytes ?? 0)) + decodeBytes;
          const required = bytes + staging + protectedBytes;
          if (isSelected) this.evictNative(required);
          if (!this.nativeAdmitted(required)) {
            this.markLimited();
            break;
          }
          job.lease = this.options.budget.reserve('raster-native', bytes, 'background');
          if (!job.lease) { this.markLimited(); break; }
        }
        const index = job.tiles.findIndex(tile => tile.state === 'waiting');
        if (isSelected) selectedFetching++;
        this.fetch(job, index);
      }
    }
    const readyToCompose = (candidate: Job) => candidate.tiles.some(tile => tile.state === 'compressed');
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
    if (!this.composing) {
      const next = jobs.find(readyToCompose);
      if (next && this.startComposition(next)) this.composing = next;
    }
    const job = this.composing;
    if (!job) {
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
    const budget = this.options.budget, bytes = job.width * job.height * 4;
    const priority = job.quality === 'overview' && job.frame === this.selected ? 'foreground' : 'background';
    if (budget) {
      const needed = Math.max(0, bytes - (this.canvasLease?.bytes ?? 0)) + (this.decodeLease ? 0 : DECODE_LEASE_BYTES);
      if (!budget.canReserve(needed, priority) || needed > budget.limit - budget.used) {
        if (priority === 'foreground') this.evictNative(needed + Math.max(0, this.options.protectedBytes?.() ?? 0));
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
    this.canvas!.width = job.width; this.canvas!.height = job.height;
    const ctx = this.canvas!.getContext('2d')!;
    ctx.clearRect(0, 0, job.width, job.height);
    if (job.partial) {
      try { ctx.drawImage(job.partial, 0, 0, job.width, job.height); }
      finally { job.partial.close(); job.partial = undefined; }
    }
    return true;
  }

  private fetch(job: Job, index: number): void {
    const context = this.context!, tile = job.tiles[index], location = job.crop.tiles[index], epoch = job.quality === 'overview' ? this.previewEpoch : this.nativeEpoch;
    const currentEpoch = () => job.quality === 'overview' ? this.previewEpoch : this.nativeEpoch;
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
      if (tile.state === 'fetching') this.fetching--;
      this.fail(job);
      return;
    }
    void response.then(value => {
      if (epoch === currentEpoch() && tile.state === 'fetching') this.fetching--;
      if (epoch !== currentEpoch() || job.failed) { value.release?.(); return; }
      if (value.data.byteLength > MAX_TILE_BYTES) { value.release?.(); this.fail(job); return; }
      tile.data = value.data; tile.release = value.release; tile.state = 'compressed'; this.pump();
    }).catch(() => {
      if (epoch === currentEpoch() && tile.state === 'fetching') this.fetching--;
      if (epoch === currentEpoch() && !job.failed) this.fail(job);
    });
  }

  private decode(job: Job, index: number): void {
    const tile = job.tiles[index], epoch = job.quality === 'overview' ? this.previewEpoch : this.nativeEpoch, data = tile.data!;
    const currentEpoch = () => job.quality === 'overview' ? this.previewEpoch : this.nativeEpoch;
    tile.state = 'decoding'; this.decoding++;
    void Promise.resolve().then(() => createImageBitmap(new Blob([data], { type: 'image/webp' }))).then(image => {
      if (epoch !== currentEpoch() || job.failed || image.width !== RASTER_TILE_SIZE || image.height !== RASTER_TILE_SIZE) {
        image.close(); if (epoch === currentEpoch() && !job.failed) this.fail(job); return;
      }
      const location = job.crop.tiles[index], sx = job.width / job.crop.width, sy = job.height / job.crop.height;
      try { this.canvas!.getContext('2d')!.drawImage(image, location.drawX * sx, location.drawY * sy, RASTER_TILE_SIZE * sx, RASTER_TILE_SIZE * sy); }
      finally { image.close(); }
      tile.state = 'drawn';
    }).catch(() => { if (epoch === currentEpoch() && !job.failed) this.fail(job); })
      .finally(() => {
        tile.release?.(); tile.release = undefined; tile.data = undefined; this.decoding--;
        if (!this.context && !this.decoding) { this.decodeLease?.release(); this.decodeLease = null; }
        this.pump();
      });
  }

  private finish(job: Job): void {
    const context = this.context!;
    job.partial?.close(); job.partial = undefined;
    const image = { bitmap: this.canvas!.transferToImageBitmap(), lease: job.lease };
    job.lease = null;
    (job.quality === 'overview' ? this.previews : this.natives).set(job.frame, image);
    if (job.quality === 'overview') {
      this.unavailable.delete(job.frame);
      this.failureCounts.delete(job.frame);
      this.retryAfter.delete(job.frame);
    }
    context.jobs = context.jobs.filter(value => value !== job);
    if (job.quality === 'detail' && !context.nativeWindowed && this.natives.size === context.frames.length) this.limited = false;
    this.composing = null;
    if (!this.decoding) { this.decodeLease?.release(); this.decodeLease = null; }
    this.onReady(); this.pump();
  }

  private cancelJob(job: Job): void {
    job.failed = true;
    for (const tile of job.tiles) {
      if (tile.state === 'fetching') { this.fetching--; tile.state = 'waiting'; }
      tile.handle?.cancel();
      if (tile.state !== 'decoding') { tile.release?.(); tile.release = undefined; tile.data = undefined; }
    }
    job.partial?.close(); job.partial = undefined;
    job.lease?.release(); job.lease = null;
    if (this.composing === job) this.composing = null;
  }

  private fail(job: Job): void {
    const context = this.context;
    if (!context || job.failed) return;
    this.cancelJob(job);
    context.jobs = context.jobs.filter(value => value !== job);
    if (job.quality === 'overview') {
      const attempts = (this.failureCounts.get(job.frame) ?? 0) + 1;
      this.failureCounts.set(job.frame, attempts);
      if (job.frame === this.selected && !this.retries.has(job.frame)) {
        this.retries.add(job.frame);
        this.unavailable.delete(job.frame);
        context.jobs.push(this.job(job.frame, job.quality, job.crop));
      } else {
        this.unavailable.add(job.frame);
        if (attempts < MAX_PREVIEW_ATTEMPTS) {
          this.retryAfter.set(job.frame, Date.now() + PREVIEW_RETRY_COOLDOWN_MS);
          if (job.frame === this.selected) this.ensureSelectedPreview(job.frame);
        }
      }
    }
    this.onReady(); this.pump();
  }

  private nativeAdmitted(required: number): boolean {
    return !this.options.budget || (Number.isFinite(required) && this.options.budget.canReserve(required, 'background'));
  }

  private evictNative(required: number): void {
    const budget = this.options.budget, context = this.context;
    if (!budget || !context) return;
    const index = context.frames.indexOf(this.selected ?? '');
    const queued = context.jobs
      .filter(job => job.quality === 'detail' && job.frame !== this.selected && (job.lease || job.tiles.some(tile => tile.state === 'compressed')))
      .sort((a, b) => Math.abs(context.frames.indexOf(b.frame) - index) - Math.abs(context.frames.indexOf(a.frame) - index));
    while (!this.nativeAdmitted(required) && queued.length) {
      const job = queued.shift()!;
      if (this.composing === job && this.decoding > 0) continue;
      this.cancelJob(job);
      context.jobs = context.jobs.filter(value => value !== job);
      context.nativeWindowed = true;
      this.markLimited();
    }
    const candidates = [...this.natives.entries()].filter(([frame, image]) => frame !== this.selected && image !== this.shown && !this.retired.some(entry => entry.image === image))
      .sort(([a], [b]) => Math.abs(context.frames.indexOf(b) - index) - Math.abs(context.frames.indexOf(a) - index));
    while (!this.nativeAdmitted(required) && candidates.length) {
      const [frame, image] = candidates.shift()!;
      this.natives.delete(frame); image.bitmap.close(); image.lease?.release();
      context.nativeWindowed = true;
      this.markLimited();
    }
  }

  private updateNativeWindow(): void {
    const context = this.context;
    if (!context?.native || !this.selected) return;
    const selected = context.frames.indexOf(this.selected);
    const allowed = new Set(context.frames.slice(Math.max(0, selected - 2), Math.min(context.frames.length, selected + 3)));
    for (const job of [...context.jobs]) {
      if (job.quality !== 'detail' || allowed.has(job.frame)) continue;
      this.cancelJob(job);
      context.jobs = context.jobs.filter(value => value !== job);
    }
    for (const [frame, image] of this.natives) {
      if (allowed.has(frame) || image === this.shown || this.retired.some(entry => entry.image === image)) continue;
      this.natives.delete(frame); image.bitmap.close(); image.lease?.release();
    }
    for (const frame of allowed) {
      if (this.previews.has(frame) && !this.natives.has(frame) && !context.jobs.some(job => job.quality === 'detail' && job.frame === frame)) {
        context.jobs.push(this.job(frame, 'detail', context.native));
      }
    }
  }

  private markLimited(): void {
    if (this.limited) return;
    this.limited = true;
    queueMicrotask(() => { if (!this.disposed && this.limited) this.onReady(); });
  }
}
