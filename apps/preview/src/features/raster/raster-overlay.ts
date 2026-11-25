import type { Map } from 'maplibre-gl';
import { createSourceRasterTileProtocol, layerMaxZoom, type ForecastRequestHandle, type ForecastRequestSpec, type PinnedBuild, type PreparationBudget, type RasterTileSourceProtocol } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { removeProtocol } from 'maplibre-gl';
import { canRetainRasterOverview, MAX_RASTER_SOURCES } from './raster-budget';
import { FOCUS_DWELL_MS, RasterOverview, type PreviewDraw } from './raster-overview';
import type { ChannelView, MapChannel } from '../../channels/channel';
import { DEFAULT_THEME, type MapTheme } from '../../themes/registry';
import { coveredTileKeys, DetailTracker } from './detail-readiness';
import { sameOverlayState, type OverlayState } from './overlay-state';
import { bindRasterMapEvents } from './raster-map-events';
import { BytePrefetcher, predictSelections } from './raster-prefetch';
import { registerRasterProtocol } from './raster-protocol';
import { RasterStaging } from './raster-staging';
import { matches, RasterBudgetError, releaseAll, SlotPool, type RasterSelection, type Slot } from './raster-slots';

export type { OverlayState } from './overlay-state';
type Selection = RasterSelection;
export interface RasterOverlayOptions { budget?: PreparationBudget; protectedBytes?: () => number; canExpandNative?: () => boolean; beforeReveal?: (selection: RasterSelection) => void; onSelectedPending?: (pending: boolean, selection: RasterSelection | null) => void; requestLimits?: { maxActive: number; maxPrefetchActive: number }; theme?: MapTheme }

/**
 * Owns the displayed raster and a bounded prepared window; dispose with the map.
 * Slots and budget live in `SlotPool`, the overview/detail paint handoff in `RasterStaging`, tile
 * accounting in `DetailTracker` and byte warming in `BytePrefetcher`; this class sequences them.
 */
export class RasterOverlay implements MapChannel {
  private protocol: RasterTileSourceProtocol | null = null;
  private readonly pool: SlotPool;
  private readonly prefetch: BytePrefetcher;
  private readonly detail = new DetailTracker();
  private readonly paint: RasterStaging;
  private overview: RasterOverview | null = null;
  private refineTimer: ReturnType<typeof setTimeout> | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private requested: Selection | null = null;
  private preferred: Selection | null = null;
  private warmFailed: Selection[] = [];
  private direction: 1 | -1 | undefined;
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
  private disposed = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private selectedPending = false;
  private pendingSelection: Selection | null = null;
  private limited = false;
  private overviewUpdateQueued = false;
  private cameraRevision = 0;
  private readonly unbind: (() => void)[];
  private unsubscribeBudget: (() => void) | null = null;

  constructor(private readonly map: Map, private readonly baseUrl: string, opacity: number, private readonly onState: (state: OverlayState) => void, private readonly fetchImpl?: typeof fetch, private readonly request?: (spec: ForecastRequestSpec) => ForecastRequestHandle, private readonly options: RasterOverlayOptions = {}) {
    this.opacity = opacity;
    this.theme = options.theme ?? DEFAULT_THEME;
    this.paint = new RasterStaging({
      map, overview: () => this.overview, active: () => this.active, slots: () => this.slots, requested: () => this.requested,
      moving: () => this.moving, opacity: () => this.effectiveOpacity(), beforeReveal: sel => this.options.beforeReveal?.(sel), drop: slot => this.pool.drop(slot)
    });
    this.pool = new SlotPool(map, options.budget, {
      releasePaint: slot => {
        if (slot !== this.paint.pendingPaint) return;
        try { this.paint.cancel(); } finally { if (this.paint.pendingPaint === slot) this.paint.pendingPaint = null; }
      },
      stationary: () => !this.moving, requested: () => this.requested, cameraRevision: () => this.cameraRevision,
      timedOut: requested => {
        if (requested) { this.detail.state = 'timed-out'; this.replacementFailed = true; this.incomplete = this.pool.problem(this.active); }
        this.emit();
      }
    });
    this.prefetch = new BytePrefetcher({
      map, protocol: () => this.protocol, disposed: () => this.disposed, direction: () => this.direction,
      target: () => !this.disposed && !this.moving && this.active && matches(this.active, this.requested) ? this.active : null,
      current: slot => !this.disposed && this.active === slot && matches(slot, this.requested),
      prepared: () => this.slots.filter(v => this.pool.ready(v)), preferred: () => this.predicted()[0],
      requiredKeys: () => this.detail.required, refreshRequired: () => this.refreshRequired(), emit: () => this.emit()
    });
    this.unbind = bindRasterMapEvents(map, {
      ownsOverviewSource: id => !!this.overview && (this.overview.ownsSource?.(id) ?? id === this.overview.id),
      overviewData: () => {
        // ImageSource.updateImage emits synchronously before show finishes its ownership transfer.
        if (this.overviewUpdateQueued) return;
        this.overviewUpdateQueued = true;
        queueMicrotask(() => {
          this.overviewUpdateQueued = false;
          if (!this.disposed) { this.advance(); this.emit(); }
        });
      },
      slot: id => this.slots.find(s => s.id === id),
      tileLoaded: (slot, tile, key) => {
        slot.pending.delete(tile); slot.successful = true;
        const recovered = slot.failed.delete(tile);
        if (matches(slot, this.requested) && key) { this.detail.load(key); this.refreshDetailState(); }
        if (slot === this.active) { if (recovered) this.incomplete = this.pool.problem(slot); this.emit(); }
        else if (matches(slot, this.requested)) queueMicrotask(() => { if (!this.disposed) { this.advance(); this.emit(); } });
      },
      sourceIdle: slot => {
        if (slot === this.active) return;
        queueMicrotask(() => {
          if (this.disposed) return;
          this.abandonEmpty(slot);
          this.advance();
          this.emit();
        });
      },
      tileLoading: (slot, tile, key) => {
        if (slot !== this.active) slot.pending.add(tile);
        if (matches(slot, this.requested) && key) { this.detail.loading(key); this.refreshDetailState(); }
        if (slot === this.active) this.emit();
      },
      tileAborted: (slot, tile, key) => {
        slot.pending.delete(tile);
        const recovered = slot.failed.delete(tile);
        if (matches(slot, this.requested) && key) { this.detail.abort(key); this.refreshDetailState(); }
        if (slot === this.active) { if (recovered) this.incomplete = this.pool.problem(slot); this.emit(); }
      },
      tileFailed: (slot, tile, key) => {
        slot.failed.add(tile); slot.pending.delete(tile);
        if (matches(slot, this.requested) && key) { this.detail.error(key); this.refreshDetailState(); }
        if (slot === this.active) { this.incomplete = true; this.emit(); return; }
        if (this.pool.settled(slot) && (!slot.successful || !matches(slot, this.requested))) this.abandon(slot);
      },
      sourceFailed: slot => {
        slot.sourceFailed = true;
        if (slot !== this.active) this.abandon(slot); else { this.incomplete = true; this.emit(); }
      },
      render: () => this.render(), moveStart: () => this.moveStart(), move: () => this.viewChanged(),
      moveEnd: () => this.settled(), idle: () => this.idle(), resize: () => this.resized()
    });
    this.unsubscribeBudget = options.budget?.onRelease(() => {
      if (this.disposed || !this.limited || !this.requested || this.moving || this.map.isMoving?.()) return;
      this.limited = false;
      this.enforceBudget();
      if (this.requested && !this.slots.some(s => matches(s, this.requested)) && !matches(this.paint.coarse, this.requested)) {
        try { this.loadDetail(this.requested); } catch {}
      }
      this.prepareNext();
      this.emit();
    }) ?? null;
  }

  private get active(): Slot | null { return this.pool.active; }
  private set active(slot: Slot | null) { this.pool.active = slot; }
  private get slots(): Slot[] { return this.pool.slots; }

  private render(): void {
    const overviewPainted = this.overview?.painted ? this.overview.painted() : true;
    if (this.paint.pendingOverview) {
      const step = this.paint.renderOverview(overviewPainted);
      if (step === 'stale') { this.refresh(); this.emit(); }
      else if (step === 'committed') { this.emit(); this.advance(); }
      return;
    }
    const next = this.paint.pendingPaint;
    if (!next) { this.advance(); return; }
    if (next.build.expiresAtMs <= Date.now()) { this.refresh(); return; }
    this.paint.pendingPaint = null;
    const previous = this.active;
    this.pool.unwatch(); this.active = next; this.paint.coarse = null;
    next.transport.setInteractive(true);
    if (previous !== next) previous?.transport.setInteractive(false);
    this.replacementFailed = false; this.incomplete = this.pool.problem(next);
    for (const slot of [...this.slots]) if (slot !== next && (slot.build !== next.build || this.pool.problem(slot))) this.pool.drop(slot);
    this.limitSlots(next);
    if (previous && previous.build.manifest.buildId !== next.build.manifest.buildId) this.protocol?.evictBuild(previous.build.manifest.buildId);
    queueMicrotask(() => this.prepareNext());
    this.armExpiry(); this.emit();
  }
  private moveStart(): void {
    this.cameraRevision++; this.detail.invalidate(); this.prefetch.clearReady();
    this.paint.cancel(); this.cancelRefinement(); this.cancelFocus();
    this.moving = true; this.preferred = null; this.warmFailed = []; this.pool.clearLimits(); this.prefetch.cancel();
    for (const slot of [...this.slots]) if (slot !== this.active && !matches(slot, this.requested)) this.pool.drop(slot);
    this.armExpiry(); this.emit();
  }
  private viewChanged(): void { this.cameraRevision++; this.detail.invalidate(); this.prefetch.clearReady(); this.pool.clearLimits(); this.enforceBudget(); }
  private resized(): void {
    this.cameraRevision++; this.refreshRequired(); this.prefetch.clearReady();
    this.paint.cancel(); this.cancelRefinement(); this.cancelFocus();
    this.pool.clearLimits(); this.preferred = null; this.warmFailed = []; this.prefetch.cancel();
    for (const slot of [...this.slots]) if (slot !== this.active && !matches(slot, this.requested)) this.pool.drop(slot);
    this.enforceBudget();
    if (this.requested && !this.moving) {
      this.prepareOverview(this.requested);
      try { this.loadDetail(this.requested); } catch {}
    }
    this.prepareNext(); this.armExpiry(); this.emit();
  }
  private settled(): boolean {
    if (!this.moving || this.map.isMoving?.()) return false;
    this.moving = false; this.cameraRevision++; this.refreshRequired(); this.pool.clearLimits(); this.enforceBudget();
    const sel = this.requested, pending = this.slots.find(s => s !== this.active && matches(s, sel));
    if (sel && this.overview?.hasExtent() && !this.overview.coversView()) {
      this.scheduleFocus(sel); this.emit(); return false;
    }
    if (sel) this.prepareOverview(sel);
    if ((!pending && !this.retryEmpty && matches(this.active, sel)) || !sel || sel.build.expiresAtMs <= Date.now()) {
      this.prepareNext(); this.emit(); return false;
    }
    if (pending) this.pool.drop(pending);
    try { this.select(sel.build, sel.layer, sel.frame); } catch {}
    return true;
  }
  private idle(): void {
    if (this.settled()) return;
    this.advance();
    for (const slot of [...this.slots]) if (slot !== this.active) this.abandonEmpty(slot);
    this.prepareNext(); this.emit();
  }

  /** Copies `frame`'s overview of the current view into `target`; see `RasterOverview.drawPreview`. */
  drawPreview(build: PinnedBuild, layer: LayerId, frame: string, target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, width: number, height: number): PreviewDraw {
    return this.disposed ? 'unavailable' : this.overview?.drawPreview(build, layer, frame, target, width, height) ?? 'pending';
  }

  /** Overview frames to prepare right after the selected one. */
  preferPreviewFrames(frames: readonly string[]): void { this.overview?.preferFrames(frames); }

  isPrepared(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    const slot = this.pool.find({ build, layer, frame });
    return !this.disposed && !!slot && this.pool.ready(slot);
  }


  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (this.disposed) return;
    if (build.expiresAtMs <= Date.now()) { this.clear(); return; }
    this.ensureProtocol(); this.cancelRefinement();
    this.moving ||= this.map.isMoving?.() ?? false;
    const prev = this.requested;
    this.detail.state = 'idle';
    if (!prev || prev.build !== build || prev.layer !== layer) this.prefetch.clearReady();
    if (prev?.build === build && prev.layer === layer && prev.frame !== frame) {
      const frames = renderedFrames(build.manifest);
      this.direction = frames.findIndex(i => i.id === frame) > frames.findIndex(i => i.id === prev.frame) ? 1 : -1;
    } else if (prev?.layer !== layer || prev?.build !== build) this.direction = undefined;
    this.retryEmpty = false; this.preferred = null; this.warmFailed = [];
    this.requested = { build, layer, frame };
    if ((this.paint.pendingPaint && !matches(this.paint.pendingPaint, this.requested)) || (this.paint.pendingOverview && !matches(this.paint.pendingOverview, this.requested))) this.paint.cancel();
    this.enforceBudget();
    if (!this.moving) this.prepareOverview(this.requested);
    this.replacementFailed = false; this.incomplete = this.pool.problem(this.active);
    if (matches(this.active, this.requested) && !this.active?.staleTheme) {
      for (const s of this.slots) if (s !== this.active) s.transport.setInteractive(false);
      this.prefetch.cancel(); this.advance(); this.emit(); return;
    }
    let target = this.slots.find(s => matches(s, this.requested) && !s.staleTheme);
    if (target && this.pool.problem(target)) { this.pool.drop(target); target = undefined; }
    const ready = this.isPrepared(build, layer, frame), future = this.predicted(this.requested);
    for (const s of [...this.slots]) {
      if (s === this.active || s === target) continue;
      if (s.build !== build || s.staleTheme || this.pool.problem(s) || ((!s.successful || !this.pool.settled(s)) && (!ready || !future.some(v => matches(s, v))))) this.pool.drop(s);
      else s.transport.setInteractive(false);
    }
    if (target) { target.transport.setInteractive(true); this.prefetch.cancel(); this.emit(); this.advance(); return; }
    this.prefetch.cancel(this.requested); this.emit();
    this.paint.stageOverview();
    if (this.overview?.state.total) { this.armDetail(this.requested); return; }
    this.loadDetail(this.requested);
  }

  private loadDetail(sel: Selection): void {
    if (!matches(sel, this.requested) || this.slots.some(s => matches(s, sel) && !s.staleTheme)) return;
    const limit = this.slotLimit(sel);
    if (!limit) { this.cancelRefinement(); this.prefetch.cancel(); this.replacementFailed = true; this.armExpiry(); this.emit(); return; }
    for (const s of [...this.slots]) if (s !== this.active) this.pool.drop(s);
    if (this.slots.length >= limit && matches(this.paint.coarse, sel) && this.active) this.pool.drop(this.active);
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
                this.paint.coarse = { build: this.active.build, layer: this.active.layer, frame: this.active.frame };
              }
              this.pool.drop(this.active);
              this.addSlot(sel, true);
            } else throw retryError;
          }
        } else throw error;
      }
      this.limited = false; this.replacementFailed = false; this.prefetch.cancel(sel); this.armExpiry(); this.emit();
    } catch (error) {
      const failed = this.slots.find(s => matches(s, this.requested));
      if (failed) this.pool.drop(failed);
      this.replacementFailed = true; this.prefetch.cancel();
      if (error instanceof RasterBudgetError) { this.limited = true; this.emit(); return; }
      this.emit(); throw error;
    }
  }

  prepare(layer: LayerId, frame: string): void {
    const build = this.active?.build;
    if (!build || !build.templates[layer] || !renderedFrames(build.manifest).some(i => i.id === frame)) return;
    this.preferred = { build, layer, frame }; this.warmFailed = []; this.prefetch.cancel(); this.prepareNext();
  }

  refresh(): void {
    this.overview?.refresh();
    const stale = this.paint.coarse && this.paint.coarse.build.expiresAtMs <= Date.now();
    if (stale) this.paint.clearOverview();
    if (this.paint.pendingOverview && !this.overview?.ready(this.paint.pendingOverview.build, this.paint.pendingOverview.layer, this.paint.pendingOverview.frame)) this.paint.cancel();
    let changed = false;
    for (const s of [...this.slots]) if (s.build.expiresAtMs <= Date.now()) {
      this.pool.drop(s); this.protocol?.evictBuild(s.build.manifest.buildId); changed = true;
    }
    if (changed) { this.preferred = null; this.prefetch.cancel(); this.armExpiry(); this.emit(); }
  }

  private effectiveOpacity(): number { return this.visible ? this.opacity : 0; }

  update(view: ChannelView): void {
    this.setTheme(view.theme);
    const visible = view.liftVisible && !view.peeking;
    if (visible === this.visible && view.opacity === this.opacity) return;
    this.visible = visible;
    this.setOpacity(view.opacity);
  }

  setOpacity(value: number): void {
    this.opacity = value;
    const eff = this.effectiveOpacity();
    const coarse = this.paint.pendingOverview ?? (this.paint.pendingPaint ? null : this.paint.coarse);
    if (coarse) { this.overview?.show(coarse.build, coarse.layer, coarse.frame, eff); return; }
    const visible = this.paint.pendingPaint ?? this.active;
    if (visible) this.map.setPaintProperty(visible.id, 'raster-opacity', eff);
  }

  setTheme(theme: MapTheme): void {
    if (this.theme === theme || this.disposed) return;
    this.theme = theme;
    this.overview?.setTheme(theme);
    for (const s of [...this.slots]) if (s !== this.active) this.pool.drop(s);
    if (this.active) this.active.staleTheme = true;
    const sel = this.requested;
    if (sel && !this.moving && !this.map.isMoving?.() && sel.build.expiresAtMs > Date.now()) {
      try { this.loadDetail(sel); } catch {}
    }
  }

  setWindActive(active: boolean, numericResident = active): void {
    if (this.windActive === active && this.windResident === numericResident) return;
    this.windActive = active; this.windResident = numericResident;
    this.pool.clearLimits(); this.enforceBudget();
    const sel = this.requested;
    if (sel && !this.moving && !this.map.isMoving?.() && sel.build.expiresAtMs > Date.now()) {
      try { this.select(sel.build, sel.layer, sel.frame); } catch {}
    }
    this.prepareNext();
  }

  clear(dispose = false): void {
    this.cancelRefinement(); this.cancelFocus();
    const overview = this.overview, protocol = this.protocol;
    const { slots, rendererPool } = this.pool.detach();
    const ids = new Set(slots.map(s => s.build.manifest.buildId));
    if (this.expiryTimer !== null) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    this.paint.pendingPaint = this.paint.pendingOverview = this.paint.coarse = this.paint.revealed = null;
    this.requested = this.preferred = null; this.warmFailed = []; this.direction = undefined; this.pool.clearLimits();
    if (dispose) { this.overview = null; this.protocol = null; }
    this.incomplete = this.replacementFailed = this.retryEmpty = this.limited = false;
    releaseAll([
      () => this.prefetch.cancel(), () => overview?.clear(),
      ...slots.map(slot => () => this.pool.drop(slot)),
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
    this.pool.relieve(budget, requiredBytes, slot => slot === this.active || slot === this.paint.pendingPaint || matches(slot, this.requested));
    return budget.used < before;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    const unsubscribe = this.unsubscribeBudget; this.unsubscribeBudget = null;
    releaseAll([() => unsubscribe?.(), () => this.clear(true), ...this.unbind]);
  }

  private advance(): void {
    const now = Date.now();
    if ((this.paint.coarse && this.paint.coarse.build.expiresAtMs <= now) || this.slots.some(slot => slot.build.expiresAtMs <= now)) this.refresh();
    if (this.paint.pendingOverview) {
      if (this.overview?.canPaint?.() !== false) this.paint.reveal(this.paint.pendingOverview);
      return;
    }
    if (this.paint.pendingPaint) return;
    const next = this.slots.find(s => matches(s, this.requested) && !s.staleTheme);
    if (next === this.active && !this.paint.coarse && !(this.pool.problem(next) && this.overview?.ready(next.build, next.layer, next.frame))) { this.prepareNext(); return; }
    if (next && (next.successful || next.failed.size) && this.pool.settled(next)) {
      const staged = this.pool.stagedRevision(next);
      if (staged !== undefined) {
        if (this.cameraRevision !== staged) { this.abandon(next); this.refreshRequired(); return; }
        this.pool.unwatch();
      }
      if (!next.successful) { this.abandon(next); return; }
      if (this.pool.problem(next) && this.overview?.ready(next.build, next.layer, next.frame)) { this.abandon(next); this.paint.stageOverview(); return; }
      if (!matches(this.paint.coarse ?? this.active, next)) this.options.beforeReveal?.(next);
      this.map.setPaintProperty(next.id, 'raster-opacity', this.effectiveOpacity());
      if (this.active && this.active !== next) this.map.setPaintProperty(this.active.id, 'raster-opacity', 0);
      this.overview?.hide(); this.paint.pendingPaint = next; this.prefetch.cancel(); return;
    }
    if (!this.paint.stageOverview()) this.prepareNext();
  }

  private prepareOverview(sel: Selection): void {
    if (!this.overview?.supported) return;
    if (this.options.budget || canRetainRasterOverview(this.map, layerMaxZoom(sel.build.manifest, sel.layer), this.windActive, this.windResident)) {
      this.limitSlots(sel, true); this.overview.select(sel.build, sel.layer, sel.frame);
    } else this.paint.clearOverview();
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
    this.refineTimer = setTimeout(() => {
      this.refineTimer = null;
      if (matches(sel, this.requested) && !this.moving && sel.build.expiresAtMs > Date.now() && this.overview?.quality?.(sel.build, sel.layer, sel.frame) !== 'detail') {
        try { this.loadDetail(sel); } catch {}
      }
    }, 100);
  }

  private ensureProtocol(): void {
    if (this.protocol) return;
    this.protocol = createSourceRasterTileProtocol(this.baseUrl, { maxSources: MAX_RASTER_SOURCES, fetchImpl: this.fetchImpl, request: this.request, budget: this.options.budget, ...(this.options.requestLimits ?? { maxActive: 24, maxPrefetchActive: 20 }) });
    registerRasterProtocol(() => this.protocol, this.protocol.scheme, () => this.theme);
    this.overview = new RasterOverview(this.map, this.protocol, () => { this.advance(); this.emit(); }, { ...this.options, theme: this.theme });
  }

  private addSlot(sel: Selection, interactive: boolean): void {
    this.ensureProtocol();
    this.pool.add(this.protocol!, sel, interactive, this.theme);
  }

  private abandonEmpty(slot: Slot): void {
    if (!this.slots.includes(slot) || slot === this.active || slot.successful || !this.pool.settled(slot)) return;
    if (matches(slot, this.requested)) this.retryEmpty = !slot.failed.size;
    this.abandon(slot);
  }
  private abandon(slot: Slot): void {
    const req = matches(slot, this.requested);
    if (!req) this.warmFailed.push({ build: slot.build, layer: slot.layer, frame: slot.frame });
    this.pool.drop(slot); this.prefetch.cancel();
    if (req) { this.replacementFailed = true; this.incomplete = this.pool.problem(this.active); }
    this.armExpiry(); if (req) this.emit();
  }
  private emit(): void {
    this.prefetch.syncEvictions(this.protocol?.stats().cacheEvictionGeneration ?? 0);
    const displayed = this.paint.coarse ?? this.active, st = this.overview?.state, readiness = this.overview?.readiness?.();
    if (this.detail.state !== 'timed-out') this.refreshDetailState();
    const next: OverlayState = { displayed, requested: this.requested, quality: this.paint.coarse ? this.overview?.quality?.(this.paint.coarse.build, this.paint.coarse.layer, this.paint.coarse.frame) ?? 'overview' : this.active ? 'detail' : null,
      viewLoading: this.moving || !!(this.active && !this.paint.coarse && !this.map.isSourceLoaded(this.active.id)),
      overviewReady: st?.ready ?? 0, overviewTotal: st?.total ?? 0, overviewFailed: st?.failed ?? 0,
      incomplete: !this.paint.coarse && this.incomplete, replacementFailed: this.replacementFailed,
      previewReadyFrames: readiness?.previewReadyFrames ?? [], detailReadyFrames: readiness?.detailReadyFrames ?? [], limited: this.limited || !!readiness?.limited,
      detailState: this.detail.state, cameraRevision: this.cameraRevision, ...this.detail.counts(),
      coarseReadyFrames: readiness?.previewReadyFrames ?? [], detailBytesReadyFrames: this.prefetch.readyFrames,
      detailDrawableFrames: this.active && matches(this.active, this.requested) && this.pool.ready(this.active) ? [this.active.frame] : [] };
    const pending = !!this.requested && !matches(displayed, this.requested) && !this.replacementFailed;
    if (pending !== this.selectedPending || (pending && !matches(this.pendingSelection, this.requested))) {
      this.selectedPending = pending; this.pendingSelection = pending ? this.requested : null;
      this.options.onSelectedPending?.(pending, this.requested);
    }
    if (sameOverlayState(this.lastState, next)) return;
    this.lastState = next; this.onState(next);
  }
  private refreshRequired(): void {
    const sel = this.requested;
    this.detail.reset();
    if (!sel || this.moving || this.map.isMoving?.()) return;
    const maxzoom = layerMaxZoom(sel.build.manifest, sel.layer);
    this.detail.require(coveredTileKeys(this.map.coveringTiles?.({ tileSize: 256, minzoom: 0, maxzoom, roundZoom: true }) ?? [], sel.build.manifest.descriptors.bounds));
    this.refreshDetailState();
  }

  private refreshDetailState(): void {
    const slot = this.pool.find(this.requested);
    const stationary = !this.moving && !this.map.isMoving?.();
    this.detail.refresh({ stationary, sourceLoaded: !!slot && this.map.isSourceLoaded(slot.id), sourceErrored: !!slot?.sourceFailed });
  }

  private armExpiry(): void {
    if (this.expiryTimer !== null) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    const deadline = Math.min(...this.slots.map(s => s.build.expiresAtMs));
    if (Number.isFinite(deadline)) this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.refresh(); }, Math.min(Math.max(0, deadline - Date.now()), 2_147_000_000));
  }
  private slotLimit(sel: Selection, overview = !!this.overview?.state.total): number {
    return this.pool.limit(sel, overview, this.windActive, this.windResident);
  }
  private limitSlots(sel: Selection, overview = !!this.overview?.state.total): number {
    const limit = Math.min(this.slotLimit(sel, overview), ...this.slots.map(s => this.slotLimit(s, overview)));
    if (limit <= 0) { this.pool.dropAll(); return 0; }
    const staging = this.active && !matches(this.active, this.requested) && !matches(this.paint.coarse, this.requested)
      && this.slots.some(s => s !== this.active && matches(s, this.requested)) ? 1 : 0;
    this.pool.trim(Math.max(limit, this.active ? 1 + staging : 0));
    return limit;
  }
  private enforceBudget(): void {
    const sel = this.requested ?? this.active;
    if (!sel) return;
    if (this.options.budget) {
      this.pool.fitStandby(() => { this.limited = true; });
      const active = this.active;
      if (active?.lease && !this.pool.fitActive(active, bytes => this.overview?.relievePressure?.(bytes))) {
        this.limited = true;
        if (this.overview?.ready(active.build, active.layer, active.frame) && this.overview.show(active.build, active.layer, active.frame, this.effectiveOpacity())) {
          this.paint.coarse = { build: active.build, layer: active.layer, frame: active.frame };
          this.pool.drop(active);
        } else {
          this.pool.drop(active);
          this.replacementFailed = true;
          this.incomplete = false;
        }
      }
    }
    if (!this.options.budget && this.overview?.state.total && !canRetainRasterOverview(this.map, layerMaxZoom(sel.build.manifest, sel.layer), this.windActive, this.windResident)) this.paint.clearOverview();
    if (!this.limitSlots(sel)) { this.cancelRefinement(); this.prefetch.cancel(); this.replacementFailed = true; this.incomplete = false; }
    else if (this.active && matches(this.active, this.requested) && !this.pool.problem(this.active)) this.replacementFailed = false;
    this.armExpiry(); this.emit();
  }
  private predicted(slot: Selection | null = this.active): Selection[] { return predictSelections(slot, this.preferred, this.direction); }
  private prepareNext(): void {
    if (this.disposed || this.paint.pendingPaint || this.paint.pendingOverview || this.moving || this.map.isMoving?.() || !this.active || !matches(this.active, this.requested) || this.active.build.expiresAtMs <= Date.now()) return;
    if (this.overview?.supported && this.overview.state.ready + this.overview.state.failed < this.overview.state.total) return;
    const candidates = this.predicted(), limit = Math.min(this.slotLimit(this.active), ...candidates.map(v => this.slotLimit(v)));
    if (!limit) { this.enforceBudget(); return; }
    const desired = candidates.slice(0, limit - 1);
    for (const s of [...this.slots]) if (s !== this.active && !desired.some(v => matches(s, v))) this.pool.drop(s);
    for (const next of desired) {
      if (this.warmFailed.some(v => matches(v, next))) continue;
      const slot = this.slots.find(s => matches(s, next));
      if (slot) {
        if (!slot.successful || !this.pool.settled(slot)) return;
        if (this.pool.problem(slot)) { this.abandon(slot); return; }
        continue;
      }
      this.prefetch.cancel(next);
      try { this.addSlot(next, false); this.armExpiry(); }
      catch { const failed = this.slots.find(s => matches(s, next)); if (failed) this.abandon(failed); else this.warmFailed.push(next); }
      return;
    }
    this.prefetch.run();
  }
}
