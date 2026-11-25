import type { Map } from 'maplibre-gl';
import { clampOpacity, previewRasterLayer, seamInsertBefore, type PreparationBudget, type PreparationLease } from '@av/client';

type Coordinates = [[number, number], [number, number], [number, number], [number, number]];
export interface OverviewImage { bitmap: ImageBitmap; lease: PreparationLease | null }
interface Retired { image: OverviewImage; frame: string | null; coordinates: Coordinates | null; sourceId: string; displayLease: PreparationLease | null; previewLease: PreparationLease | null }
interface ImageSourceLike {
  image?: ImageBitmap;
  _imageDirty?: boolean;
  texture?: unknown;
  tileID?: { equals?: (other: unknown) => boolean };
  tiles?: Record<string, { state?: string; tileID?: { canonical?: unknown } }>;
  updateImage?: (options: { image: ImageBitmap; coordinates: Coordinates }) => void;
  setCoordinates?: (coordinates: Coordinates) => void;
}
interface Publication {
  /** Whether the image became unusable while its display lease was reserved. */
  failed(): boolean;
  limited(): void;
  /** Whether the selection that asked for the image still holds after the map calls. */
  current(): boolean;
  /** Runs after a failed publication has been rolled back. */
  rejected(): void;
}

/** Whether MapLibre has uploaded `bitmap` for `source`. */
function uploaded(source: ImageSourceLike, bitmap: ImageBitmap | undefined): boolean {
  if ('image' in source && source.image !== bitmap) return false;
  if ('_imageDirty' in source && source._imageDirty !== false) return false;
  if ('texture' in source && !source.texture) return false;
  if ('tiles' in source && source.tiles) {
    return Object.values(source.tiles).some(tile => tile?.state === 'loaded'
      && (!source.tileID?.equals || !tile.tileID?.canonical || source.tileID.equals(tile.tileID.canonical)));
  }
  return true;
}

function shareLease(lease: PreparationLease, count: number): PreparationLease[] {
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

/**
 * Double-buffered MapLibre `image` sources (`id` and `id-stage`) for overview bitmaps. A new bitmap goes
 * to the hidden source; the previous one is retired with its leases until the new one paints.
 */
export class OverviewDisplay {
  shown: OverviewImage | null = null;
  visibleId: string | null = null;
  heldLease: PreparationLease | null = null;
  publishing = false;
  readonly opacities = new globalThis.Map<string, number>();
  private shownId: string;
  private shownFrame: string | null = null;
  private shownCoordinates: Coordinates | null = null;
  private displayLease: PreparationLease | null = null;
  private readonly retired: Retired[] = [];

  constructor(private readonly map: Map, private readonly id: string, private readonly budget: PreparationBudget | undefined, private readonly isPreview: (image: OverviewImage) => boolean) {
    this.shownId = id;
  }

  canPaint(): boolean {
    const source = this.map.getSource(this.shownId) as ImageSourceLike | undefined;
    return !source || uploaded(source, this.shown?.bitmap);
  }

  show(image: OverviewImage, frame: string, coordinates: Coordinates, opacity: number, publication: Publication): boolean {
    let displayLease: PreparationLease | null = null;
    if (this.shown !== image) {
      displayLease = this.budget?.reserve('raster-display', image.bitmap.width * image.bitmap.height * 8, 'foreground') ?? null;
      if (this.shown !== image && this.budget && !displayLease) { publication.limited(); return false; }
    }
    if (publication.failed()) { displayLease?.release(); return false; }
    const targetId = this.shown !== image && this.visibleId === this.shownId ? (this.shownId === this.id ? `${this.id}-stage` : this.id) : this.shownId;
    const shown = this.shown, visibleId = this.visibleId;
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
      if (this.shown !== shown || !publication.current()) throw new Error('Raster selection changed during publication');
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
      publication.rejected();
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

  /** Drops the staged source and shows the one it replaced; false when nothing was replaced. */
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

  /** Whether the shown bitmap has painted; once it is visible, retired sources and images are released. */
  painted(): boolean {
    if (!this.shown) {
      this.releaseRetired();
      return false;
    }
    const source = this.map.getSource(this.shownId) as ImageSourceLike | undefined;
    if (!source || !uploaded(source, this.shown.bitmap)) return false;
    if (this.visibleId === this.shownId) this.releaseRetired();
    return true;
  }

  /** Preview images the display still holds and that should outlive a reset. */
  surviving(previews: ReadonlySet<OverviewImage>, keepShown: boolean): OverviewImage[] {
    const surviving: OverviewImage[] = [];
    if (keepShown && this.shown && previews.has(this.shown)) surviving.push(this.shown);
    for (const entry of this.retired) if (previews.has(entry.image) && !surviving.includes(entry.image)) surviving.push(entry.image);
    return surviving;
  }

  holds(image: OverviewImage, keepShown: boolean): boolean {
    return (keepShown && image === this.shown) || this.retired.some(entry => entry.image === image);
  }

  /**
   * Moves `surviving` images onto shares of the reset context's `group` lease, then tears the display down
   * unless `keepShown` keeps the shown image. Returns the first map failure.
   */
  reset(previews: ReadonlySet<OverviewImage>, surviving: readonly OverviewImage[], keepShown: boolean, group: PreparationLease | null): unknown {
    const ownedShown = !!this.shown && previews.has(this.shown);
    const previousHeld = this.heldLease;
    let retained: PreparationLease | null = null;
    const uncovered = surviving.filter(image => !image.lease);
    if (group) {
      const bytes = uncovered.reduce((sum, image) => sum + image.bitmap.width * image.bitmap.height * 4, 0);
      if (bytes > 0 && group.resize(bytes)) {
        const shares = shareLease(group, uncovered.length);
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
    return failure;
  }

  private removeSource(id: string): void {
    let failure: unknown;
    try { if (this.map.getLayer(id)) this.map.removeLayer(id); } catch (error) { failure = error; }
    this.opacities.delete(id);
    try { if (this.map.getSource(id)) this.map.removeSource(id); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }

  private releaseRetired(): void {
    const closed = new Set<OverviewImage>();
    let failure: unknown;
    for (const retired of this.retired.splice(0)) {
      if (retired.sourceId !== this.visibleId && retired.sourceId !== this.shownId) {
        try { this.removeSource(retired.sourceId); } catch (error) { failure ??= error; }
      }
      if (!closed.has(retired.image) && retired.image !== this.shown && !this.isPreview(retired.image)) {
        retired.image.bitmap.close(); retired.image.lease?.release();
        closed.add(retired.image);
      }
      retired.displayLease?.release(); retired.previewLease?.release();
    }
    if (failure) throw failure;
  }
}
