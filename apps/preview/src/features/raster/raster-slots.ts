import type { Map } from 'maplibre-gl';
import { layerMaxZoom, previewRasterLayer, previewRasterSource, seamInsertBefore, type PinnedBuild, type PreparationBudget, type PreparationLease, type RasterTileSourceProtocol, type RasterTileSourceTransport } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import type { MapTheme } from '../../themes/registry';
import { MAP_TEXTURE_POOL_RESERVE_BYTES, rasterSourceBytes, rasterSourceLimit } from './raster-budget';
import { canRemapTiles } from './tile-remap';

export interface RasterSelection { build: PinnedBuild; layer: LayerId; frame: string }
/** One prepared frame: a MapLibre raster source and layer, its tile transport and its budget lease. */
export interface Slot extends RasterSelection { id: string; transport: RasterTileSourceTransport; lease: PreparationLease | null; successful: boolean; pending: Set<object>; failed: Set<object>; sourceFailed: boolean; staleTheme?: boolean }
export class RasterBudgetError extends Error {}

export const matches = (a: RasterSelection | null, b: RasterSelection | null): boolean => !!a && !!b && a.build === b.build && a.layer === b.layer && a.frame === b.frame;

/** Runs every action, then rethrows the first failure. */
export function releaseAll(actions: readonly (() => void)[]): void {
  let failed = false, failure: unknown;
  for (const action of actions) {
    try { action(); } catch (error) { if (!failed) { failed = true; failure = error; } }
  }
  if (failed) throw failure;
}

interface SlotPoolHooks {
  /** Runs first among a dropped slot's release actions. */
  releasePaint(slot: Slot): void;
  stationary(): boolean;
  requested(): RasterSelection | null;
  cameraRevision(): number;
  /** A background slot missed `STAGING_TIMEOUT_MS` and was dropped; `requested` says whether it was the request. */
  timedOut(requested: boolean): void;
}

const STAGING_TIMEOUT_MS = 15_000;

/**
 * Owns prepared slots, the displayed (`active`) slot, the shared renderer-pool lease, the per-viewport
 * source limits and the timeout on the newest background slot. Drop order is fixed: paint, layer,
 * source, transport, lease, pool lease.
 */
export class SlotPool {
  slots: Slot[] = [];
  active: Slot | null = null;
  private rendererPool: PreparationLease | null = null;
  private generation = 0;
  private readonly limits = new globalThis.Map<number, number>();
  private watchSelection: RasterSelection | null = null;
  private watchRevision = -1;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly map: Map, private readonly budget: PreparationBudget | undefined, private readonly hooks: SlotPoolHooks) {}

  find(sel: RasterSelection | null): Slot | undefined { return this.slots.find(s => matches(s, sel)); }
  problem(slot: Slot | null): boolean { return !!slot && (slot.sourceFailed || slot.failed.size > 0); }
  settled(slot: Slot): boolean {
    return this.hooks.stationary() && !this.map.isMoving?.() && !slot.pending.size && slot.build.expiresAtMs > Date.now() && this.map.isSourceLoaded(slot.id);
  }
  ready(slot: Slot): boolean { return slot.successful && !this.problem(slot) && this.settled(slot); }

  add(protocol: RasterTileSourceProtocol, sel: RasterSelection, interactive: boolean, theme: MapTheme): void {
    protocol.setBuildExpiry(sel.build.manifest.buildId, sel.build.expiresAtMs);
    const bytes = rasterSourceBytes(this.map, layerMaxZoom(sel.build.manifest, sel.layer));
    const budget = this.budget, priority = interactive ? 'foreground' : 'background';
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
    try { transport = protocol.createSource(interactive); } catch (error) {
      lease?.release();
      if (!this.slots.length) { this.rendererPool?.release(); this.rendererPool = null; }
      throw error;
    }
    const id = `av-overlay-${++this.generation}`;
    this.slots.push({ ...sel, id, transport, lease, successful: false, pending: new Set(), failed: new Set(), sourceFailed: false });
    if (!interactive) this.watch(sel);
    const source = previewRasterSource(sel.build.templates[sel.layer], sel.frame, layerMaxZoom(sel.build.manifest, sel.layer), sel.build.manifest.descriptors.attribution);
    const suffix = canRemapTiles() ? `#${theme}` : '';
    source.tiles = source.tiles.map(url => `${transport.url(url)}${suffix}`);
    this.map.addSource(id, source);
    const layer = previewRasterLayer(0);
    this.map.addLayer({ ...layer, id, source: id, paint: { ...layer.paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } }, seamInsertBefore(this.map));
  }

  drop(slot: Slot): void {
    if (this.watchSelection && matches(slot, this.watchSelection) && slot !== this.active) this.unwatch();
    this.slots = this.slots.filter(v => v !== slot);
    if (this.active === slot) this.active = null;
    releaseAll([
      () => this.hooks.releasePaint(slot),
      () => { if (this.map.getLayer(slot.id)) this.map.removeLayer(slot.id); },
      () => { if (this.map.getSource(slot.id)) this.map.removeSource(slot.id); },
      () => slot.transport.dispose(), () => { slot.lease?.release(); slot.lease = null; },
      () => { if (!this.slots.length) { this.rendererPool?.release(); this.rendererPool = null; } }
    ]);
  }

  /** Camera revision at which `slot` was staged in the background, while its timeout is armed. */
  stagedRevision(slot: Slot): number | undefined {
    return this.watchSelection && matches(slot, this.watchSelection) ? this.watchRevision : undefined;
  }

  unwatch(): void {
    if (this.watchTimer !== null) { clearTimeout(this.watchTimer); this.watchTimer = null; }
    this.watchSelection = null; this.watchRevision = -1;
  }

  private watch(sel: RasterSelection): void {
    this.unwatch();
    this.watchSelection = sel; this.watchRevision = this.hooks.cameraRevision();
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      const slot = this.slots.find(candidate => candidate !== this.active && matches(candidate, sel));
      if (!slot) return;
      if (slot.successful && this.map.isSourceLoaded(slot.id)) { this.unwatch(); return; }
      const requested = matches(slot, this.hooks.requested());
      this.drop(slot);
      this.hooks.timedOut(requested);
    }, STAGING_TIMEOUT_MS);
  }

  /** Empties the pool without releasing anything; the caller drops the returned slots, then releases the pool lease. */
  detach(): { slots: Slot[]; rendererPool: PreparationLease | null } {
    const detached = { slots: this.slots, rendererPool: this.rendererPool };
    this.slots = []; this.rendererPool = null; this.active = null;
    return detached;
  }

  /** Cached source count the current viewport admits for `sel`. */
  limit(sel: RasterSelection, overview: boolean, windActive: boolean, windResident: boolean): number {
    const zoom = layerMaxZoom(sel.build.manifest, sel.layer), key = zoom * 8 + Number(overview) * 4 + Number(windActive) * 2 + Number(windResident);
    let limit = this.limits.get(key);
    if (limit === undefined) { limit = rasterSourceLimit(this.map, zoom, overview, windActive, windResident); this.limits.set(key, limit); }
    return limit;
  }
  clearLimits(): void { this.limits.clear(); }

  dropAll(): void {
    while (this.slots.length > 0) this.drop(this.slots.findLast(s => s !== this.active) ?? this.active!);
  }

  /** Drops standby slots, then the requested one, then the active one, until at most `allowed` remain. */
  trim(allowed: number): void {
    while (this.slots.length > allowed) {
      this.drop(this.slots.findLast(s => s !== this.active && !matches(s, this.hooks.requested())) ?? this.slots.findLast(s => s !== this.active) ?? this.active!);
    }
  }

  /** Resizes standby leases to the viewport; `onLimited` runs before each slot that no longer fits is dropped. */
  fitStandby(onLimited: () => void): void {
    for (const slot of [...this.slots].filter(s => s !== this.active)) {
      const bytes = rasterSourceBytes(this.map, layerMaxZoom(slot.build.manifest, slot.layer));
      if (slot.lease && !slot.lease.resize(bytes)) {
        onLimited();
        this.drop(slot);
      }
    }
  }

  /** Resizes `active`'s lease, shedding standby slots and `relieve`d bytes first; false when it cannot fit. */
  fitActive(active: Slot, relieve: (bytes: number) => void): boolean {
    const budget = this.budget!, activeLease = active.lease!;
    const bytes = rasterSourceBytes(this.map, layerMaxZoom(active.build.manifest, active.layer));
    let resized = activeLease.resize(bytes);
    if (!resized) {
      for (const slot of [...this.slots]) if (slot !== active) this.drop(slot);
      relieve(Math.max(0, bytes - activeLease.bytes));
      resized = activeLease.resize(bytes);
      if (!resized && bytes <= activeLease.bytes + (budget.limit - budget.used)) {
        const oldBytes = activeLease.bytes;
        activeLease.release();
        active.lease = budget.reserve('raster-renderer', bytes, 'foreground') ?? budget.reserve('raster-renderer', oldBytes, 'foreground');
        resized = active.lease?.bytes === bytes;
      }
    }
    return resized;
  }

  /** Drops slots outside `keep` until `requiredBytes` fit in background priority. */
  relieve(budget: PreparationBudget, requiredBytes: number, keep: (slot: Slot) => boolean): void {
    for (const slot of [...this.slots]) {
      if (budget.canReserve(requiredBytes, 'background')) break;
      if (!keep(slot)) this.drop(slot);
    }
  }
}
