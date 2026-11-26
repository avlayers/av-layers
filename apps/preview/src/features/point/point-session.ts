import {
  pointSeriesSelection, type GeoPoint, type PointSeriesController, type PinnedBuild, type PointHorizon, type PointSeries, type PointSeriesContext, type UnitSystem
} from '@av/client';
import { formatSitePlaceTime, resolveSiteTimeZone } from '@av/client/timezone';
import type { PointViewMode } from '@av/windgram';
import { renderBuildDetails } from './build-details';

type PointWindgram = typeof import('@av/windgram');

export interface PointSessionOptions {
  readonly series: PointSeriesController;
  readonly body: () => HTMLElement | null;
  readonly getBuild: () => PinnedBuild | null;
  readonly getSelectedFrame: () => string | null;
  readonly getUnits: () => UnitSystem;
  readonly getHorizon: () => PointHorizon;
  readonly getViewMode?: () => PointViewMode;
  readonly getMapOffset: () => number;
  readonly getDisplayedFrame: () => string | null;
  readonly ensureLive: () => boolean;
  readonly selectFrameById: (id: string) => void;
  readonly onViewModeChange?: (mode: PointViewMode) => void;
  readonly onRequestFullHorizon?: () => void;
  readonly onVisibleDaysChange?: (days: readonly string[] | null) => void;
  readonly publish: {
    open(point: GeoPoint): void;
    close(): void;
    status(text: string): void;
    busy(busy: boolean): void;
    horizon(selectable: boolean, label: string): void;
    wind(text: string): void;
    elevation?(elevationM: number | null, reference: 'terrain' | 'model' | null): void;
    changed(): void;
  };
}

export interface PointSession {
  open(point: GeoPoint): Promise<void>;
  close(): void;
  suspend(): void;
  loadRange(): Promise<void>;
  syncViewMode?(): void;
  updateSelection(): void;
  followMapFrame(frameId: string | null): void;
  formatWindTime(validMs: number): string;
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
  let lastRendered: { context: PointSeriesContext; payload: PointSeries; totalFrames: number; loading: boolean } | null = null;
  let selection: { update: ReturnType<PointWindgram['renderPointWindgram']>; frame: string | null; units: UnitSystem; mapFrame: string | null; mapOffset: number } | null = null;
  let activeTimeZone: string | undefined;

  const body = (): HTMLElement | null => options.body();
  const setStatus = (message = ''): void => options.publish.status(message);

  function publishSiteElevation(payload: PointSeries): void {
    if (!options.publish.elevation) return;
    if (payload.siteTerrain?.status === 'outside-domain') {
      options.publish.elevation(null, null);
      return;
    }
    if (payload.siteTerrain?.status === 'valid' && payload.siteTerrain.elevationM !== null && Number.isFinite(payload.siteTerrain.elevationM)) {
      options.publish.elevation(payload.siteTerrain.elevationM, 'terrain');
      return;
    }
    for (const frame of payload.frames) {
      const modelM = frame.profile?.modelTerrainM ?? null;
      if (modelM !== null && Number.isFinite(modelM)) {
        options.publish.elevation(modelM, 'model');
        return;
      }
    }
    options.publish.elevation(null, null);
  }

  function showPoint(context: PointSeriesContext, payload: PointSeries, totalFrames: number, loading: boolean): void {
    const host = body();
    if (!windgram || !host) return;
    lastRendered = { context, payload, totalFrames, loading };
    publishSiteElevation(payload);
    updatePointSeries = windgram.renderPointWindgram(host, payload, context.build, {
      point: context.point,
      frameId: series.frameId,
      mapFrameId: options.getDisplayedFrame(),
      mapOffsetMinutes: options.getMapOffset(),
      unitSystem: options.getUnits(),
      timeZone: activeTimeZone,
      totalFrames,
      loading,
      viewMode: options.getViewMode?.(),
      onViewModeChange: options.onViewModeChange,
      onRequestFullHorizon: options.onRequestFullHorizon,
      onVisibleDaysChange: options.onVisibleDaysChange,
      onFrame(id) {
        if (options.getBuild() !== context.build || !options.ensureLive() || !series.selectFrame(context, id)) return;
        options.selectFrameById(id);
        updateSelection();
        options.publish.changed();
      }
    });
    host.tabIndex = 0;
    options.publish.busy(loading);
    if (!loading) setStatus();
    options.publish.changed();
  }

  function suspend(): void {
    series.close();
    if (body()) windgram?.disposePointWindgram(body()!);
    body()?.replaceChildren();
    options.onVisibleDaysChange?.(null);
    activeTimeZone = undefined;
    updatePointSeries = selection = lastRendered = null;
  }

  function close(): void {
    suspend();
    options.publish.busy(false);
    setStatus('');
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
    activeTimeZone = resolveSiteTimeZone(point.lat, point.lon).timeZone;
    series.open(build, point);
    options.publish.open(point);
    setStatus('');
    if (body()) { windgram?.disposePointWindgram(body()!); body()!.replaceChildren(); }
    updatePointSeries = selection = lastRendered = null;
    options.publish.horizon(pointSeriesSelection(build).frames.length !== build.manifest.frames.length, 'Map forecast');
    await loadRange();
  }

  function syncViewMode(): void {
    if (!lastRendered || !series.current || lastRendered.context !== series.current) return;
    showPoint(lastRendered.context, lastRendered.payload, lastRendered.totalFrames, lastRendered.loading);
  }

  function updateSelection(): void {
    if (!updatePointSeries) return;
    const frame = series.frameId, mapFrame = options.getDisplayedFrame();
    if (selection?.update === updatePointSeries && selection.frame === frame && selection.units === options.getUnits() && selection.mapFrame === mapFrame && selection.mapOffset === options.getMapOffset()) return;
    selection = { update: updatePointSeries, frame, units: options.getUnits(), mapFrame, mapOffset: options.getMapOffset() };
    updatePointSeries(frame, options.getUnits(), mapFrame, undefined, options.getMapOffset());
  }

  return {
    open, close, suspend, loadRange, syncViewMode, updateSelection,
    followMapFrame(frameId) { series.followMapFrame(frameId); updateSelection(); },
    formatWindTime(validMs) { return series.current ? formatSitePlaceTime(validMs, series.current.point, 'stamp', activeTimeZone) : '—'; },
    renderBuildDetails(container, build) { renderBuildDetails(container, build, series.current?.point, activeTimeZone); },
    get current() { return series.current; },
    get pending() { return series.pending; },
    get frameId() { return series.frameId; },
    dispose() {
      series.close();
      if (body()) windgram?.disposePointWindgram(body()!);
      options.onVisibleDaysChange?.(null);
      activeTimeZone = undefined;
      updatePointSeries = selection = lastRendered = null;
    }
  };
}
