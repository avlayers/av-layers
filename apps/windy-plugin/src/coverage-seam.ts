import type { LayerId } from '@av/contracts/layers';
import { syncCoverageSeam, type PinnedBuild } from '@av/client';

/** Draw the seam when this map can host a GeoJSON source. Windy's glyphs are left unused. */
export function syncPluginSeam(maplibre: object, build: PinnedBuild | null, layer: LayerId | null): void {
  const host = maplibre as { addSource?: unknown };
  if (typeof host.addSource !== 'function') return;
  try { syncCoverageSeam(host as Parameters<typeof syncCoverageSeam>[0], build, layer, false); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'Style is not done loading.') throw error; }
}

export function watchPluginSeam(maplibre: object, sync: () => void): void {
  const host = maplibre as { addSource?: unknown; on?: (event: string, listener: () => void) => void };
  if (typeof host.addSource !== 'function' || typeof host.on !== 'function') return;
  host.on('moveend', sync);
  host.on('style.load', sync);
}
