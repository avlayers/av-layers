import type { Map as MapLibreMap } from 'maplibre-gl';
import type { PinnedBuild, PreparationBudget } from '@av/client';
import type { WindDataCache } from '@av/client/wind';
import { renderedFrames } from '@av/contracts/publication';
import { windHorizonProtectedBytes } from '../features/raster/raster-budget';
import type { RasterOverlay } from '../features/raster/raster-overlay';
import type { WindControls } from '../features/wind/wind-controls';
import type { WindHeight, WindStyle } from '../features/wind/wind-model';
import { WindOverlay } from '../features/wind/wind-overlay';
import { createWindSession, type WindSession } from '../features/wind/wind-session';
import type { PreviewStore } from '../stores/app-store';
import type { PointWind } from '../features/point/point-feature';
import type { createStartup } from './startup';

type Preferences = ReturnType<typeof createStartup>['preferences'];
type Scheduler = Parameters<typeof createWindSession>[0]['scheduler'];
interface WindState { style: WindStyle; visible: boolean; paused: boolean; height: WindHeight }

interface WindWiringOptions {
  readonly root: HTMLElement;
  readonly map: MapLibreMap;
  readonly store: PreviewStore;
  readonly preferences: Preferences;
  readonly apiBaseUrl: string;
  readonly lowMemory: boolean;
  readonly scheduler: Scheduler;
  readonly cache: WindDataCache;
  readonly budget: PreparationBudget;
  readonly raster: () => RasterOverlay | null;
  readonly displayedRaster: () => { build: PinnedBuild; frame: string } | null;
  readonly selectedPending: (pending: boolean) => void;
  readonly syncChannels: () => void;
  readonly preparationChanged: () => void;
  readonly pointWindChanged: () => void;
  readonly writeUrl: () => void;
  readonly destroyed: () => boolean;
  readonly aborted: () => boolean;
}

/**
 * Wind: the GPU overlay, the data session that prepares fields for the selected frame and
 * height, the lazily loaded wind controls, and the memory the raster overlay must leave for wind.
 */
export interface WindWiring {
  readonly overlay: WindOverlay;
  readonly session: WindSession;
  /** Frames whose wind field is ready at the selected height, or null when wind is off. */
  readyFrames(): Set<string> | null;
  readonly limited: () => boolean;
  /** Bytes the raster overlay keeps free for the wind horizon. */
  protectedBytes(): number;
  /** Mounts the controls and installs wind once the build carries map wind data. */
  syncSupport(): void;
  syncReservation(): void;
  syncHostVisibility(): void;
  /** Applies a wind control change; `commit` also saves it and writes the URL. */
  set(state: WindState, commit?: boolean): void;
  /** Applies wind state restored from history. */
  restore(state: Pick<WindState, 'style' | 'visible' | 'height'>, override: boolean | null): void;
  setUnits(units: 'metric' | 'imperial'): void;
  /** The installed wind field when it matches the displayed raster frame. */
  pointWind(): PointWind | null;
  destroyControls(): void;
}

export function createWindWiring(options: WindWiringOptions): WindWiring {
  const { root, store: { writer, view }, cache, preferences } = options;
  const intent = () => view.intent.value;
  const build = () => view.forecast.value.build;
  let controls: WindControls | null = null;
  let lastControlVisible = intent().windVisible;
  let horizonPrepared = false;

  const overlay = new WindOverlay(options.map, { budget: options.budget });
  const readyAtHeight = (): Set<string> => new Set([...session.ready].filter(([, heights]) => heights.has(intent().windHeight)).map(([frame]) => frame));
  const wanted = () => Boolean(build()?.manifest.mapData) && intent().windVisible;
  const allReady = (): boolean => {
    const current = build();
    if (!current?.manifest.mapData || !intent().windVisible) return true;
    const ready = readyAtHeight();
    return renderedFrames(current.manifest).every(frame => ready.has(frame.id));
  };
  const protectedBytes = (): number => {
    const current = build();
    if (!current?.manifest.mapData || !intent().windVisible || view.forecast.value.expired) return 0;
    const frames = renderedFrames(current.manifest), ready = readyAtHeight();
    return windHorizonProtectedBytes({
      totalFrames: frames.length,
      readyFrames: frames.filter(frame => ready.has(frame.id)).length,
      numericAllocatedBytes: cache.allocatedBytes,
      horizonNumericRemainingBytes: session.staged ? session.horizonNumericRemaining : null
    });
  };
  const syncHostVisibility = (): void => {
    const host = root.querySelector<HTMLElement>('#wind-controls');
    if (host) host.hidden = !build()?.manifest.mapData || !intent().windVisible || intent().peeking;
  };
  const syncReservation = (): void => {
    const raster = options.raster();
    if (!raster) return;
    const active = wanted();
    raster.setWindActive(active, active || Boolean(session.resident) || cache.allocatedBytes > 0);
    const prepared = allReady(), changed = prepared !== horizonPrepared;
    horizonPrepared = prepared;
    options.preparationChanged();
    if (changed) queueMicrotask(() => { if (!options.destroyed()) options.raster()?.refresh(); });
  };

  const session = createWindSession({
    apiBaseUrl: options.apiBaseUrl, map: options.map, lowMemory: options.lowMemory, scheduler: options.scheduler, cache, budget: options.budget,
    selectedPending: options.selectedPending,
    relieveDisplay: () => Boolean(options.raster()?.relievePressure(Math.max(1, protectedBytes()))) || overlay.relievePressure(),
    overlay: { setWindActive: (active, resident) => options.raster()?.setWindActive(active, resident) },
    field: {
      install: (field, prepared, mode, frame) => overlay.install(field, prepared, mode, frame),
      setField: (field, mode, frame) => overlay.setField(field, mode, frame),
      setPrepared: (prepared, frame) => overlay.setPrepared(prepared, frame),
      clear: () => overlay.clear()
    },
    publish: {
      status: status => { writer.wind({ status }); controls?.setStatus(status); },
      quality: overview => { writer.wind({ overview }); controls?.setQuality?.(overview); },
      displayed: displayed => writer.wind({ displayed }),
      reservation: syncReservation,
      pointWind: options.pointWindChanged
    },
    state: () => {
      const forecast = view.forecast.value;
      return {
        build: forecast.build, selectedFrame: forecast.selectedFrame, height: intent().windHeight, visible: intent().windVisible,
        mapReady: forecast.mapReady, expired: forecast.expired, mapFailed: forecast.mapFailed, aborted: options.aborted()
      };
    },
    displayedRaster: options.displayedRaster,
    replacementFailed: () => view.overlay.value.replacementFailed
  });

  const set = (state: WindState, commit = true): void => {
    const previousHeight = intent().windHeight;
    const fixedWindHeight = typeof state.height === 'number' ? state.height : intent().fixedWindHeight;
    if (state.visible !== lastControlVisible) { lastControlVisible = state.visible; writer.intent({ windVisibleOverride: state.visible }); }
    writer.intent({
      windStyle: state.style, windVisible: state.visible, windPaused: state.paused, windHeight: state.height, fixedWindHeight,
      ...(commit && state.visible ? { peeking: false } : {})
    });
    if (commit) { controls?.setState?.(state); preferences.setWind(state, fixedWindHeight); }
    options.syncChannels();
    syncHostVisibility();
    syncReservation();
    session.heightChanged(previousHeight);
    session.update();
    options.pointWindChanged();
    if (commit) options.writeUrl();
  };

  const mount = (factory: typeof import('../features/lazy')['createWindControls']): void => {
    const host = root.querySelector<HTMLElement>('#wind-controls');
    if (!host || options.destroyed()) return;
    controls?.destroy();
    const cur = intent();
    controls = factory(host, {
      showTrigger: false,
      initial: { style: cur.windStyle, visible: cur.windVisible, paused: cur.windPaused, height: cur.windHeight },
      onChange: state => set(state, false),
      onCommit: options.writeUrl
    });
    lastControlVisible = controls.state.visible;
    controls.setUnits(cur.units);
    controls.setStatus(view.wind.value.status);
    controls.setQuality?.(view.wind.value.overview);
    syncHostVisibility();
    syncReservation();
  };
  const mounted = (): boolean => {
    const host = root.querySelector<HTMLElement>('#wind-controls');
    return Boolean(controls && host && (!('childElementCount' in host) || host.childElementCount > 0));
  };
  const startControls = async (): Promise<void> => {
    if (mounted() || options.destroyed()) return;
    const { createWindControls } = await import('../features/lazy');
    if (!mounted() && !options.destroyed()) mount(createWindControls);
  };
  if (import.meta.hot) {
    import.meta.hot.accept('../features/lazy', mod => {
      if (mod && 'createWindControls' in mod && build()?.manifest.mapData) mount((mod as unknown as typeof import('../features/lazy')).createWindControls);
    });
  }

  return {
    overlay, session, protectedBytes, syncReservation, syncHostVisibility, set,
    readyFrames: () => wanted() ? readyAtHeight() : null,
    limited: () => wanted() && session.preparation.limited,
    syncSupport() {
      const supported = Boolean(build()?.manifest.mapData);
      syncHostVisibility();
      writer.wind({ supported });
      if (supported) void startControls();
      else session.clear();
      syncReservation();
    },
    restore(state, override) {
      const previousHeight = intent().windHeight;
      lastControlVisible = state.visible;
      writer.intent({ windVisibleOverride: override, windVisible: state.visible, windStyle: state.style, windHeight: state.height });
      controls?.setState?.(state);
      options.syncChannels();
      syncHostVisibility();
      syncReservation();
      session.heightChanged(previousHeight);
    },
    setUnits(units) { controls?.setUnits(units); },
    pointWind() {
      const installed = session.installed, displayed = options.displayedRaster();
      return installed && installed.build === build() && displayed?.build === installed.build && displayed.frame === installed.frame
        ? { build: installed.build, frame: installed.frame, overview: installed.isOverview, sample: (lat, lon) => installed.source.sample(lat, lon, installed.height) }
        : null;
    },
    destroyControls() { controls?.destroy(); controls = null; }
  };
}
