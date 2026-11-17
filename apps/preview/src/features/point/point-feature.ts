import {
  formatPlaceTime, longitudeOffsetHours, pointSeriesSelection,
  type GeoPoint, type PinnedBuild, type PointHorizon, type PointSeriesContext, type PointSeriesController, type UnitSystem
} from '@av/client';
import { displayedWindSpeed, windSpeedUnitLabel } from '@av/contracts/units';
import { renderBuildDetails } from './build-details';
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
  readonly getBuild: () => PinnedBuild | null;
  readonly getSelectedFrame: () => string | null;
  readonly getUnits: () => UnitSystem;
  readonly getHorizon: () => PointHorizon;
  readonly getMapOffset: () => number;
  readonly getDisplayedFrame: () => string | null;
  readonly getWind: () => PointWind | null;
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
  };
}

export interface PointFeature {
  open(point: GeoPoint): Promise<void>;
  close(): void;
  syncSelection(): void;
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
  const body = (): HTMLElement | null => options.root()?.querySelector('#point-body') ?? null;
  const meta = (): HTMLElement | null => options.root()?.querySelector('#meta') ?? null;
  const status = (text = ''): void => options.publish.status(text);

  async function ensure(): Promise<void> {
    if (session) return;
    creating ??= (async () => {
      const { createPointSession } = await import('../lazy');
      session = createPointSession({
        series: options.series,
        body,
        getBuild: options.getBuild,
        getSelectedFrame: options.getSelectedFrame,
        getUnits: options.getUnits,
        getHorizon: options.getHorizon,
        getMapOffset: options.getMapOffset,
        getDisplayedFrame: options.getDisplayedFrame,
        ensureLive: options.ensureLive,
        pauseTimeline: options.pauseTimeline,
        selectFrameById: options.selectFrameById,
        publish: {
          open: point => { meta()?.replaceChildren(); options.publish.open(point); },
          close: () => { options.publish.close(); },
          status,
          busy: options.publish.busy,
          horizon: options.publish.horizon,
          wind: options.publish.wind,
          changed: () => syncWind()
        }
      });
    })();
    try { await creating; } catch { creating = null; }
  }

  function syncWind(): void {
    const wind = options.getWind(), context = session?.current;
    if (!wind || !context || context.build !== wind.build || session?.frameId !== wind.frame) { options.publish.wind(''); return; }
    const validTime = wind.build.manifest.frames.find(frame => frame.id === wind.frame)?.validTime;
    if (!validTime) { options.publish.wind(''); return; }
    const sample = wind.sample(context.point.lat, context.point.lon), units = options.getUnits();
    const speed = sample.status === 'valid' && sample.u !== null && sample.v !== null ? displayedWindSpeed(Math.hypot(sample.u, sample.v), units) : null;
    const value = speed !== null ? `${speed} ${windSpeedUnitLabel(units)}`
      : sample.status === 'outside' ? 'Outside forecast area' : sample.status === 'no-lift' ? 'No usable lift' : 'Wind unavailable';
    const label = wind.overview ? 'Map wind overview' : 'Map wind';
    options.publish.wind(`${label} · ${formatPlaceTime(Date.parse(validTime), longitudeOffsetHours(context.point.lon) * 60, 'stamp')} · ${value}`);
  }

  return {
    async open(point) {
      await ensure();
      await session?.open(point);
      const horizon = options.getBuild() ? pointSeriesSelection(options.getBuild()!).frames.length !== options.getBuild()!.manifest.frames.length : false;
      options.publish.horizon(horizon, options.getBuild()?.manifest.mapFrameCount !== undefined ? 'Map forecast' : '24 hours');
    },
    close() {
      session?.close();
      meta()?.replaceChildren();
      for (const id of ['#point-settings', '#point-build-details']) { const node = options.root()?.querySelector<HTMLDetailsElement>(id); if (node) node.open = false; }
    },
    syncSelection() { session?.updateSelection(); syncWind(); },
    followMapFrame(frameId) { session?.followMapFrame(frameId); session?.updateSelection(); syncWind(); },
    syncWind,
    async setHorizon(horizon) { await session?.loadRange(); void horizon; },
    suspend() { session?.suspend(); },
    dispose() { session?.dispose(); },
    get pending() { return Boolean(session?.pending); },
    get current() { return session?.current ?? null; },
    get frameId() { return session?.frameId ?? null; },
    refreshDiagnostics() {
      const container = meta(), build = options.getBuild();
      if (container && build && session?.current && !container.children.length) renderBuildDetails(container, build, session.current.point.lon);
    },
    dismiss(target, mapContainer) {
      if (!session?.current || !(target instanceof Node) || mapContainer.contains(target)) return;
      const controls = ['#point-card', '#ref-agl', '#ref-msl', '#layer-picker', '#time', '#wind-controls', '#compact-timeline', '#display-units'];
      if (controls.some(selector => options.root()?.querySelector(selector)?.contains(target))) return;
      this.close();
    }
  };
}
