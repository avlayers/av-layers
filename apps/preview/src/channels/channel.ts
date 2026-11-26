import type { PreviewIntent } from '../stores/app-store';

/** Display state the map channels draw from: the matching fields of the preview intent. */
export type ChannelView = Pick<PreviewIntent,
  'theme' | 'opacity' | 'units' | 'peeking'
  | 'liftVisible' | 'cloudsVisible' | 'rainVisible' | 'isobarsVisible'
  | 'windVisible' | 'windStyle' | 'windPaused'>;

/**
 * A forecast layer group drawn on the map (lift raster, sky weather, wind).
 * The app keeps one list of channels and forwards every display change,
 * and teardown to each, tearing down in reverse order;
 * data selection stays per channel.
 */
export interface MapChannel {
  /** Applies theme, opacity, visibility and units. Cheap when nothing changed. */
  update(view: ChannelView): void;
  /** Drops drawn data while keeping the channel attached to the map; `release` also frees retained memory. */
  clear(release?: boolean): void;
  destroy(): void;
}
