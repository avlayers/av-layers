import type { LayerId } from '@av/contracts/layers';
import { syncCoverageSeam, type PinnedBuild, type SeamMap } from '@av/client';
import type { Map } from 'maplibre-gl';

/** Dashed cell-center edge for the forecast currently on the map. */
export class CoverageSeam {
  private ready = false;
  constructor(private readonly map: Map) {}
  markReady(): void { this.ready = true; }
  sync(build: PinnedBuild | null, layer: LayerId | null): void {
    if (!this.ready) return;
    syncCoverageSeam(this.map as unknown as SeamMap, build, layer, Boolean(this.map.getStyle?.()?.glyphs));
  }
  destroy(): void { this.sync(null, null); }
}
