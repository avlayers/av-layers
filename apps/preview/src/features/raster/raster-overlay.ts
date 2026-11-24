import type { Map, MapSourceDataEvent, ErrorEvent } from 'maplibre-gl';
import { createSourceRasterTileProtocol, frameTileUrl, layerMaxZoom, planViewportPrefetch, previewRasterLayer, previewRasterSource, seamInsertBefore, type ForecastRequestHandle, type ForecastRequestSpec, type PinnedBuild, type PreparationBudget, type PreparationLease, type RasterTileSourceProtocol, type RasterTileSourceTransport, viewportTiles } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { addProtocol, removeProtocol } from 'maplibre-gl';
import { canRetainRasterOverview, MAP_TEXTURE_POOL_RESERVE_BYTES, MAX_RASTER_SOURCES, rasterSourceBytes, rasterSourceLimit } from './raster-budget';
import { FOCUS_DWELL_MS, RasterOverview } from './raster-overview';
import { boundsAreaKm2, cameraBounds, createViewportWarmth } from '../map/viewport-policy';
import { isMapTheme, themeOption, type MapTheme } from '../../themes/registry';
import { canRemapTiles, remapTileToBitmap } from './tile-remap';

interface RasterSelection { build: PinnedBuild; layer: LayerId; frame: string }
type Selection = RasterSelection;
class RasterBudgetError extends Error {}
interface Slot extends Selection { id: string; transport: RasterTileSourceTransport; lease: PreparationLease | null; successful: boolean; pending: Set<object>; failed: Set<object>; sourceFailed: boolean; staleTheme?: boolean }
export interface RasterOverlayOptions { budget?: PreparationBudget; protectedBytes?: () => number; canExpandNative?: () => boolean; beforeReveal?: (selection: RasterSelection) => void; onSelectedPending?: (pending: boolean, selection: RasterSelection | null) => void; requestLimits?: { maxActive: number; maxPrefetchActive: number }; theme?: MapTheme }
type DetailReadiness = 'idle' | 'valid-empty' | 'complete' | 'partial' | 'failed' | 'timed-out';
export interface OverlayState { displayed: Selection | null; requested: Selection | null; quality: 'overview' | 'detail' | null; viewLoading: boolean; overviewReady: number; overviewTotal: number; overviewFailed: number; incomplete: boolean; replacementFailed: boolean; previewReadyFrames?: readonly string[]; detailReadyFrames?: readonly string[]; limited?: boolean; detailState?: DetailReadiness; cameraRevision?: number; requiredTiles?: number; loadedTiles?: number; pendingTiles?: number; erroredTiles?: number; coarseReadyFrames?: readonly string[]; detailBytesReadyFrames?: readonly string[]; detailDrawableFrames?: readonly string[] }
const matches = (a: Selection | null, b: Selection | null): boolean => !!a && !!b && a.build === b.build && a.layer === b.layer && a.frame === b.frame;
const canonicalKey = (tile: { x?: number; y?: number; z?: number } | undefined): string | null =>
  tile && Number.isFinite(tile.z) && Number.isFinite(tile.x) && Number.isFinite(tile.y) ? `${tile.z}/${tile.x}/${tile.y}` : null;
const STAGING_TIMEOUT_MS = 15_000;

function releaseAll(actions: readonly (() => void)[]): void {
  let failed = false, failure: unknown;
  for (const action of actions) {
    try { action(); } catch (error) { if (!failed) { failed = true; failure = error; } }
  }
  if (failed) throw failure;
}

/** Owns the displayed raster and a bounded prepared window; dispose with the map. */
export class RasterOverlay {
  private protocol: RasterTileSourceProtocol | null = null;
  private active: Slot | null = null;
  private pendingPaint: Slot | null = null;
  private overview: RasterOverview | null = null;
  private coarse: Selection | null = null;
  private pendingOverview: Selection | null = null;
  private refineTimer: ReturnType<typeof setTimeout> | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private slots: Slot[] = [];
  private rendererPool: PreparationLease | null = null;
  private requested: Selection | null = null;
  private preferred: Selection | null = null;
  private warmFailed: Selection[] = [];
  private direction: 1 | -1 | undefined;
  private sourceLimits = new globalThis.Map<number, number>();
  private generation = 0;
  private opacity: number;
  private visible = true;
  private theme: MapTheme;
  private windActive = true;
  private windResident = true;
  private incomplete = false;
  private replacementFailed = false;
  private lastState: OverlayState | null = null;
  private retryEmpty = false;
  private moving = false;
  private playing = false;
  private disposed = false;
  private prefetchJobs = new globalThis.Map<string, AbortController>();
  private prefetched = false;
  private prefetchCursor = 0;
  private prefetching = false;
  private readonly prefetchPromises = new globalThis.Map<string, Promise<boolean>>();
  private lastCacheEvictions = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private selectedPending = false;
  private pendingSelection: Selection | null = null;
  private limited = false;
  private overviewUpdateQueued = false;
  private cameraRevision = 0;
  private requiredKeys = new Set<string>();
  private loadedKeys = new Set<string>();
  private pendingKeys = new Set<string>();
  private erroredKeys = new Set<string>();
  private detailState: DetailReadiness = 'idle';
  private stagingSelection: Selection | null = null;
  private stagingRevision = -1;
  private stagingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly warmth = createViewportWarmth();
  private byteReadyFrames = new Set<string>();

  private readonly data = (e: MapSourceDataEvent): void => {
    if (this.overview && (this.overview.ownsSource?.(e.sourceId) ?? e.sourceId === this.overview.id)) {
      // ImageSource.updateImage emits synchronously before show finishes its ownership transfer.
      if (!this.overviewUpdateQueued) {
        this.overviewUpdateQueued = true;
        queueMicrotask(() => {
          this.overviewUpdateQueued = false;
          if (!this.disposed) { this.update(); this.emit(); }
        });
      }
      return;
    }
    const slot = this.slots.find(s => s.id === e.sourceId);
    if (!slot) return;
    if (e.tile) {
      slot.pending.delete(e.tile); slot.successful = true;
      const recovered = slot.failed.delete(e.tile);
      if (matches(slot, this.requested)) {
        const key = canonicalKey((e.tile as { tileID?: { canonical?: { x: number; y: number; z: number } } }).tileID?.canonical);
        if (key) { this.loadedKeys.add(key); this.pendingKeys.delete(key); this.erroredKeys.delete(key); this.refreshDetailState(); }
      }
      if (slot === this.active) { if (recovered) this.incomplete = this.problem(slot); this.emit(); }
      else if (matches(slot, this.requested)) queueMicrotask(() => { if (!this.disposed) { this.update(); this.emit(); } });
    }
    if (slot !== this.active && e.sourceDataType === 'idle' && e.isSourceLoaded) {
      queueMicrotask(() => {
        if (this.disposed) return;
        this.abandonEmpty(slot);
        this.update();
        this.emit();
      });
    }
  };
  private readonly loading = (e: MapSourceDataEvent): void => {
    const slot = this.slots.find(s => s.id === e.sourceId);
    if (slot && e.tile) {
      if (slot !== this.active) slot.pending.add(e.tile);
      if (matches(slot, this.requested)) { const key = canonicalKey((e.tile as { tileID?: { canonical?: { x: number; y: number; z: number } } }).tileID?.canonical); if (key) { this.pendingKeys.add(key); this.refreshDetailState(); } }
      if (slot === this.active) this.emit();
    }
  };
  private readonly abort = (e: MapSourceDataEvent): void => {
    const slot = this.slots.find(s => s.id === e.sourceId);
    if (!slot || !e.tile) return;
    slot.pending.delete(e.tile);
    const recovered = slot.failed.delete(e.tile);
    if (matches(slot, this.requested)) { const key = canonicalKey((e.tile as { tileID?: { canonical?: { x: number; y: number; z: number } } }).tileID?.canonical); if (key) { this.pendingKeys.delete(key); this.refreshDetailState(); } }
    if (slot === this.active) { if (recovered) this.incomplete = this.problem(slot); this.emit(); }
  };
  private readonly failed = (e: ErrorEvent & { sourceId?: string; tile?: object }): void => {
    const slot = this.slots.find(s => s.id === e.sourceId);
    if (!slot) return;
    if (!e.tile) {
      slot.sourceFailed = true;
      if (slot !== this.active) this.abandon(slot); else { this.incomplete = true; this.emit(); }
      return;
    }
    slot.failed.add(e.tile); slot.pending.delete(e.tile);
    if (matches(slot, this.requested)) { const key = canonicalKey((e.tile as { tileID?: { canonical?: { x: number; y: number; z: number } } }).tileID?.canonical); if (key) { this.erroredKeys.add(key); this.pendingKeys.delete(key); this.refreshDetailState(); } }
    if (slot === this.active) { this.incomplete = true; this.emit(); return; }
    if (this.tilesSettled(slot) && (!slot.successful || !matches(slot, this.requested))) this.abandon(slot);
  };
  private readonly render = (): void => {
    const overviewPainted = this.overview?.painted ? this.overview.painted() : true;
    if (this.pendingOverview) {
      const next = this.pendingOverview;
      if (!matches(next, this.requested) || !this.overview?.ready(next.build, next.layer, next.frame)) {
        this.cancelPaint(); this.refresh(); this.emit(); return;
      }
      if (!matches(this.overviewRevealed, next)) {
        if (this.overview?.canPaint?.() !== false) this.revealOverview(next);
        return;
      }
      if (!overviewPainted) return;
      if (this.active && !matches(this.active, next)) this.map.setPaintProperty(this.active.id, 'raster-opacity', 0);
      this.coarse = next; this.pendingOverview = null; this.emit(); this.update(); return;
    }
    const next = this.pendingPaint;
    if (!next) { this.update(); return; }
    if (next.build.expiresAtMs <= Date.now()) { this.refresh(); return; }
    this.pendingPaint = null;
    const previous = this.active;
    this.clearStagingWatchdog(); this.active = next; this.coarse = null;
    next.transport.setInteractive(true);
    if (previous !== next) previous?.transport.setInteractive(false);
    this.replacementFailed = false; this.incomplete = this.problem(next);
    for (const slot of [...this.slots]) if (slot !== next && (slot.build !== next.build || this.problem(slot))) this.drop(slot);
    this.limitSlots(next);
    if (previous && previous.build.manifest.buildId !== next.build.manifest.buildId) this.protocol?.evictBuild(previous.build.manifest.buildId);
    queueMicrotask(() => this.prepareNext());
    this.armExpiry(); this.emit();
  };
  private readonly move = (): void => {
    this.cameraRevision++; this.requiredKeys.clear(); this.detailState = 'idle'; this.byteReadyFrames.clear();
    this.cancelPaint(); this.cancelRefinement(); this.cancelFocus();
    this.moving = true; this.preferred = null; this.warmFailed = []; this.sourceLimits.clear(); this.cancelPrefetch();
    for (const slot of [...this.slots]) if (slot !== this.active && !matches(slot, this.requested)) this.drop(slot);
    this.armExpiry(); this.emit();
  };
  private readonly viewChanged = (): void => { this.cameraRevision++; this.requiredKeys.clear(); this.detailState = 'idle'; this.byteReadyFrames.clear(); this.sourceLimits.clear(); this.enforceBudget(); };
  private readonly resized = (): void => {
    this.cameraRevision++; this.refreshRequired(); this.byteReadyFrames.clear();
    this.cancelPaint(); this.cancelRefinement(); this.cancelFocus();
    this.sourceLimits.clear(); this.preferred = null; this.warmFailed = []; this.cancelPrefetch();
    for (const slot of [...this.slots]) if (slot !== this.active && !matches(slot, this.requested)) this.drop(slot);
    this.enforceBudget();
    if (this.requested && !this.moving) {
      this.prepareOverview(this.requested);
      try { this.loadDetail(this.requested); } catch {}
    }
    this.prepareNext(); this.armExpiry(); this.emit();
  };
  private readonly settled = (): boolean => {
    if (!this.moving || this.map.isMoving?.()) return false;
    this.moving = false; this.cameraRevision++; this.refreshRequired(); this.sourceLimits.clear(); this.enforceBudget();
    const sel = this.requested, pending = this.slots.find(s => s !== this.active && matches(s, sel));
    if (sel && this.overview?.hasExtent() && !this.overview.coversView()) {
      this.scheduleFocus(sel); this.emit(); return false;
    }
    if (sel) this.prepareOverview(sel);
    if ((!pending && !this.retryEmpty && matches(this.active, sel)) || !sel || sel.build.expiresAtMs <= Date.now()) {
      this.prepareNext(); this.emit(); return false;
    }
    if (pending) this.drop(pending);
    try { this.select(sel.build, sel.layer, sel.frame); } catch {}
    return true;
  };
  private readonly idle = (): void => {
    if (this.settled()) return;
    this.update();
    for (const slot of [...this.slots]) if (slot !== this.active) this.abandonEmpty(slot);
    this.prepareNext(); this.emit();
  };
  private readonly events: Array<[string, (...args: never[]) => unknown]> = [
    ['sourcedata', this.data], ['sourcedataloading', this.loading], ['sourcedataabort', this.abort], ['error', this.failed],
    ['render', this.render], ['movestart', this.move], ['move', this.viewChanged], ['moveend', this.settled], ['idle', this.idle], ['resize', this.resized]
  ];

  private overviewRevealed: Selection | null = null;
  private unsubscribeBudget: (() => void) | null = null;

  constructor(private readonly map: Map, private readonly baseUrl: string, opacity: number, private readonly onState: (state: OverlayState) => void, private readonly fetchImpl?: typeof fetch, private readonly request?: (spec: ForecastRequestSpec) => ForecastRequestHandle, private readonly options: RasterOverlayOptions = {}) {
    this.opacity = opacity;
    this.theme = options.theme ?? 'stone';
    for (const [ev, fn] of this.events) map.on(ev as never, fn as never);
    this.unsubscribeBudget = options.budget?.onRelease(() => {
      if (this.disposed || !this.limited || !this.requested || this.moving || this.map.isMoving?.()) return;
      this.limited = false;
      this.enforceBudget();
      if (this.requested && !this.slots.some(s => matches(s, this.requested)) && !matches(this.coarse, this.requested)) {
        try { this.loadDetail(this.requested); } catch {}
      }
      this.prepareNext();
      this.emit();
    }) ?? null;
  }

  isPrepared(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    const slot = this.slots.find(s => matches(s, { build, layer, frame }));
    return !this.disposed && !!slot && slot.successful && !this.problem(slot) && this.tilesSettled(slot);
  }

  get isSelectedPending(): boolean { return this.selectedPending; }

  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (this.disposed) return;
    if (build.expiresAtMs <= Date.now()) { this.clear(); return; }
    this.ensureProtocol(); this.cancelRefinement();
    this.moving ||= this.map.isMoving?.() ?? false;
    const prev = this.requested;
    this.detailState = 'idle';
    if (!prev || prev.build !== build || prev.layer !== layer) this.byteReadyFrames.clear();
    if (prev?.build === build && prev.layer === layer && prev.frame !== frame) {
      const frames = renderedFrames(build.manifest);
      this.direction = frames.findIndex(i => i.id === frame) > frames.findIndex(i => i.id === prev.frame) ? 1 : -1;
    } else if (prev?.layer !== layer || prev?.build !== build) this.direction = undefined;
    this.retryEmpty = false; this.preferred = null; this.warmFailed = [];
    this.requested = { build, layer, frame };
    if ((this.pendingPaint && !matches(this.pendingPaint, this.requested)) || (this.pendingOverview && !matches(this.pendingOverview, this.requested))) this.cancelPaint();
    this.enforceBudget();
    if (!this.moving) this.prepareOverview(this.requested);
    this.replacementFailed = false; this.incomplete = this.problem(this.active);
    if (matches(this.active, this.requested) && !this.active?.staleTheme) {
      for (const s of this.slots) if (s !== this.active) s.transport.setInteractive(false);
      this.cancelPrefetch(); this.update(); this.emit(); return;
    }
    let target = this.slots.find(s => matches(s, this.requested) && !s.staleTheme);
    if (target && this.problem(target)) { this.drop(target); target = undefined; }
    const ready = this.isPrepared(build, layer, frame), future = this.predicted(this.requested);
    for (const s of [...this.slots]) {
      if (s === this.active || s === target) continue;
      if (s.build !== build || s.staleTheme || this.problem(s) || ((!s.successful || !this.tilesSettled(s)) && (!ready || !future.some(v => matches(s, v))))) this.drop(s);
      else s.transport.setInteractive(false);
    }
    if (target) { target.transport.setInteractive(true); this.cancelPrefetch(); this.emit(); this.update(); return; }
    this.cancelPrefetch(this.requested); this.emit();
    this.stageOverview();
    if (this.overview?.state.total) { this.armDetail(this.requested); return; }
    this.loadDetail(this.requested);
  }

  private loadDetail(sel: Selection): void {
    if (!matches(sel, this.requested) || this.slots.some(s => matches(s, sel) && !s.staleTheme)) return;
    const limit = this.slotLimit(sel);
    if (!limit) { this.cancelRefinement(); this.cancelPrefetch(); this.replacementFailed = true; this.armExpiry(); this.emit(); return; }
    for (const s of [...this.slots]) if (s !== this.active) this.drop(s);
    if (this.slots.length >= limit && matches(this.coarse, sel) && this.active) this.drop(this.active);
    try {
      try {
        this.addSlot(sel, true);
      } catch (error) {
        if (error instanceof RasterBudgetError) {
          this.overview?.relievePressure?.();
          try {
            this.addSlot(sel, true);
          } catch (retryError) {
            if (retryError instanceof RasterBudgetError && this.active) {
              if (this.overview?.ready(this.active.build, this.active.layer, this.active.frame) && this.overview.show(this.active.build, this.active.layer, this.active.frame, this.effectiveOpacity())) {
                this.coarse = { build: this.active.build, layer: this.active.layer, frame: this.active.frame };
              }
              this.drop(this.active);
              this.addSlot(sel, true);
            } else throw retryError;
          }
        } else throw error;
      }
      this.limited = false; this.replacementFailed = false; this.cancelPrefetch(sel); this.armExpiry(); this.emit();
    } catch (error) {
      const failed = this.slots.find(s => matches(s, this.requested));
      if (failed) this.drop(failed);
      this.replacementFailed = true; this.cancelPrefetch();
      if (error instanceof RasterBudgetError) { this.limited = true; this.emit(); return; }
      this.emit(); throw error;
    }
  }

  prepare(layer: LayerId, frame: string): void {
    const build = this.active?.build;
    if (!build || !build.templates[layer] || !renderedFrames(build.manifest).some(i => i.id === frame)) return;
    this.preferred = { build, layer, frame }; this.warmFailed = []; this.cancelPrefetch(); this.prepareNext();
  }

  refresh(): void {
    this.overview?.refresh();
    const stale = this.coarse && this.coarse.build.expiresAtMs <= Date.now();
    if (stale) this.clearOverview();
    if (this.pendingOverview && !this.overview?.ready(this.pendingOverview.build, this.pendingOverview.layer, this.pendingOverview.frame)) this.cancelPaint();
    let changed = false;
    for (const s of [...this.slots]) if (s.build.expiresAtMs <= Date.now()) {
      this.drop(s); this.protocol?.evictBuild(s.build.manifest.buildId); changed = true;
    }
    if (changed) { this.preferred = null; this.cancelPrefetch(); this.armExpiry(); this.emit(); }
  }

  private effectiveOpacity(): number { return this.visible ? this.opacity : 0; }

  setOpacity(value: number): void {
    this.opacity = value;
    const eff = this.effectiveOpacity();
    const coarse = this.pendingOverview ?? (this.pendingPaint ? null : this.coarse);
    if (coarse) { this.overview?.show(coarse.build, coarse.layer, coarse.frame, eff); return; }
    const visible = this.pendingPaint ?? this.active;
    if (visible) this.map.setPaintProperty(visible.id, 'raster-opacity', eff);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.setOpacity(this.opacity);
  }

  setTheme(theme: MapTheme): void {
    if (this.theme === theme || this.disposed) return;
    this.theme = theme;
    this.overview?.setTheme(theme);
    for (const s of [...this.slots]) if (s !== this.active) this.drop(s);
    if (this.active) this.active.staleTheme = true;
    const sel = this.requested;
    if (sel && !this.moving && !this.map.isMoving?.() && sel.build.expiresAtMs > Date.now()) {
      try { this.loadDetail(sel); } catch {}
    }
  }

  setPlayback(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    (this.overview as { setPlayback?(playing: boolean): void } | null)?.setPlayback?.(playing);
    if (playing) { this.cancelRefinement(); this.cancelPrefetch(); return; }
    if (this.requested && !this.moving && this.overview?.state.total) this.armDetail(this.requested);
  }

  setWindActive(active: boolean, numericResident = active): void {
    if (this.windActive === active && this.windResident === numericResident) return;
    this.windActive = active; this.windResident = numericResident;
    this.sourceLimits.clear(); this.enforceBudget();
    const sel = this.requested;
    if (sel && !this.moving && !this.map.isMoving?.() && sel.build.expiresAtMs > Date.now()) {
      try { this.select(sel.build, sel.layer, sel.frame); } catch {}
    }
    this.prepareNext();
  }

  clear(dispose = false): void {
    this.cancelRefinement(); this.cancelFocus();
    const slots = this.slots, overview = this.overview, protocol = this.protocol, rendererPool = this.rendererPool;
    const ids = new Set(slots.map(s => s.build.manifest.buildId));
    if (this.expiryTimer !== null) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    this.slots = []; this.rendererPool = null; this.active = this.pendingPaint = null;
    this.pendingOverview = this.coarse = this.overviewRevealed = null;
    this.requested = this.preferred = null; this.warmFailed = []; this.direction = undefined; this.sourceLimits.clear();
    if (dispose) { this.overview = null; this.protocol = null; }
    this.incomplete = this.replacementFailed = this.retryEmpty = this.limited = false;
    releaseAll([
      () => this.cancelPrefetch(), () => overview?.clear(),
      ...slots.map(slot => () => this.drop(slot)),
      () => rendererPool?.release(),
      ...[...ids].map(id => () => protocol?.evictBuild(id)),
      ...(dispose ? [() => overview?.destroy(), () => protocol?.dispose(), () => { if (protocol) removeProtocol(protocol.scheme); }] : []),
      () => this.emit()
    ]);
  }

  relievePressure(requiredBytes = 1): boolean {
    const budget = this.options.budget;
    if (!budget) return false;
    const before = budget.used;
    this.overview?.relievePressure(requiredBytes);
    for (const slot of [...this.slots]) {
      if (budget.canReserve(requiredBytes, 'background')) break;
      if (slot !== this.active && slot !== this.pendingPaint && !matches(slot, this.requested)) this.drop(slot);
    }
    return budget.used < before;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    const unsubscribe = this.unsubscribeBudget; this.unsubscribeBudget = null;
    releaseAll([() => unsubscribe?.(), () => this.clear(true), ...this.events.map(([ev, fn]) => () => { this.map.off(ev as never, fn as never); })]);
  }

  private update(): void {
    const now = Date.now();
    if ((this.coarse && this.coarse.build.expiresAtMs <= now) || this.slots.some(slot => slot.build.expiresAtMs <= now)) this.refresh();
    if (this.pendingOverview) {
      if (this.overview?.canPaint?.() !== false) this.revealOverview(this.pendingOverview);
      return;
    }
    if (this.pendingPaint) return;
    const next = this.slots.find(s => matches(s, this.requested) && !s.staleTheme);
    if (next === this.active && !this.coarse && !(this.problem(next) && this.overview?.ready(next.build, next.layer, next.frame))) { this.prepareNext(); return; }
    if (next && (next.successful || next.failed.size) && this.tilesSettled(next)) {
      if (this.stagingSelection && matches(next, this.stagingSelection)) {
        if (this.cameraRevision !== this.stagingRevision) { this.abandon(next); this.refreshRequired(); return; }
        this.clearStagingWatchdog();
      }
      if (!next.successful) { this.abandon(next); return; }
      if (this.problem(next) && this.overview?.ready(next.build, next.layer, next.frame)) { this.abandon(next); this.stageOverview(); return; }
      if (!matches(this.coarse ?? this.active, next)) this.options.beforeReveal?.(next);
      this.map.setPaintProperty(next.id, 'raster-opacity', this.effectiveOpacity());
      if (this.active && this.active !== next) this.map.setPaintProperty(this.active.id, 'raster-opacity', 0);
      this.overview?.hide(); this.pendingPaint = next; this.cancelPrefetch(); return;
    }
    if (!this.stageOverview()) this.prepareNext();
  }

  private cancelPaint(): void {
    if (!this.pendingPaint && !this.pendingOverview) return;
    const eff = this.effectiveOpacity();
    if (this.pendingPaint) this.map.setPaintProperty(this.pendingPaint.id, 'raster-opacity', 0);
    if (this.coarse && this.overviewRevealed) this.options.beforeReveal?.(this.coarse);
    if (this.pendingOverview && this.coarse && this.overview?.cancelStage?.(eff)) {
      this.pendingPaint = this.pendingOverview = this.overviewRevealed = null;
      return;
    }
    this.pendingPaint = this.pendingOverview = this.overviewRevealed = null;
    if (this.coarse) this.options.beforeReveal?.(this.coarse);
    if (this.coarse && this.overview?.show(this.coarse.build, this.coarse.layer, this.coarse.frame, eff)) return;
    this.coarse = null; this.overview?.hide();
    if (this.active) { this.options.beforeReveal?.(this.active); this.map.setPaintProperty(this.active.id, 'raster-opacity', eff); }
  }

  private revealOverview(next: Selection): void {
    if (matches(this.overviewRevealed, next)) return;
    const previous = this.coarse ?? this.active, changed = !matches(previous, next);
    if (previous && changed) this.options.beforeReveal?.(next);
    if (!this.overview?.show(next.build, next.layer, next.frame, this.effectiveOpacity())) {
      this.pendingOverview = null;
      if (previous && changed) this.options.beforeReveal?.(previous);
      return;
    }
    if (!previous) this.options.beforeReveal?.(next);
    this.overviewRevealed = next;
    for (const s of this.slots) this.map.setPaintProperty(s.id, 'raster-opacity', 0);
  }

  private stageOverview(): boolean {
    const next = this.requested;
    if (!next || this.moving || this.map.isMoving?.() || !this.overview?.ready(next.build, next.layer, next.frame)) return false;
    if (matches(this.coarse, next) && !this.overview.needsUpdate?.(next.build, next.layer, next.frame)) return true;
    if (matches(this.pendingOverview, next)) {
      if (this.overview.canPaint?.() !== false) this.revealOverview(next);
      return true;
    }
    if (!this.overview.show(next.build, next.layer, next.frame, 0)) return false;
    this.pendingOverview = next;
    this.overviewRevealed = null;
    if (this.overview.canPaint?.() !== false) this.revealOverview(next);
    return true;
  }

  private clearOverview(): void {
    if (this.coarse && this.active && !matches(this.coarse, this.active)) this.drop(this.active);
    this.pendingOverview = this.coarse = this.overviewRevealed = null; this.overview?.clear();
    if (this.active && !this.pendingPaint) this.map.setPaintProperty(this.active.id, 'raster-opacity', this.effectiveOpacity());
  }

  private prepareOverview(sel: Selection): void {
    if (!this.overview?.supported) return;
    if (this.options.budget || canRetainRasterOverview(this.map, layerMaxZoom(sel.build.manifest, sel.layer), this.windActive, this.windResident)) {
      this.limitSlots(sel, true); this.overview.select(sel.build, sel.layer, sel.frame);
    } else this.clearOverview();
  }

  private cancelRefinement(): void { if (this.refineTimer !== null) { clearTimeout(this.refineTimer); this.refineTimer = null; } }

  private cancelFocus(): void { if (this.focusTimer !== null) { clearTimeout(this.focusTimer); this.focusTimer = null; } }

  private scheduleFocus(sel: Selection): void {
    this.cancelFocus();
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;
      const current = this.requested;
      if (this.disposed || this.moving || this.map.isMoving?.() || !current || !matches(sel, current)) return;
      this.prepareOverview(current);
    }, FOCUS_DWELL_MS);
  }

  private armDetail(sel: Selection): void {
    this.cancelRefinement();
    if (this.overview?.quality?.(sel.build, sel.layer, sel.frame) === 'detail') return;
    if (this.playing && this.overview?.supported) return;
    this.refineTimer = setTimeout(() => {
      this.refineTimer = null;
      if (matches(sel, this.requested) && !this.moving && !this.playing && sel.build.expiresAtMs > Date.now() && this.overview?.quality?.(sel.build, sel.layer, sel.frame) !== 'detail') {
        try { this.loadDetail(sel); } catch {}
      }
    }, 100);
  }

  private ensureProtocol(): void {
    if (this.protocol) return;
    this.protocol = createSourceRasterTileProtocol(this.baseUrl, { maxSources: MAX_RASTER_SOURCES, fetchImpl: this.fetchImpl, request: this.request, budget: this.options.budget, ...(this.options.requestLimits ?? { maxActive: 24, maxPrefetchActive: 20 }) });
    addProtocol(this.protocol.scheme, async (params, controller) => {
      const hashIdx = params.url.indexOf('#');
      const cleanUrl = hashIdx >= 0 ? params.url.slice(0, hashIdx) : params.url;
      const hashTheme = hashIdx >= 0 ? params.url.slice(hashIdx + 1) : '';
      const slotTheme: MapTheme = isMapTheme(hashTheme) ? hashTheme : this.theme;
      const response = await this.protocol!.load({ ...params, url: cleanUrl }, controller);
      if (!themeOption(slotTheme).remap || response.data.byteLength <= 48 || !canRemapTiles()) return response;
      const httpIdx = cleanUrl.indexOf('http');
      const rawUrl = httpIdx >= 0 ? cleanUrl.slice(httpIdx) : cleanUrl;
      let maskData: ArrayBuffer | null = null;
      if (rawUrl.includes('/usable-lift-msl/')) {
        const aglUrl = rawUrl.replace('/usable-lift-msl/', '/usable-lift-agl/');
        const maskRes = await this.protocol!.requestTile(aglUrl, { priority: 'foreground', signal: controller.signal }).response.catch(() => null);
        if (maskRes) { maskData = maskRes.data; maskRes.release(); }
      }
      const bitmap = await remapTileToBitmap(
        response.data,
        rawUrl.includes('/precip-rate/') ? 'rain' : 'lift',
        slotTheme,
        maskData,
        { priority: 'foreground', signal: controller.signal, transferInput: true }
      );
      return { ...response, data: bitmap };
    });
    this.overview = new RasterOverview(this.map, this.protocol, () => { this.update(); this.emit(); }, { ...this.options, theme: this.theme });
    if (this.playing) (this.overview as { setPlayback?(playing: boolean): void }).setPlayback?.(true);
  }

  private addSlot(sel: Selection, interactive: boolean): void {
    this.ensureProtocol();
    this.protocol!.setBuildExpiry(sel.build.manifest.buildId, sel.build.expiresAtMs);
    const bytes = rasterSourceBytes(this.map, layerMaxZoom(sel.build.manifest, sel.layer));
    const budget = this.options.budget, priority = interactive ? 'foreground' : 'background';
    if (budget && !this.rendererPool) {
      this.rendererPool = budget.reserve('raster-renderer', MAP_TEXTURE_POOL_RESERVE_BYTES, priority);
      if (!this.rendererPool) throw new RasterBudgetError('Raster renderer budget exhausted');
    }
    const lease = budget?.reserve('raster-renderer', bytes, priority) ?? null;
    if (budget && !lease) {
      if (!this.slots.length) { this.rendererPool?.release(); this.rendererPool = null; }
      throw new RasterBudgetError('Raster renderer budget exhausted');
    }
    let transport: RasterTileSourceTransport;
    try { transport = this.protocol!.createSource(interactive); } catch (error) {
      lease?.release();
      if (!this.slots.length) { this.rendererPool?.release(); this.rendererPool = null; }
      throw error;
    }
    const id = `av-overlay-${++this.generation}`;
    this.slots.push({ ...sel, id, transport, lease, successful: false, pending: new Set(), failed: new Set(), sourceFailed: false });
    if (!interactive) this.armStagingWatchdog(sel);
    const source = previewRasterSource(sel.build.templates[sel.layer], sel.frame, layerMaxZoom(sel.build.manifest, sel.layer), sel.build.manifest.descriptors.attribution);
    const suffix = canRemapTiles() ? `#${this.theme}` : '';
    source.tiles = source.tiles.map(url => `${transport.url(url)}${suffix}`);
    this.map.addSource(id, source);
    const layer = previewRasterLayer(0);
    this.map.addLayer({ ...layer, id, source: id, paint: { ...layer.paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } }, seamInsertBefore(this.map));
  }

  private problem(slot: Slot | null): boolean { return !!slot && (slot.sourceFailed || slot.failed.size > 0); }
  private tilesSettled(slot: Slot): boolean {
    return !this.moving && !this.map.isMoving?.() && !slot.pending.size && slot.build.expiresAtMs > Date.now() && this.map.isSourceLoaded(slot.id);
  }
  private abandonEmpty(slot: Slot): void {
    if (!this.slots.includes(slot) || slot === this.active || slot.successful || !this.tilesSettled(slot)) return;
    if (matches(slot, this.requested)) this.retryEmpty = !slot.failed.size;
    this.abandon(slot);
  }
  private abandon(slot: Slot): void {
    const req = matches(slot, this.requested);
    if (!req) this.warmFailed.push({ build: slot.build, layer: slot.layer, frame: slot.frame });
    this.drop(slot); this.cancelPrefetch();
    if (req) { this.replacementFailed = true; this.incomplete = this.problem(this.active); }
    this.armExpiry(); if (req) this.emit();
  }
  private cancelPrefetch(keep?: Selection): void {
    const template = keep && frameTileUrl(keep.build.templates[keep.layer], keep.frame);
    const prefix = template?.slice(0, template.indexOf('{z}'));
    for (const [url, ctrl] of this.prefetchJobs) if (!prefix || !url.startsWith(prefix)) { ctrl.abort(); this.prefetchJobs.delete(url); }
    this.prefetched = false; this.prefetchCursor = 0; this.prefetchPromises.clear();
  }
  private drop(slot: Slot): void {
    if (this.stagingSelection && matches(slot, this.stagingSelection) && slot !== this.active) this.clearStagingWatchdog();
    this.slots = this.slots.filter(v => v !== slot);
    if (this.active === slot) this.active = null;
    releaseAll([
      () => {
        if (slot !== this.pendingPaint) return;
        try { this.cancelPaint(); } finally { if (this.pendingPaint === slot) this.pendingPaint = null; }
      },
      () => { if (this.map.getLayer(slot.id)) this.map.removeLayer(slot.id); },
      () => { if (this.map.getSource(slot.id)) this.map.removeSource(slot.id); },
      () => slot.transport.dispose(), () => { slot.lease?.release(); slot.lease = null; },
      () => { if (!this.slots.length) { this.rendererPool?.release(); this.rendererPool = null; } }
    ]);
  }
  private emit(): void {
    const evictions = this.protocol?.stats().cacheEvictionGeneration ?? 0;
    if (evictions !== this.lastCacheEvictions) { this.lastCacheEvictions = evictions; if (this.byteReadyFrames.size) this.byteReadyFrames.clear(); }
    const displayed = this.coarse ?? this.active, st = this.overview?.state, readiness = this.overview?.readiness?.();
    if (this.detailState !== 'timed-out') this.refreshDetailState();
    const next: OverlayState = { displayed, requested: this.requested, quality: this.coarse ? this.overview?.quality?.(this.coarse.build, this.coarse.layer, this.coarse.frame) ?? 'overview' : this.active ? 'detail' : null,
      viewLoading: this.moving || !!(this.active && !this.coarse && !this.map.isSourceLoaded(this.active.id)),
      overviewReady: st?.ready ?? 0, overviewTotal: st?.total ?? 0, overviewFailed: st?.failed ?? 0,
      incomplete: !this.coarse && this.incomplete, replacementFailed: this.replacementFailed,
      previewReadyFrames: readiness?.previewReadyFrames ?? [], detailReadyFrames: readiness?.detailReadyFrames ?? [], limited: this.limited || !!readiness?.limited,
      detailState: this.detailState, cameraRevision: this.cameraRevision, requiredTiles: this.requiredKeys.size,
      loadedTiles: this.loadedKeys.size, pendingTiles: this.pendingKeys.size, erroredTiles: this.erroredKeys.size,
      coarseReadyFrames: readiness?.previewReadyFrames ?? [], detailBytesReadyFrames: [...this.byteReadyFrames],
      detailDrawableFrames: this.active && matches(this.active, this.requested) && this.active.successful && !this.problem(this.active) && this.tilesSettled(this.active) ? [this.active.frame] : [] };
    const pending = !!this.requested && !matches(displayed, this.requested) && !this.replacementFailed;
    if (pending !== this.selectedPending || (pending && !matches(this.pendingSelection, this.requested))) {
      this.selectedPending = pending; this.pendingSelection = pending ? this.requested : null;
      this.options.onSelectedPending?.(pending, this.requested);
    }
    const last = this.lastState;
    if (last && (last.displayed === next.displayed || matches(last.displayed, next.displayed))
      && (last.requested === next.requested || matches(last.requested, next.requested))
      && last.quality === next.quality && last.viewLoading === next.viewLoading
      && last.overviewReady === next.overviewReady && last.overviewTotal === next.overviewTotal
      && last.overviewFailed === next.overviewFailed && last.incomplete === next.incomplete && last.limited === next.limited
      && last.previewReadyFrames?.join('\0') === next.previewReadyFrames?.join('\0') && last.detailReadyFrames?.join('\0') === next.detailReadyFrames?.join('\0')
      && last.replacementFailed === next.replacementFailed && last.detailState === next.detailState
      && last.cameraRevision === next.cameraRevision && last.requiredTiles === next.requiredTiles
      && last.loadedTiles === next.loadedTiles && last.pendingTiles === next.pendingTiles && last.erroredTiles === next.erroredTiles
      && last.coarseReadyFrames?.join('\0') === next.coarseReadyFrames?.join('\0')
      && last.detailBytesReadyFrames?.join('\0') === next.detailBytesReadyFrames?.join('\0')
      && last.detailDrawableFrames?.join('\0') === next.detailDrawableFrames?.join('\0')) return;
    this.lastState = next; this.onState(next);
  }
  private clearStagingWatchdog(): void {
    if (this.stagingTimer !== null) { clearTimeout(this.stagingTimer); this.stagingTimer = null; }
    this.stagingSelection = null; this.stagingRevision = -1;
  }

  private armStagingWatchdog(sel: Selection): void {
    this.clearStagingWatchdog();
    this.stagingSelection = sel; this.stagingRevision = this.cameraRevision;
    this.stagingTimer = setTimeout(() => {
      this.stagingTimer = null;
      const slot = this.slots.find(candidate => candidate !== this.active && matches(candidate, sel));
      if (!slot) return;
      if (slot.successful && this.map.isSourceLoaded(slot.id)) { this.clearStagingWatchdog(); return; }
      const requested = matches(slot, this.requested);
      this.drop(slot);
      if (requested) { this.detailState = 'timed-out'; this.replacementFailed = true; this.incomplete = this.problem(this.active); }
      this.emit();
    }, STAGING_TIMEOUT_MS);
  }

  private refreshRequired(): void {
    this.detailState = 'idle';
    const sel = this.requested;
    this.requiredKeys.clear(); this.loadedKeys.clear(); this.pendingKeys.clear(); this.erroredKeys.clear();
    if (!sel || this.moving || this.map.isMoving?.()) { this.detailState = 'idle'; return; }
    const maxzoom = layerMaxZoom(sel.build.manifest, sel.layer), bounds = sel.build.manifest.descriptors.bounds;
    const covering = this.map.coveringTiles?.({ tileSize: 256, minzoom: 0, maxzoom, roundZoom: true }) ?? [];
    for (const tile of Array.isArray(covering) ? covering : []) {
      const canonical = tile?.canonical;
      if (!canonical) continue;
      if (bounds) {
        const n = 2 ** canonical.z, west = canonical.x / n * 360 - 180, east = (canonical.x + 1) / n * 360 - 180;
        const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * canonical.y / n))) * 180 / Math.PI;
        const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (canonical.y + 1) / n))) * 180 / Math.PI;
        if (east <= bounds[0] || west >= bounds[2] || north <= bounds[1] || south >= bounds[3]) continue;
      }
      const key = canonicalKey(canonical);
      if (key) this.requiredKeys.add(key);
    }
    this.refreshDetailState();
  }

  private refreshDetailState(): void {
    const slot = this.slots.find(candidate => matches(candidate, this.requested));
    const stationary = !this.moving && !this.map.isMoving?.();
    const sourceLoaded = !!slot && this.map.isSourceLoaded(slot.id), sourceErrored = !!slot?.sourceFailed;
    const required = this.requiredKeys, loaded = this.loadedKeys, pending = this.pendingKeys, errored = this.erroredKeys;
    if (!stationary) { this.detailState = 'idle'; return; }
    if (sourceLoaded && required.size === 0 && pending.size === 0 && !sourceErrored) { this.detailState = 'valid-empty'; return; }
    if (sourceLoaded && required.size > 0 && pending.size === 0 && !sourceErrored && [...required].every(key => loaded.has(key))) { this.detailState = 'complete'; return; }
    if (sourceLoaded && required.size > 0 && pending.size === 0 && [...required].some(key => loaded.has(key)) && ([...required].some(key => errored.has(key)) || sourceErrored)) { this.detailState = 'partial'; return; }
    if (sourceErrored || (required.size > 0 && pending.size === 0 && ![...required].some(key => loaded.has(key)) && [...required].some(key => errored.has(key)))) { this.detailState = 'failed'; return; }
    this.detailState = 'idle';
  }

  private armExpiry(): void {
    if (this.expiryTimer !== null) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    const deadline = Math.min(...this.slots.map(s => s.build.expiresAtMs));
    if (Number.isFinite(deadline)) this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.refresh(); }, Math.min(Math.max(0, deadline - Date.now()), 2_147_000_000));
  }
  private slotLimit(sel: Selection, overview = !!this.overview?.state.total): number {
    const zoom = layerMaxZoom(sel.build.manifest, sel.layer), key = zoom * 8 + Number(overview) * 4 + Number(this.windActive) * 2 + Number(this.windResident);
    let limit = this.sourceLimits.get(key);
    if (limit === undefined) { limit = rasterSourceLimit(this.map, zoom, overview, this.windActive, this.windResident); this.sourceLimits.set(key, limit); }
    return limit;
  }
  private limitSlots(sel: Selection, overview = !!this.overview?.state.total): number {
    const limit = Math.min(this.slotLimit(sel, overview), ...this.slots.map(s => this.slotLimit(s, overview)));
    if (limit <= 0) {
      while (this.slots.length > 0) this.drop(this.slots.findLast(s => s !== this.active) ?? this.active!);
      return 0;
    }
    const staging = this.active && !matches(this.active, this.requested) && !matches(this.coarse, this.requested)
      && this.slots.some(s => s !== this.active && matches(s, this.requested)) ? 1 : 0;
    const allowed = Math.max(limit, this.active ? 1 + staging : 0);
    while (this.slots.length > allowed) {
      this.drop(this.slots.findLast(s => s !== this.active && !matches(s, this.requested)) ?? this.slots.findLast(s => s !== this.active) ?? this.active!);
    }
    return limit;
  }
  private enforceBudget(): void {
    const sel = this.requested ?? this.active;
    if (!sel) return;
    if (this.options.budget) {
      for (const slot of [...this.slots].filter(s => s !== this.active)) {
        const bytes = rasterSourceBytes(this.map, layerMaxZoom(slot.build.manifest, slot.layer));
        if (slot.lease && !slot.lease.resize(bytes)) {
          this.limited = true;
          this.drop(slot);
        }
      }
      if (this.active?.lease) {
        const active = this.active, activeLease = active.lease!;
        const bytes = rasterSourceBytes(this.map, layerMaxZoom(active.build.manifest, active.layer));
        let resized = activeLease.resize(bytes);
        if (!resized) {
          for (const slot of [...this.slots]) if (slot !== active) this.drop(slot);
          this.overview?.relievePressure?.(Math.max(0, bytes - activeLease.bytes));
          resized = activeLease.resize(bytes);
          if (!resized && bytes <= activeLease.bytes + (this.options.budget.limit - this.options.budget.used)) {
            const oldBytes = activeLease.bytes;
            activeLease.release();
            active.lease = this.options.budget.reserve('raster-renderer', bytes, 'foreground') ?? this.options.budget.reserve('raster-renderer', oldBytes, 'foreground');
            resized = active.lease?.bytes === bytes;
          }
        }
        if (!resized) {
          this.limited = true;
          if (this.overview?.ready(active.build, active.layer, active.frame) && this.overview.show(active.build, active.layer, active.frame, this.effectiveOpacity())) {
            this.coarse = { build: active.build, layer: active.layer, frame: active.frame };
            this.drop(active);
          } else {
            this.drop(active);
            this.replacementFailed = true;
            this.incomplete = false;
          }
        }
      }
    }
    if (!this.options.budget && this.overview?.state.total && !canRetainRasterOverview(this.map, layerMaxZoom(sel.build.manifest, sel.layer), this.windActive, this.windResident)) this.clearOverview();
    if (!this.limitSlots(sel)) { this.cancelRefinement(); this.cancelPrefetch(); this.replacementFailed = true; this.incomplete = false; }
    else if (this.active && matches(this.active, this.requested) && !this.problem(this.active)) this.replacementFailed = false;
    this.armExpiry(); this.emit();
  }
  private predicted(slot: Selection | null = this.active): Selection[] {
    if (!slot) return [];
    const selections: Selection[] = [];
    const add = (layer: LayerId, frame: string | undefined) => {
      if (!frame || !slot.build.templates[layer]) return;
      const v = { build: slot.build, layer, frame };
      if (!matches(v, slot) && !selections.some(i => matches(i, v))) selections.push(v);
    };
    if (this.preferred?.build === slot.build) add(this.preferred.layer, this.preferred.frame);
    const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(f => f.id === slot.frame);
    const siblings = (Object.keys(slot.build.templates) as LayerId[]).filter(id => id !== slot.layer);
    const primary = slot.layer === 'usable-lift-agl' ? 'usable-lift-msl' : slot.layer === 'usable-lift-msl' ? 'usable-lift-agl' : siblings[0];
    if (!this.direction && primary) add(primary, slot.frame);
    const step = frames[index + (this.direction ?? 1)] ? this.direction ?? 1 : -(this.direction ?? 1);
    for (const offset of this.direction ? [step, 2 * step, -step] : [step, -step, 2 * step]) add(slot.layer, frames[index + offset]?.id);
    for (const sib of siblings) add(sib, slot.frame);
    return selections;
  }
  private prepareNext(): void {
    if (this.playing) return;
    if (this.disposed || this.pendingPaint || this.pendingOverview || this.moving || this.map.isMoving?.() || !this.active || !matches(this.active, this.requested) || this.active.build.expiresAtMs <= Date.now()) return;
    if (this.overview?.supported && this.overview.state.ready + this.overview.state.failed < this.overview.state.total) return;
    const candidates = this.predicted(), limit = Math.min(this.slotLimit(this.active), ...candidates.map(v => this.slotLimit(v)));
    if (!limit) { this.enforceBudget(); return; }
    const desired = candidates.slice(0, limit - 1);
    for (const s of [...this.slots]) if (s !== this.active && !desired.some(v => matches(s, v))) this.drop(s);
    for (const next of desired) {
      if (this.warmFailed.some(v => matches(v, next))) continue;
      const slot = this.slots.find(s => matches(s, next));
      if (slot) {
        if (!slot.successful || !this.tilesSettled(slot)) return;
        if (this.problem(slot)) { this.abandon(slot); return; }
        continue;
      }
      this.cancelPrefetch(next);
      try { this.addSlot(next, false); this.armExpiry(); }
      catch { const failed = this.slots.find(s => matches(s, next)); if (failed) this.abandon(failed); else this.warmFailed.push(next); }
      return;
    }
    this.prefetchBytes();
  }
  private timelineFrames(slot: Slot): string[] {
    const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(f => f.id === slot.frame);
    const before = frames.slice(0, index).reverse(), after = frames.slice(index + 1);
    return (this.direction === -1 ? [...before, ...after] : [...after, ...before]).map(f => f.id);
  }
  private prefetchOne(url: string): Promise<boolean> {
    const existing = this.prefetchPromises.get(url);
    if (existing) return existing;
    if (!this.protocol) return Promise.resolve(false);
    const ctrl = new AbortController(); this.prefetchJobs.set(url, ctrl);
    const promise = this.protocol.prefetch(url, ctrl.signal).then(() => true).catch(() => false).finally(() => {
      if (this.prefetchJobs.get(url) === ctrl) this.prefetchJobs.delete(url);
      if (this.prefetchPromises.get(url) === promise) this.prefetchPromises.delete(url);
    });
    this.prefetchPromises.set(url, promise);
    return promise;
  }

  private prefetchBytes(): void {
    const slot = this.active;
    if (this.disposed || this.playing || this.moving || !slot || !matches(slot, this.requested) || !this.protocol || this.prefetched) return;
    this.prefetched = true;
    const bounds = this.map.getBounds(), z = Math.min(layerMaxZoom(slot.build.manifest, slot.layer), Math.max(0, Math.round(this.map.getZoom()) + 1));
    const tiles = viewportTiles({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() }, z);
    const prepared = this.slots.filter(v => v.successful && !this.problem(v) && this.tilesSettled(v));
    const warming = this.warmth.update(boundsAreaKm2(cameraBounds(this.map))), timeline = this.timelineFrames(slot);
    if (warming && !this.requiredKeys.size) this.refreshRequired();
    const useKeyedHorizon = warming && this.requiredKeys.size > 0;
    if (!useKeyedHorizon) {
      const urls = planViewportPrefetch({ build: slot.build, activeLayer: slot.layer, activeFrame: slot.frame, viewportTiles: tiles,
        preferred: this.predicted()[0], direction: this.direction, prepared, timelineFrames: warming ? timeline : timeline.slice(0, 4) });
      for (const url of new Set(urls)) void this.prefetchOne(url);
    }
    const preparedFrames = new Set(prepared.map(item => item.frame));
    for (const frame of warming ? timeline : timeline.slice(0, 4)) if (preparedFrames.has(frame) && !this.byteReadyFrames.has(frame)) { this.byteReadyFrames.add(frame); this.emit(); }
    const template = slot.build.templates[slot.layer];
    if (!useKeyedHorizon || this.prefetching || !template) return;
    const perFrame = this.requiredKeys.size;
    const batch = timeline.slice(this.prefetchCursor, this.prefetchCursor + Math.max(1, Math.floor(64 / Math.min(perFrame, 64))));
    if (!batch.length) return;
    this.prefetching = true; this.prefetchCursor += batch.length;
    const jobs = batch.map(async frame => {
      const frameTemplate = frameTileUrl(template, frame);
      const frameUrls = [...this.requiredKeys].map(key => {
        const [z, x, y] = key.split('/');
        return frameTemplate.replaceAll('{z}', z!).replaceAll('{x}', x!).replaceAll('{y}', y!);
      });
      if (!frameUrls.length) return false;
      let ok = true;
      for (let index = 0; index < frameUrls.length; index += 64) {
        const results = await Promise.all(frameUrls.slice(index, index + 64).map(url => this.prefetchOne(url)));
        if (!results.every(Boolean)) { ok = false; break; }
      }
      if (ok && !this.disposed) { this.byteReadyFrames.add(frame); this.emit(); }
      return ok;
    });
    void Promise.all(jobs).finally(() => {
      this.prefetching = false;
      if (!this.disposed && !this.playing && this.active === slot && matches(slot, this.requested) && this.prefetchCursor < timeline.length && this.warmth.warming) {
        this.prefetched = false; queueMicrotask(() => this.prefetchBytes());
      }
    });
  }
}
