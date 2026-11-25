import type { Map } from 'maplibre-gl';
import type { RasterOverview } from './raster-overview';
import { matches, type RasterSelection, type Slot } from './raster-slots';

interface StagingHost {
  readonly map: Map;
  overview(): RasterOverview | null;
  active(): Slot | null;
  slots(): readonly Slot[];
  requested(): RasterSelection | null;
  moving(): boolean;
  /** Raster opacity after visibility. */
  opacity(): number;
  beforeReveal(selection: RasterSelection): void;
  drop(slot: Slot): void;
}

/**
 * The paint handoff between the overview image and detail slots. A detail slot waits in `pendingPaint`
 * and an overview frame in `pendingOverview` until a render shows it painted; `coarse` is the overview
 * frame on screen, `revealed` the pending one already made visible. `beforeReveal` runs before each visible change.
 */
export class RasterStaging {
  pendingPaint: Slot | null = null;
  coarse: RasterSelection | null = null;
  pendingOverview: RasterSelection | null = null;
  revealed: RasterSelection | null = null;

  constructor(private readonly host: StagingHost) {}

  private get overview(): RasterOverview | null { return this.host.overview(); }
  private get active(): Slot | null { return this.host.active(); }

  /** Render step for a pending overview frame: `stale` after cancelling it, `committed` once painted. */
  renderOverview(painted: boolean): 'stale' | 'waiting' | 'committed' {
    const next = this.pendingOverview!;
    if (!matches(next, this.host.requested()) || !this.overview?.ready(next.build, next.layer, next.frame)) {
      this.cancel(); return 'stale';
    }
    if (!matches(this.revealed, next)) {
      if (this.overview?.canPaint?.() !== false) this.reveal(next);
      return 'waiting';
    }
    if (!painted) return 'waiting';
    if (this.active && !matches(this.active, next)) this.host.map.setPaintProperty(this.active.id, 'raster-opacity', 0);
    this.coarse = next; this.pendingOverview = null; return 'committed';
  }

  /** Abandons pending paints and restores whatever was visible before. */
  cancel(): void {
    if (!this.pendingPaint && !this.pendingOverview) return;
    const h = this.host, eff = h.opacity();
    if (this.pendingPaint) h.map.setPaintProperty(this.pendingPaint.id, 'raster-opacity', 0);
    if (this.coarse && this.revealed) h.beforeReveal(this.coarse);
    if (this.pendingOverview && this.coarse && this.overview?.cancelStage?.(eff)) {
      this.pendingPaint = this.pendingOverview = this.revealed = null;
      return;
    }
    this.pendingPaint = this.pendingOverview = this.revealed = null;
    if (this.coarse) h.beforeReveal(this.coarse);
    if (this.coarse && this.overview?.show(this.coarse.build, this.coarse.layer, this.coarse.frame, eff)) return;
    this.coarse = null; this.overview?.hide();
    if (this.active) { h.beforeReveal(this.active); h.map.setPaintProperty(this.active.id, 'raster-opacity', eff); }
  }

  reveal(next: RasterSelection): void {
    if (matches(this.revealed, next)) return;
    const h = this.host, previous = this.coarse ?? this.active, changed = !matches(previous, next);
    if (previous && changed) h.beforeReveal(next);
    if (!this.overview?.show(next.build, next.layer, next.frame, h.opacity())) {
      this.pendingOverview = null;
      if (previous && changed) h.beforeReveal(previous);
      return;
    }
    if (!previous) h.beforeReveal(next);
    this.revealed = next;
    for (const s of h.slots()) h.map.setPaintProperty(s.id, 'raster-opacity', 0);
  }

  /** Stages the requested frame's overview; false when the overview cannot show it. */
  stageOverview(): boolean {
    const next = this.host.requested();
    if (!next || this.host.moving() || this.host.map.isMoving?.() || !this.overview?.ready(next.build, next.layer, next.frame)) return false;
    if (matches(this.coarse, next) && !this.overview.needsUpdate?.(next.build, next.layer, next.frame)) return true;
    if (matches(this.pendingOverview, next)) {
      if (this.overview.canPaint?.() !== false) this.reveal(next);
      return true;
    }
    if (!this.overview.show(next.build, next.layer, next.frame, 0)) return false;
    this.pendingOverview = next;
    this.revealed = null;
    if (this.overview.canPaint?.() !== false) this.reveal(next);
    return true;
  }

  clearOverview(): void {
    if (this.coarse && this.active && !matches(this.coarse, this.active)) this.host.drop(this.active);
    this.pendingOverview = this.coarse = this.revealed = null; this.overview?.clear();
    if (this.active && !this.pendingPaint) this.host.map.setPaintProperty(this.active.id, 'raster-opacity', this.host.opacity());
  }
}
