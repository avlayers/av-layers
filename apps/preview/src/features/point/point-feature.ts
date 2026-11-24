import {
  pointSeriesSelection,
  type GeoPoint, type PinnedBuild, type PointHorizon, type PointSeriesContext, type PointSeriesController, type UnitSystem
} from '@av/client';
import type { PointViewMode } from '@av/windgram';
import { displayedWindSpeed, windSpeedUnitLabel } from '@av/contracts/units';
import type { PointSession } from './point-session';

export interface PointWind {
  readonly build: PinnedBuild;
  readonly frame: string;
  readonly overview?: boolean;
  sample(lat: number, lon: number): { u: number | null; v: number | null; status: string };
}

export interface PointFeatureOptions {
  readonly root: () => HTMLElement | null;
  readonly series: PointSeriesController;
  readonly isOpen?: () => boolean;
  readonly getBuild: () => PinnedBuild | null;
  readonly getSelectedFrame: () => string | null;
  readonly getUnits: () => UnitSystem;
  readonly getHorizon: () => PointHorizon;
  readonly getViewMode?: () => PointViewMode;
  readonly getMapOffset: () => number;
  readonly getDisplayedFrame: () => string | null;
  readonly getWind: () => PointWind | null;
  readonly ensureLive: () => boolean;
  readonly pauseTimeline: () => void;
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
  };
}

export interface PointFeature {
  open(point: GeoPoint): Promise<void>;
  close(): void;
  syncSelection(): void;
  syncViewMode?(): void;
  followMapFrame(frameId: string | null): void;
  syncWind(): void;
  setHorizon(horizon: PointHorizon): Promise<void>;
  suspend(): void;
  dispose(): void;
  readonly pending: boolean;
  readonly current: PointSeriesContext | null;
  readonly frameId: string | null;
  refreshDiagnostics(): void;
  dismiss(target: EventTarget | null, mapContainer: Element): void;
}

/** Point presentation, lazy Windgram lifetime and dependent map-wind readout. */
export function createPointFeature(options: PointFeatureOptions): PointFeature {
  let session: PointSession | null = null, creating: Promise<void> | null = null;
  let disposed = false, openIntent: object | null = null;
  const body = (): HTMLElement | null => options.root()?.querySelector('#point-body') ?? null;
  const meta = (): HTMLElement | null => options.root()?.querySelector('#meta') ?? null;
  const status = (text = ''): void => options.publish.status(text);

  async function ensure(): Promise<void> {
    if (session || disposed) return;
    creating ??= (async () => {
      const { createPointSession } = await import('../lazy');
      if (disposed) return;
      session = createPointSession({
        series: options.series,
        body,
        getBuild: options.getBuild,
        getSelectedFrame: options.getSelectedFrame,
        getUnits: options.getUnits,
        getHorizon: options.getHorizon,
        getViewMode: options.getViewMode,
        getMapOffset: options.getMapOffset,
        getDisplayedFrame: options.getDisplayedFrame,
        ensureLive: options.ensureLive,
        pauseTimeline: options.pauseTimeline,
        selectFrameById: options.selectFrameById,
        onViewModeChange: options.onViewModeChange,
        onRequestFullHorizon: options.onRequestFullHorizon,
        onVisibleDaysChange: options.onVisibleDaysChange,
        publish: {
          open: point => { meta()?.replaceChildren(); options.publish.open(point); },
          close: () => { options.publish.close(); },
          status,
          busy: options.publish.busy,
          horizon: options.publish.horizon,
          wind: options.publish.wind,
          elevation: options.publish.elevation,
          changed: () => syncWind()
        }
      });
    })();
    const pending = creating;
    try { await pending; } catch { /* A later open can retry the lazy import. */ }
    finally { if (creating === pending) creating = null; }
  }

  function syncWind(): void {
    if (disposed) return;
    const wind = options.getWind(), activeSession = session, context = activeSession?.current;
    if (!wind || !activeSession || !context || context.build !== wind.build || activeSession.frameId !== wind.frame) { options.publish.wind(''); return; }
    const validTime = wind.build.manifest.frames.find(frame => frame.id === wind.frame)?.validTime;
    if (!validTime) { options.publish.wind(''); return; }
    const sample = wind.sample(context.point.lat, context.point.lon), units = options.getUnits();
    const speed = sample.status === 'valid' && sample.u !== null && sample.v !== null ? displayedWindSpeed(Math.hypot(sample.u, sample.v), units) : null;
    const value = speed !== null ? `${speed} ${windSpeedUnitLabel(units)}`
      : sample.status === 'outside' ? 'Outside forecast area' : sample.status === 'no-lift' ? 'No usable lift' : 'Wind unavailable';
    const label = wind.overview ? 'Map wind overview' : 'Map wind';
    options.publish.wind(`${label} · ${activeSession.formatWindTime(Date.parse(validTime))} · ${value}`);
  }

  return {
    async open(point) {
      if (disposed) return;
      const intent = {}; openIntent = intent;
      try {
        await ensure();
        if (disposed || openIntent !== intent) return;
        await session?.open(point);
        if (disposed || openIntent !== intent) return;
        const horizon = options.getBuild() ? pointSeriesSelection(options.getBuild()!).frames.length !== options.getBuild()!.manifest.frames.length : false;
        options.publish.horizon(horizon, 'Map forecast');
      } finally { if (openIntent === intent) openIntent = null; }
    },
    close() {
      if (disposed) return;
      openIntent = null;
      if (session) session.close();
      else { options.onVisibleDaysChange?.(null); options.publish.close(); }
      meta()?.replaceChildren();
      for (const id of ['#point-settings', '#point-build-details']) { const node = options.root()?.querySelector<HTMLDetailsElement>(id); if (node) node.open = false; }
    },
    syncSelection() { session?.updateSelection(); syncWind(); },
    syncViewMode() { session?.syncViewMode?.(); },
    followMapFrame(frameId) { session?.followMapFrame(frameId); session?.updateSelection(); syncWind(); },
    syncWind,
    async setHorizon(horizon) { await session?.loadRange(); void horizon; },
    suspend() { openIntent = null; session?.suspend(); },
    dispose() {
      if (disposed) return;
      disposed = true; openIntent = null;
      const previous = session; session = null;
      previous?.dispose();
    },
    get pending() { return !disposed && Boolean(openIntent || session?.pending); },
    get current() { return session?.current ?? null; },
    get frameId() { return session?.frameId ?? null; },
    refreshDiagnostics() {
      const container = meta(), build = options.getBuild();
      if (container && build && session?.current && !container.children.length) session.renderBuildDetails(container, build);
    },
    dismiss(target, mapContainer) {
      if ((!options.isOpen?.() && !session?.current && !this.pending) || !(target instanceof Node) || mapContainer.contains(target)) return;
      const controls = ['#point-card', '#map-dock', '#model-picker', '#theme-bar', '#weather-dock', '#legend', '#locate', '#ref-agl', '#ref-msl', '#layer-picker', '#time', '#wind-controls', '#compact-timeline', '#display-units'];
      if (controls.some(selector => options.root()?.querySelector(selector)?.contains(target))) return;
      this.close();
    }
  };
}
