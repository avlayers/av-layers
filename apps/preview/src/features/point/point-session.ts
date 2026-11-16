import {
  pointSeriesSelection, type GeoPoint, type PointSeriesController, type PinnedBuild, type PointHorizon, type PointSeries, type PointSeriesContext, type UnitSystem
} from '@av/client';
import type { ApiClient } from '@av/client';
import { renderBuildDetails } from './build-details';

type PointWindgram = typeof import('@av/windgram');

export interface PointSessionOptions {
  readonly api: ApiClient;
  readonly series: PointSeriesController;
  readonly body: () => HTMLElement | null;
  readonly getBuild: () => PinnedBuild | null;
  readonly getSelectedFrame: () => string | null;
  readonly getUnits: () => UnitSystem;
  readonly getHorizon: () => PointHorizon;
  readonly getMapOffset: () => number;
  readonly getDisplayedFrame: () => string | null;
  readonly ensureLive: () => boolean;
  readonly pauseTimeline: () => void;
  readonly selectFrameById: (id: string) => void;
  readonly publish: {
    open(point: GeoPoint): void;
    close(): void;
    status(text: string): void;
    busy(busy: boolean): void;
    horizon(selectable: boolean, label: string): void;
    wind(text: string): void;
    changed(): void;
  };
}

export interface PointSession {
  open(point: GeoPoint): Promise<void>;
  close(): void;
  loadRange(): Promise<void>;
  updateSelection(): void;
  followMapFrame(frameId: string | null): void;
  renderBuildDetails(container: HTMLElement, build: PinnedBuild): void;
  readonly current: PointSeriesContext | null;
  readonly pending: boolean;
  readonly frameId: string | null;
  dispose(): void;
}

/** Point-series ownership, progressive loading and the lazy Windgram adapter. */
export function createPointSession(options: PointSessionOptions): PointSession {
  const series = options.series;
  let windgram: PointWindgram | null = null;
  let updatePointSeries: ReturnType<PointWindgram['renderPointWindgram']> | null = null;
  let selection: { update: ReturnType<PointWindgram['renderPointWindgram']>; frame: string | null; units: UnitSystem; mapFrame: string | null; mapOffset: number } | null = null;

  const body = (): HTMLElement | null => options.body();
  const setStatus = (message = ''): void => options.publish.status(message);

  function showPoint(context: PointSeriesContext, payload: PointSeries, totalFrames: number, loading: boolean): void {
    const host = body();
    if (!windgram || !host) return;
    updatePointSeries = windgram.renderPointWindgram(host, payload, context.build, {
      point: context.point, frameId: series.frameId, mapFrameId: options.getDisplayedFrame(), mapOffsetMinutes: options.getMapOffset(), unitSystem: options.getUnits(), totalFrames, loading,
      onFrame(id) {
        if (options.getBuild() !== context.build || !options.ensureLive() || !series.selectFrame(context, id)) return;
        options.pauseTimeline();
        options.selectFrameById(id);
      }
    });
    host.tabIndex = 0;
    options.publish.busy(loading);
    if (!loading) setStatus();
    options.publish.changed();
  }

  function close(): void {
    series.close();
    options.publish.busy(false);
    setStatus('');
    windgram?.disposePointWindgram(body()!);
    body()?.replaceChildren();
    updatePointSeries = selection = null;
    options.publish.wind('');
    options.publish.close();
  }

  async function loadRange(): Promise<void> {
    const context = series.current;
    if (!context || options.getBuild() !== context.build || !options.ensureLive()) return;
    await series.load(options.getHorizon(), options.getSelectedFrame(), {
      canRender: () => options.getBuild() === context.build && options.ensureLive(),
      prepare: windgram ? undefined : async () => { windgram = await import('@av/windgram'); },
      onLoading() { options.publish.busy(true); setStatus('Loading forecast…'); options.publish.changed(); },
      onProgress(payload, totalFrames, loading) { showPoint(context, payload, totalFrames, loading); },
      onError(detail) {
        updatePointSeries?.(series.frameId, options.getUnits(), options.getDisplayedFrame(), false);
        options.publish.busy(false);
        setStatus((body()?.children.length ?? 0) ? detail : `Forecast unavailable. ${detail}`);
      }
    });
  }

  async function open(point: GeoPoint): Promise<void> {
    const build = options.getBuild();
    if (!build || !options.ensureLive()) return;
    series.open(build, point);
    options.publish.open(point);
    setStatus('');
    if (body()) { windgram?.disposePointWindgram(body()!); body()!.replaceChildren(); }
    updatePointSeries = selection = null;
    options.publish.horizon(pointSeriesSelection(build).frames.length !== build.manifest.frames.length,
      build.manifest.mapFrameCount !== undefined ? 'Map forecast' : '24 hours');
    await loadRange();
  }

  function updateSelection(): void {
    if (!updatePointSeries) return;
    const frame = series.frameId, mapFrame = options.getDisplayedFrame();
    if (selection?.update === updatePointSeries && selection.frame === frame && selection.units === options.getUnits() && selection.mapFrame === mapFrame && selection.mapOffset === options.getMapOffset()) return;
    selection = { update: updatePointSeries, frame, units: options.getUnits(), mapFrame, mapOffset: options.getMapOffset() };
    updatePointSeries(frame, options.getUnits(), mapFrame, undefined, options.getMapOffset());
  }

  return {
    open, close, loadRange, updateSelection,
    followMapFrame(frameId) { series.followMapFrame(frameId); updateSelection(); },
    renderBuildDetails(container, build) { renderBuildDetails(container, build, series.current?.point.lon); },
    get current() { return series.current; },
    get pending() { return series.pending; },
    get frameId() { return series.frameId; },
    dispose() {
      series.close();
      if (body()) windgram?.disposePointWindgram(body()!);
      updatePointSeries = selection = null;
    }
  };
}
