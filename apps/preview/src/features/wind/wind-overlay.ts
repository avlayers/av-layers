import type { Map } from 'maplibre-gl';
import type { WindPreparedGrid } from '@av/client/wind';
import type { PreparationBudget } from '@av/client';
import { WindDeck, type WindDeckOptions, type WindField } from './wind-deck';

export type { WindField };
export type WindOverlayOptions = WindDeckOptions;
export interface WindOverlayAllocationOptions { budget?: PreparationBudget }

/** Owns the GPU wind renderer and the retained prepared grid for the current scene. */
export class WindOverlay {
  private field: WindField | null = null;
  private prepared: WindPreparedGrid | null = null;
  private releasePrepared: (() => void) | null = null;
  private frame: string | null = null;
  private options: WindOverlayOptions = { style: 'trails', visible: true, paused: false, units: 'metric' };
  private readonly deck: WindDeck;
  private moveRaf: number | null = null;
  private mapLost = false;
  private destroyed = false;

  private readonly sync = (): void => {
    if (this.moveRaf !== null) {
      cancelAnimationFrame(this.moveRaf);
      this.moveRaf = null;
    }
    if (this.destroyed || this.mapLost) return;
    try { this.deck.setOptions(this.options); } catch { /* the map is replacing its style */ }
  };

  private readonly scheduleSync = (): void => {
    if (this.destroyed || this.mapLost || !this.options.visible || this.moveRaf !== null) return;
    if (typeof requestAnimationFrame !== 'function') { this.sync(); return; }
    this.moveRaf = requestAnimationFrame(() => {
      this.moveRaf = null;
      if (this.destroyed || this.mapLost || !this.options.visible) return;
      try { this.deck.setOptions(this.options); } catch { /* the map is replacing its style */ }
    });
  };

  private readonly contextLost = (): void => { this.mapLost = true; };
  private readonly contextRestored = (): void => {
    this.mapLost = false;
    try { this.deck.setData(this.field, this.prepared, this.frame, this.options); } catch { /* the map is replacing its style */ }
  };
  private readonly visibility = (): void => { this.sync(); };

  constructor(private readonly map: Map, options: WindOverlayAllocationOptions = {}) {
    this.deck = new WindDeck(map, options.budget);
    map.on('move', this.scheduleSync);
    map.on('moveend', this.sync);
    map.on('resize', this.sync);
    map.on('webglcontextlost', this.contextLost);
    map.on('webglcontextrestored', this.contextRestored);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility);
  }

  get renderState(): { generation: number; frame: string | null; installedGeneration: number } {
    return this.deck.renderState;
  }

  get displayMemory(): { canvasBytes: number; glBytes: number; limited: boolean } {
    return this.deck.memory;
  }

  relievePressure(): boolean {
    return !this.destroyed && this.deck.relievePressure();
  }

  install(field: WindField | null, prepared: WindPreparedGrid | null, _mode: 'replace' | 'swap' = 'replace', frame: string | null = null): void {
    if (this.destroyed) return;
    if (this.field === field && this.prepared === prepared && this.frame === frame && field) return;
    const changed = this.prepared !== prepared, previousRelease = this.releasePrepared;
    this.field = field; this.prepared = prepared; this.frame = frame;
    this.releasePrepared = changed ? prepared?.retain?.() ?? null : previousRelease;
    try { this.deck.setData(field, prepared, frame, this.options); }
    finally { if (changed) previousRelease?.(); }
  }

  setPrepared(prepared: WindPreparedGrid | null, frame: string | null = this.frame): void {
    if (this.prepared !== prepared || this.frame !== frame) this.install(this.field, prepared, 'replace', frame);
  }

  setField(field: WindField | null, mode: 'replace' | 'swap' = 'replace', frame: string | null = this.frame): void {
    this.install(field, null, mode, frame);
  }

  setOptions(options: Partial<WindOverlayOptions>): void {
    if (this.destroyed) return;
    this.options = { ...this.options, ...options };
    try { this.deck.setOptions(this.options); } catch { /* the map is replacing its style */ }
  }

  clear(): void { this.install(null, null, 'replace', null); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.moveRaf !== null) {
      cancelAnimationFrame(this.moveRaf);
      this.moveRaf = null;
    }
    this.map.off('move', this.scheduleSync);
    this.map.off('moveend', this.sync);
    this.map.off('resize', this.sync);
    this.map.off('webglcontextlost', this.contextLost);
    this.map.off('webglcontextrestored', this.contextRestored);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibility);
    this.deck.destroy();
    this.releasePrepared?.(); this.releasePrepared = null;
    this.field = null; this.prepared = null; this.frame = null;
  }
}
