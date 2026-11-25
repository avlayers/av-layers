import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ForecastRequestHandle, ForecastRequestSpec, PinnedBuild, RasterTileHandle } from '@av/client';
import type { ResolvedChannelStyles } from '../map/channel-styles';
import type { PrecipField } from './precip-field';
import { RainAnimator } from './rain-animator';
import { RainContourLayer } from './rain-contour-layer';
import { RainCuffLayer } from './rain-cuff-layer';
import { RainFieldSource } from './rain-field-source';
import { pilotHorizonFrameOrder, type ViewportBounds } from './synoptic-sampler';

export interface LiveRainRenderState {
  readonly styles: ResolvedChannelStyles;
  readonly opacity: number;
  readonly visible: boolean;
}

/**
 * Precipitation (`precip-rate`) controller: picks the frame's `PrecipField` from `RainFieldSource`
 * (foreground fetch or horizon warming) and hands it to the cuff layer, the contour layer and the
 * screen-space `RainAnimator`. With `supported = false` it only manages visibility and teardown.
 */
export class RainLayerController {
  private readonly animator: RainAnimator | null;
  private readonly source: RainFieldSource | null;
  private readonly cuff: RainCuffLayer;
  private readonly contours: RainContourLayer;
  private activeField: PrecipField | null = null;
  private activeFgHandles: RasterTileHandle[] = [];
  private activeWarmHandles: RasterTileHandle[] = [];
  private jobToken = 0;
  private warmToken = 0;
  private disposed = false;

  constructor(
    map: MapLibreMap,
    baseUrl: string,
    supported: boolean,
    options: {
      styles: ResolvedChannelStyles;
      opacity: number;
      visible: boolean;
      fetchImpl?: typeof fetch;
      request?: (spec: ForecastRequestSpec) => ForecastRequestHandle;
    }
  ) {
    this.animator = supported
      ? new RainAnimator(map, { darkChrome: options.styles.darkChrome, opacity: options.opacity, visible: options.visible })
      : null;
    this.source = supported
      ? new RainFieldSource(map, baseUrl, { fetchImpl: options.fetchImpl, request: options.request })
      : null;
    this.cuff = new RainCuffLayer(map);
    this.contours = new RainContourLayer(map);
  }

  findCachedField(build: PinnedBuild, frame: string, raw: ViewportBounds): PrecipField | null {
    if (!build.templates['precip-rate'] || !this.source) return null;
    return this.source.find(build, frame, raw, this.activeField);
  }

  /** Synchronously paints a cached `PrecipField` in 0 ms without yielding across an async boundary. */
  tryPaintCached(
    build: PinnedBuild,
    frame: string,
    raw: ViewportBounds,
    state: LiveRainRenderState
  ): boolean {
    if (this.disposed || !this.source) return false;
    if (!build.templates['precip-rate']) {
      this.clear();
      return true;
    }
    if (!state.visible) {
      this.syncStyleAndVisibility(state.styles, state.opacity, false);
      return true;
    }
    const hit = this.findCachedField(build, frame, raw);
    if (!hit) return false;
    this.cancelForegroundHandles();
    this.jobToken++;
    this.activeField = hit;
    this.applyField(hit, state.styles, state.opacity, state.visible);
    return true;
  }

  pauseWarming(): void {
    this.warmToken++;
    for (const handle of this.activeWarmHandles.splice(0)) handle.cancel();
  }

  async refresh(
    build: PinnedBuild,
    frame: string,
    raw: ViewportBounds,
    initial: LiveRainRenderState,
    readLive?: () => LiveRainRenderState | null
  ): Promise<boolean> {
    const source = this.source;
    if (this.disposed || !source) return false;
    if (!initial.visible) {
      this.syncStyleAndVisibility(initial.styles, initial.opacity, false);
      return false;
    }

    if (this.tryPaintCached(build, frame, raw, initial)) return true;

    if (!build.templates['precip-rate']) {
      this.clear();
      return false;
    }

    const crop = source.planCrop(build, raw);
    if (!crop) return false;

    this.pauseWarming();
    this.cancelForegroundHandles();
    const token = ++this.jobToken;
    const handles: RasterTileHandle[] = [];
    this.activeFgHandles = handles;

    const field = await source.decode(build, frame, crop, 'foreground', handles, () => !this.disposed && token === this.jobToken);
    if (this.activeFgHandles === handles) this.activeFgHandles = [];
    if (!field || this.disposed || token !== this.jobToken) return false;

    const live = readLive ? readLive() : initial;
    if (!live) return false;

    this.activeField = field;
    this.applyField(field, live.styles, live.opacity, live.visible);
    return true;
  }

  /**
   * Politely warms `precip-rate` fields across the forecast horizon in pilot scrub order
   * (`+1..+8h` and multi-day same-hour jumps first) at low priority, one frame at a time.
   */
  warmHorizon(build: PinnedBuild, anchorFrame: string, raw: ViewportBounds): void {
    const source = this.source;
    if (this.disposed || !source || !build.templates['precip-rate']) return;
    const crop = source.planCrop(build, raw);
    if (!crop) return;

    this.pauseWarming();
    const token = this.warmToken;
    const ordered = pilotHorizonFrameOrder(build, anchorFrame);

    void (async () => {
      for (const frame of ordered) {
        if (this.disposed || token !== this.warmToken || build.expiresAtMs <= Date.now()) return;
        if (this.findCachedField(build, frame, raw)) continue;
        const handles: RasterTileHandle[] = [];
        this.activeWarmHandles = handles;
        await source.decode(build, frame, crop, 'background', handles, () => !this.disposed && token === this.warmToken);
        if (this.activeWarmHandles === handles) this.activeWarmHandles = [];
      }
    })();
  }

  repaintCurrent(styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    this.animator?.setDarkChrome(styles.darkChrome);
    this.animator?.setOpacity(opacity);
    if (this.activeField && visible) {
      this.cuff.paint(this.activeField, styles, opacity, visible);
      this.contours.paint(this.activeField, styles, visible);
    }
    this.syncStyleAndVisibility(styles, opacity, visible);
  }

  syncStyleAndVisibility(styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    this.animator?.setDarkChrome(styles.darkChrome);
    this.animator?.setOpacity(opacity);
    this.animator?.setVisible(visible);
    this.cuff.syncStyle(opacity, visible);
    this.contours.syncStyle(styles, opacity, visible);
  }

  clear(): void {
    this.jobToken++;
    this.pauseWarming();
    this.cancelForegroundHandles();
    this.activeField = null;
    this.animator?.setField(null);
    this.contours.clear();
    this.cuff.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.animator?.destroy();
    this.source?.dispose();
  }

  private cancelForegroundHandles(): void {
    for (const handle of this.activeFgHandles.splice(0)) handle.cancel();
  }

  private applyField(field: PrecipField, styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    this.animator?.setDarkChrome(styles.darkChrome);
    this.animator?.setField(field);
    this.cuff.paint(field, styles, opacity, visible);
    this.contours.paint(field, styles, visible);
    this.syncStyleAndVisibility(styles, opacity, visible);
  }
}
