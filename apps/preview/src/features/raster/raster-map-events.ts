import type { ErrorEvent, Map, MapSourceDataEvent } from 'maplibre-gl';
import { tileKey } from './detail-readiness';
import type { Slot } from './raster-slots';

/** Overlay reactions to MapLibre events, with source events already resolved to their slot and tile key. */
interface RasterMapHandlers {
  ownsOverviewSource(sourceId: string | undefined): boolean;
  overviewData(): void;
  slot(sourceId: string | undefined): Slot | undefined;
  tileLoaded(slot: Slot, tile: object, key: string | null): void;
  /** A sourcedata `idle` event reporting the source loaded; runs after `tileLoaded` for the same event. */
  sourceIdle(slot: Slot): void;
  tileLoading(slot: Slot, tile: object, key: string | null): void;
  tileAborted(slot: Slot, tile: object, key: string | null): void;
  tileFailed(slot: Slot, tile: object, key: string | null): void;
  sourceFailed(slot: Slot): void;
  render(): void;
  moveStart(): void;
  move(): void;
  moveEnd(): void;
  idle(): void;
  resize(): void;
}

/** Subscribes `handlers` to `map`; returns one unsubscribe action per event. */
export function bindRasterMapEvents(map: Map, h: RasterMapHandlers): (() => void)[] {
  const events: Array<[string, (...args: never[]) => unknown]> = [
    ['sourcedata', (e: MapSourceDataEvent) => {
      if (h.ownsOverviewSource(e.sourceId)) { h.overviewData(); return; }
      const slot = h.slot(e.sourceId);
      if (!slot) return;
      if (e.tile) h.tileLoaded(slot, e.tile, tileKey(e.tile));
      if (e.sourceDataType === 'idle' && e.isSourceLoaded) h.sourceIdle(slot);
    }],
    ['sourcedataloading', (e: MapSourceDataEvent) => {
      const slot = h.slot(e.sourceId);
      if (slot && e.tile) h.tileLoading(slot, e.tile, tileKey(e.tile));
    }],
    ['sourcedataabort', (e: MapSourceDataEvent) => {
      const slot = h.slot(e.sourceId);
      if (slot && e.tile) h.tileAborted(slot, e.tile, tileKey(e.tile));
    }],
    ['error', (e: ErrorEvent & { sourceId?: string; tile?: object }) => {
      const slot = h.slot(e.sourceId);
      if (!slot) return;
      if (e.tile) h.tileFailed(slot, e.tile, tileKey(e.tile)); else h.sourceFailed(slot);
    }],
    ['render', () => h.render()], ['movestart', () => h.moveStart()], ['move', () => h.move()],
    ['moveend', () => h.moveEnd()], ['idle', () => h.idle()], ['resize', () => h.resize()]
  ];
  for (const [ev, fn] of events) map.on(ev as never, fn as never);
  return events.map(([ev, fn]) => () => { map.off(ev as never, fn as never); });
}
