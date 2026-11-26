import type { Map } from 'maplibre-gl';
import { frameTileUrl, layerMaxZoom, type PinnedBuild, type PreparationBudget, type PreparationLease, type RasterTileHandle, type RasterTileSourceProtocol, type RasterTileSourceTransport } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { remapFor } from '../../layers/registry';
import { MAX_TILE_BYTES, RASTER_TILE_SIZE } from '@av/contracts/format';
import type { RasterCrop } from './raster-crop';
import { OverviewDisplay, type OverviewImage as Image } from './overview-display';
import { PreviewAttempts } from './preview-attempts';
import { canonicalZoom, contains, previewCrop, viewBounds as bounds, viewInCrop } from './overview-geometry';
import { DEFAULT_THEME, type MapTheme } from '../../themes/registry';
import { remapTileToBitmap, shouldRemapTile } from './tile-remap';

export { FOCUS_DWELL_MS } from '../map/viewport-policy';

type Quality = 'overview' | 'detail';
/** Outcome of `drawPreview`: drawn, still preparing, or not drawable for this build, layer, frame or view. */
export type PreviewDraw = 'ready' | 'pending' | 'unavailable';
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
interface RasterOverviewState { ready: number; total: number; failed: number }
interface RasterOverviewReadiness { previewReadyFrames: readonly string[]; detailReadyFrames: readonly string[]; limited: boolean }
export interface RasterOverviewOptions { budget?: PreparationBudget; requestLimits?: { maxActive: number; maxPrefetchActive: number }; theme?: MapTheme }

const SELECTED_PREVIEW_SLOTS = 4;
const DECODE_LEASE_BYTES = 4 * (MAX_TILE_BYTES + RASTER_TILE_SIZE ** 2 * 4);

/**
 * Low-resolution overview frames for the current viewport: fetches up to four tiles per frame, composes
 * each into one canvas bitmap under the preparation budget, and shows it through `OverviewDisplay`.
 */
export class RasterOverview {
  readonly id = `av-overview-${crypto.randomUUID()}`;
  readonly supported: boolean;
  private readonly canvas: OffscreenCanvas | null;
  private readonly transport: RasterTileSourceTransport | null;
  private readonly display: OverviewDisplay;
  private readonly previews = new globalThis.Map<string, Image>();
  private readonly attempts = new PreviewAttempts();
  private context: Context | null = null;
  private selected: string | null = null;
  private direction = 1;
  private failedImage: Image | null = null;
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
  /** Frames other callers want next (the day previews); prepared right after the selected one. */
  private preferred: ReadonlySet<string> = new Set();
  private readonly unsubscribeBudget: (() => void) | null;

  constructor(private readonly map: Map, private readonly protocol: RasterTileSourceProtocol, private readonly onReady: () => void, private readonly options: RasterOverviewOptions = {}) {
    this.theme = options.theme ?? DEFAULT_THEME;
    this.display = new OverviewDisplay(map, this.id, options.budget, image => [...this.previews.values()].includes(image));
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

  // Display state, also read by raster-overview.test.ts.
  private get shown(): Image | null { return this.display.shown; }
  private get heldLease(): PreparationLease | null { return this.display.heldLease; }
  private get visibleId(): string | null { return this.display.visibleId; }
  private get opacities(): ReadonlyMap<string, number> { return this.display.opacities; }

  get state(): RasterOverviewState {
    const frames = this.context?.frames ?? [];
    const cov = this.coverage();
    let ready = 0, failed = 0;
    for (const frame of frames) {
      const usable = this.isFrameUsable(frame, cov);
      if (usable) ready++;
      else if (this.attempts.failed(frame)) failed++;
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

  /**
   * Draws `frame`'s overview into `target` (`width` × `height` device pixels): the current map view,
   * centre-cropped to the target's aspect so every caller crops the same way. The overview keeps its
   * bitmaps; this only copies pixels.
   */
  drawPreview(build: PinnedBuild, layer: LayerId, frame: string, target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, width: number, height: number): PreviewDraw {
    const context = this.context;
    if (!this.supported || this.disposed || build.expiresAtMs <= Date.now() || !(width > 0) || !(height > 0)) return 'unavailable';
    if (!context || context.build !== build || context.layer !== layer) return context || this.deferred ? 'pending' : 'unavailable';
    if (!context.frames.includes(frame)) return 'unavailable';
    const image = this.previews.get(frame);
    const region = viewInCrop(context.preview, bounds(this.map));
    if (!image || image === this.failedImage || !region) return 'pending';
    const scaleX = image.bitmap.width / context.preview.width, scaleY = image.bitmap.height / context.preview.height;
    const aspect = width / height;
    let sw = region.width, sh = region.height;
    if (sw / sh > aspect) sw = sh * aspect; else sh = sw / aspect;
    const sx = region.x + (region.width - sw) / 2, sy = region.y + (region.height - sh) / 2;
    target.drawImage(image.bitmap, sx * scaleX, sy * scaleY, sw * scaleX, sh * scaleY, 0, 0, width, height);
    return 'ready';
  }

  /** Prepares these frames right after the selected one; an empty list restores plain nearest-first order. */
  preferFrames(frames: readonly string[]): void {
    const next = new Set(frames);
    if (next.size === this.preferred.size && [...next].every(frame => this.preferred.has(frame))) return;
    this.preferred = next;
    if (this.context) this.pump();
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

  canPaint(): boolean { return this.display.canPaint(); }

  show(build: PinnedBuild, layer: LayerId, frame: string, opacity: number): boolean {
    if (this.display.publishing || !this.ready(build, layer, frame)) return false;
    const image = this.previews.get(frame);
    if (!image || image === this.failedImage) return false;
    const context = this.context!, selected = this.selected;
    return this.display.show(image, frame, context.preview.coordinates, opacity, {
      failed: () => image === this.failedImage,
      limited: () => this.markLimited(),
      current: () => this.context === context && this.selected === selected && !this.disposed && this.previews.get(frame) === image,
      rejected: () => { if (this.context === context && this.selected === selected) this.failedImage = image; }
    });
  }

  hide(): void { this.display.hide(); }
  cancelStage(opacity: number): boolean { return this.display.cancelStage(opacity); }
  painted(): boolean { return this.display.painted(); }

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

  private ensureSelectedPreview(frame: string): void {
    const context = this.context;
    if (!context || this.previews.has(frame) || context.jobs.some(job => job.frame === frame)) return;
    const due = this.attempts.admit(frame, () => Date.now());
    if (due === null) return;
    if (due === 'now') {
      if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
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
    const surviving = this.display.surviving(previewImages, keepShown);
    for (const image of this.previews.values()) {
      if (surviving.includes(image) || this.display.holds(image, keepShown)) continue;
      image.bitmap.close(); image.lease?.release();
    }
    this.previews.clear(); this.attempts.clear();
    const failure = this.display.reset(previewImages, surviving, keepShown, previous?.previewLease ?? null);
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
    // Selected first, then its immediate neighbours (the next scrub or arrow step), then day-preview frames, then the rest.
    const rank = (job: Job) => {
      if (job.frame === this.selected) return 0;
      if (index >= 0 && Math.abs(frames.indexOf(job.frame) - index) === 1) return 1;
      return this.preferred.has(job.frame) ? 2 : 3;
    };
    return jobs.sort((a, b) => {
      const deltaA = frames.indexOf(a.frame) - index, deltaB = frames.indexOf(b.frame) - index;
      return rank(a) - rank(b) || Math.abs(deltaA) - Math.abs(deltaB)
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
      const remap = remapFor(context.layer), maskTemplate = remap.mask && context.build.templates[remap.mask];
      if (maskTemplate && typeof this.protocol.requestTile === 'function') {
        const maskUrl = frameTileUrl(maskTemplate, job.frame)
          .replaceAll('{z}', String(location.z)).replaceAll('{x}', String(location.canonicalX)).replaceAll('{y}', String(location.y));
        const maskRes = await this.protocol.requestTile(maskUrl, { priority }).response.catch(() => null);
        if (maskRes) { maskData = maskRes.data; maskRes.release(); }
      }
      if (!this.ownsJob(job, context)) return null;
      return remapTileToBitmap(data, remap.ramp, theme, maskData, { priority });
    };
    void Promise.resolve().then(() => {
      if (!this.ownsJob(job, context)) return null;
      if (!shouldRemapTile(theme, data)) return createImageBitmap(new Blob([data], { type: 'image/webp' }));
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
    this.attempts.succeeded(job.frame);
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
    const outcome = this.attempts.fail(job.frame, job.frame === this.selected, () => Date.now());
    if (outcome === 'retry') context.jobs.push(this.job(job.frame, job.crop));
    else if (outcome === 'cooldown' && job.frame === this.selected) this.ensureSelectedPreview(job.frame);
    this.onReady(); this.pump();
  }

  private markLimited(): void {
    if (this.limited) return;
    this.limited = true;
    queueMicrotask(() => { if (!this.disposed && this.limited) this.onReady(); });
  }
}
