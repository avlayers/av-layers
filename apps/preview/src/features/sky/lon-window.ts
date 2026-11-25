import { MAX_LAT } from './mercator';

/**
 * Longitude windows for sky fields: `west` in [-180, 180), `east = west + span`, so a window can run
 * past 180° (`170..190`) and stays one coherent span. Samples normalize each point; MapLibre draws
 * the same coordinates on every world copy.
 */
export interface LonLatWindow {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

const WORLD_SPAN = 340;
const MIN_SPAN = 0.04;

/** Coherent window for unwrapped MapLibre bounds; a span of 340° or more becomes the whole world. */
export function lonWindow(west: number, south: number, east: number, north: number): LonLatWindow {
  let span = east - west;
  if (span <= 0) span += 360;
  const s = Math.max(-MAX_LAT, south), n = Math.min(MAX_LAT, north);
  if (span >= WORLD_SPAN) return { west: -180, south: s, east: 180, north: n };
  const w = ((west + 180) % 360 + 360) % 360 - 180;
  return { west: w, south: s, east: w + Math.max(MIN_SPAN, span), north: n };
}

/** `view` shifted by whole turns so its centre lies within 180° of `ref`'s centre. */
export function alignedTo<T extends LonLatWindow>(view: T, ref: LonLatWindow): T {
  const turns = Math.round(((ref.west + ref.east) - (view.west + view.east)) / 720);
  return turns === 0 ? view : { ...view, west: view.west + turns * 360, east: view.east + turns * 360 };
}
