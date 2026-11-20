import {
  ApiClient, AUTO_MODEL_ID, createForecastRequestScheduler, createPreparationBudget, formatBuildFreshness, formatPlaceTime,
  isGlobeView, mapForecastHorizonNotice, watchBuildExpiry,
  normalizePoint, PointSeriesController, type PinnedBuild, type PointHorizon, type UnitSystem
} from '@av/client';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import { WindDataCache } from '@av/client/wind';
import { createHistoryController } from '../features/navigation/history-controller';
import { apiBaseUrl, createStartup, offlineFixture, safeStorage } from './startup';
import type { PreviewCommands } from './preview-commands';
import { preparedAxisReadiness, type PreviewStore } from '../stores/app-store';
import { createPreviewStore } from '../stores/app-store';
import { DEFAULT_DOCK_VIEW } from '../features/controls/bottom-dock-model';
import { activeLayer, committedFrame, layerOptions, restoredCustomLayer, validatedCustomLayer, visibleCustomLayer } from '../features/forecast/forecast-model';
import { createForecastSession } from '../features/forecast/forecast-session';
import { applyBasemapTheme } from '../features/map/basemap';
import { THEME_OPTIONS, themeOption } from '../features/map/visual-theme';
import { createMap, createMapCamera, maplibregl, type MapCamera } from '../features/map/map-controller';
import { RasterOverlay, type OverlayState } from '../features/raster/raster-overlay';
import { preparationBudgetBytes, WIND_CACHE_CAPACITY_BYTES, windHorizonProtectedBytes } from '../features/raster/raster-budget';
import { CoverageSeam } from '../features/map/coverage-seam';
import { SkyComposite } from '../features/sky/sky-composite';
import { createWindSession } from '../features/wind/wind-session';
type WindControls = import('../features/wind/wind-controls').WindControls;
import { WindOverlay } from '../features/wind/wind-overlay';
import { createCompactTimeline, type CompactTimeline } from '../features/timeline/timeline-controller';
import { createLocationController } from '../features/location/location-controller';
import { easePointIntoClearView } from '../features/point/point-camera';
import { createPointFeature, type PointFeature } from '../features/point/point-feature';
import { createPointMarker, type PointMarker } from '../features/point/point-marker';
import { installBrowserLifecycle } from '../platform/browser-lifecycle';

export interface PreviewApp {
  readonly store: PreviewStore;
  readonly commands: PreviewCommands;
  start(root: HTMLElement): void;
  dispose(): void;
}

function sameOverlaySelection(
  a: OverlayState['displayed'],
  b: OverlayState['displayed']
): boolean {
  return a === b || (!!a && !!b && a.build === b.build && a.layer === b.layer && a.frame === b.frame);
}

function sameStringList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  const la = a?.length ?? 0, lb = b?.length ?? 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) if (a![i] !== b![i]) return false;
  return true;
}

function overlayUiMeaningfullyChanged(prev: OverlayState, next: OverlayState): boolean {
  return !(
    sameOverlaySelection(prev.displayed, next.displayed)
    && sameOverlaySelection(prev.requested, next.requested)
    && prev.quality === next.quality
    && prev.viewLoading === next.viewLoading
    && prev.overviewReady === next.overviewReady
    && prev.overviewTotal === next.overviewTotal
    && prev.overviewFailed === next.overviewFailed
    && prev.incomplete === next.incomplete
    && prev.replacementFailed === next.replacementFailed
    && Boolean(prev.limited) === Boolean(next.limited)
    && sameStringList(prev.previewReadyFrames, next.previewReadyFrames)
    && sameStringList(prev.detailReadyFrames, next.detailReadyFrames)
    && sameStringList(prev.detailDrawableFrames, next.detailDrawableFrames)
  );
}

/** Builds the preview's state and commands. Map and renderer resources start on `start`. */
export function createPreviewApp(): PreviewApp {
  const startup = createStartup(window.location.search, safeStorage());
  const { initial, preferences, initialOffset, browserOffsetMinutes } = startup;
  const store = createPreviewStore(initial);
  const { writer, view } = store;
  const history = createHistoryController({
    pathname: () => window.location.pathname,
    search: () => window.location.search,
    push: url => window.history.pushState(null, '', url),
    replace: url => window.history.replaceState(null, '', url)
  }, offlineFixture);

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const preparationBudget = createPreparationBudget(preparationBudgetBytes(deviceMemory), { foregroundReserveBytes: 24 * 1024 * 1024 });
  const maxActive = Number(import.meta.env.VITE_FORECAST_REQUESTS ?? 24);
  if (![16, 24, 32].includes(maxActive)) throw new Error('Invalid forecast request profile');
  const requestLimits = { maxActive, maxPrefetchActive: maxActive - 4 };
  const forecastScheduler = createForecastRequestScheduler({
    budget: preparationBudget, maxActive, maxBackgroundActive: requestLimits.maxPrefetchActive,
    maxInFlightBytes: maxActive * 1024 * 1024, maxBackgroundBytes: requestLimits.maxPrefetchActive * 1024 * 1024
  });
  const api = new ApiClient({ baseUrl: apiBaseUrl, fetchImpl: forecastScheduler.fetch, budget: preparationBudget });
  const pointSeries = new PointSeriesController(api);
  const lifecycle = new AbortController();

  preferences.setUnits(store.view.intent.value.units);
  const lowMemory = preparationBudget.limit <= 128 * 1024 * 1024;
  const windCache = new WindDataCache(WIND_CACHE_CAPACITY_BYTES, 4096, preparationBudget);

  let map: maplibregl.Map | null = null;
  let admissionEpoch = 0, rasterPending = false, windPending = false, windAxisPrepared = false;
  const syncSelectedAdmission = () => forecastScheduler.setForegroundPending(++admissionEpoch, rasterPending || windPending);
  let camera: MapCamera | null = null;
  let overlay: RasterOverlay | null = null;
  let sky: SkyComposite | null = null;
  let seam: CoverageSeam | null = null;
  let windOverlay: WindOverlay | null = null;
  let windSession: ReturnType<typeof createWindSession> | null = null;
  let windControls: WindControls | null = null;
  let startWindControls: () => Promise<void> = async () => {};
  let timeline: CompactTimeline | null = null;
  let pointFeature: PointFeature | null = null;
  let pointMarker: PointMarker | null = null;
  let activePointEase: { point: { lat: number; lon: number }; settled: boolean } | null = null;
  let locationController: ReturnType<typeof createLocationController> | null = null;

  let mapOffsetMinutes = initialOffset;
  let lastTimelineLat = Number.NaN, lastTimelineLng = Number.NaN;
  let urlReady = false, opacityCommitted = false, opacityDragging = false, opacityDirty = false, spacePeekActive = false;
  let lastControlVisible = store.view.intent.value.windVisible;
  let expiryTimer: number | null = null, resumeModel: ModelId | null = null;
  let destroyed = false;
  let appRoot: HTMLElement | null = null;

  const intent = () => view.intent.value;
  const forecast = () => view.forecast.value;
  const build = (): PinnedBuild | null => forecast().build;
  const mapReady = () => forecast().mapReady;
  const mapFailed = () => forecast().mapFailed;
  const selectedFrame = () => forecast().selectedFrame;
  const aborted = () => lifecycle.signal.aborted;
  const isPointOpen = () => Boolean(view.point.value.open || pointFeature?.current || pointFeature?.pending);
  const displayedRaster = () => {
    const displayed = view.overlay.value.displayed;
    return displayed ? { build: displayed.build, frame: displayed.frame } : null;
  };
  const displayedPointFrame = () => {
    const displayed = view.overlay.value.displayed;
    return displayed && displayed.build === build() ? displayed.frame : null;
  };

  function syncRootTheme(): void {
    if (appRoot && 'dataset' in appRoot && appRoot.dataset) {
      const cur = intent();
      appRoot.dataset.theme = cur.theme;
      appRoot.dataset.dock = cur.dockView;
      appRoot.dataset.chrome = themeOption(cur.theme).darkChrome ? 'dark' : 'light';
    }
  }

  function syncWindHostVisibility(): void {
    const supported = Boolean(build()?.manifest.mapData);
    const cur = intent();
    const host = rootQuery<HTMLElement>('#wind-controls', appRoot ?? document);
    if (host) host.hidden = !supported || !cur.windVisible || cur.peeking;
  }

  function syncWeatherVisibility(): void {
    const cur = intent();
    const showLift = cur.liftVisible && !cur.peeking;
    if (overlay && typeof overlay.setVisible === 'function') overlay.setVisible(showLift);
    else overlay?.setOpacity(showLift ? cur.opacity : 0);
    sky?.setVisibility({
      cloudsVisible: cur.cloudsVisible,
      rainVisible: cur.rainVisible,
      isobarsVisible: cur.isobarsVisible,
      peeking: cur.peeking
    });
    windOverlay?.setOptions({
      visible: cur.windVisible && !cur.peeking,
      darkChrome: themeOption(cur.theme).darkChrome
    });
    syncWindHostVisibility();
  }

  const forecastSession = createForecastSession({
    api, writer, intent,
    center: () => { const center = map!.getCenter(); return normalizePoint(center.lat, center.lng); },
    globe: () => {
      if (!map) return false;
      const bounds = map.getBounds();
      return isGlobeView({ zoom: map.getZoom(), west: bounds.getWest(), east: bounds.getEast() });
    },
    mapFailed, aborted, now: () => Date.now(),
    hooks: {
      onLoading(model) {
        windSession?.clear(); closePoint();
        writer.notices({ tileError: '', horizon: '', error: '', frameStatus: 'Loading forecast…', freshness: `Loading ${model} latest immutable build…` });
        updateTimeUi();
      },
      onBuild(next) {
        urlReady = true;
        writer.forecast({ layers: layerOptions(next) });
        const customLayer = validatedCustomLayer(next, intent().customLayer);
        if (customLayer !== intent().customLayer) writer.intent({ customLayer });
        syncWindSupport(); updateTimeUi(); updateOverlay(); updateFreshness();
      },
      onSameBuild(frame) {
        timeline?.pause();
        if (pointFeature?.frameId === selectedFrame()) pointFeature?.followMapFrame(frame);
      },
      onCleared(message) {
        urlReady = true;
        syncWindSupport(); syncLayers(); windSession?.clear(); closePoint(); overlay?.clear(); sky?.clear(); seam?.sync(null, null); updateTimeUi();
        showError(message); writer.notices({ freshness: 'No viewable build' });
      },
      onExpired() {
        writer.notices({ tileError: '', horizon: '' });
        windCache.clear(); windSession?.clear(); closePoint(); overlay?.clear(); sky?.clear(); seam?.sync(null, null); updateTimeUi();
        writer.notices({ freshness: 'Expired immutable build' });
        showError('This build has expired. Reload to discover the latest retained build.');
      },
      onUrl(mode) { writeUrl(mode); },
      watchExpiry(next, expire) { return watchBuildExpiry(next.expiresAtMs, expire, [document, window]); },
      startTimer() { if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000); },
      stopTimer() { if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; } }
    }
  });

  const showError = (message: string): void => { writer.notices({ error: message }); };
  const clearError = (): void => { writer.notices({ error: '' }); };

  function windHorizonPrepared(): boolean {
    const current = build();
    if (!current?.manifest.mapData || !intent().windVisible) return true;
    const ready = windSession?.ready;
    return Boolean(ready && renderedFrames(current.manifest).every(frame => ready.get(frame.id)?.has(intent().windHeight)));
  }

  function protectedWindBytes(): number {
    const current = build();
    if (!current?.manifest.mapData || !intent().windVisible || forecast().expired) return 0;
    const frames = renderedFrames(current.manifest), ready = windSession?.ready;
    return windHorizonProtectedBytes({
      totalFrames: frames.length,
      readyFrames: frames.filter(frame => ready?.get(frame.id)?.has(intent().windHeight)).length,
      numericAllocatedBytes: windCache.allocatedBytes,
      horizonNumericRemainingBytes: windSession?.staged ? windSession.horizonNumericRemaining : null
    });
  }

  function syncWindReservation(): void {
    if (!overlay) return;
    const active = Boolean(build()?.manifest.mapData) && intent().windVisible;
    overlay.setWindActive(active, active || Boolean(windSession?.resident) || windCache.allocatedBytes > 0);
    const prepared = windHorizonPrepared();
    const changed = prepared !== windAxisPrepared;
    windAxisPrepared = prepared;
    updatePreparation();
    if (changed) queueMicrotask(() => { if (!destroyed) overlay?.refresh(); });
  }

  function updatePreparation(): void {
    const current = build(), raster = view.overlay.value;
    const frames = current && !forecast().expired ? renderedFrames(current.manifest) : [];
    const layer = activeLayer(current, intent().reference, intent().customLayer);
    const compatible = raster.requested?.build === current && raster.requested?.layer === layer;
    const previews = new Set(compatible ? raster.previewReadyFrames ?? [] : []);
    const details = new Set(compatible ? raster.detailDrawableFrames ?? raster.detailReadyFrames ?? [] : []);
    const needsWind = Boolean(current?.manifest.mapData) && intent().windVisible;
    const windReady = needsWind ? new Set([...(windSession?.ready ?? [])].filter(([, heights]) => heights.has(intent().windHeight)).map(([frame]) => frame)) : null;
    const readiness = preparedAxisReadiness(frames, previews, details, windReady);
    writer.notices({ ...readiness,
      preparationLimited: Boolean(raster.limited || (needsWind && windSession?.preparation.limited)) });
    timeline?.setReadiness?.(readiness.overviewReady, readiness.overviewTotal, raster.viewLoading);
  }

  function syncWindSupport(): void {
    const supported = Boolean(build()?.manifest.mapData);
    syncWindHostVisibility();
    writer.wind({ supported });
    if (supported) void startWindControls();
    else windSession?.clear();
    syncWindReservation();
  }

  function syncLayers(): void {
    const current = build();
    writer.forecast({ layers: layerOptions(current) });
    const customLayer = validatedCustomLayer(current, intent().customLayer);
    if (customLayer !== intent().customLayer) writer.intent({ customLayer });
  }

  function updateScale(): void {
    if (!camera) return;
    const scale = camera.scale(intent().units);
    writer.notices({ scaleWidth: scale.width, scaleText: scale.text });
  }

  function updateOverlayStatus(): void {
    const state = view.overlay.value;
    const { displayed, requested, quality, viewLoading, overviewFailed, incomplete, replacementFailed } = state;
    const pendingModel = forecast().pendingModel;
    const showing = displayed ? `Showing ${displayed.build.manifest.model} ${displayed.frame} ${displayed.layer}.` : 'No forecast displayed.';
    const pending = requested && (!displayed || displayed.build !== requested.build || displayed.layer !== requested.layer || displayed.frame !== requested.frame);
    const olderBuild = displayed && displayed.build !== build();
    const displayedTime = displayed?.build.manifest.frames.find(frame => frame.id === displayed.frame)?.validTime;
    const displayedLabel = displayedTime ? formatPlaceTime(Date.parse(displayedTime), mapOffsetMinutes, 'stamp') : '';
    const playing = forecast().playing;
    const status = !displayed ? requested ? replacementFailed ? 'Forecast unavailable · No forecast shown' : 'Loading selected time · No forecast shown' : forecast().expired ? 'Forecast expired' : pendingModel ? 'Loading forecast…' : 'No forecast shown'
      : pending ? `Showing ${displayedLabel} · ${replacementFailed ? 'Selected time unavailable' : 'Loading selected time…'}`
        : quality === 'overview' ? `${displayedLabel} · Overview${playing ? '' : (replacementFailed ? ' · Detail unavailable' : ' · Loading detail…')}`
          : viewLoading ? `${displayedLabel} · Loading this view…` : `${displayedLabel} · ${incomplete ? 'Detail incomplete' : 'Full detail'}`;
    const tileError = replacementFailed ? `Forecast replacement failed. ${showing}` : incomplete ? `Overlay tile failed to load — forecast display may be incomplete. ${showing}` : pendingModel ? `Loading ${pendingModel}. ${showing}` : olderBuild ? showing : '';
    writer.notices({ frameStatus: status, overviewFailed, tileError });
    updatePreparation();
    if (!selectingOverlay) updatePointSelection();
  }

  let selectingOverlay = false;

  function paintMapHorizon(now = Date.now()): void {
    const current = build();
    if (!current || forecast().expired) return;
    const notice = mapForecastHorizonNotice(current.manifest, now, ms => formatPlaceTime(ms, mapOffsetMinutes, 'stamp'));
    writer.notices({ horizon: notice ?? '' });
  }

  function updateFreshness(): void {
    overlay?.refresh();
    const current = build();
    if (!current || forecast().expired) return;
    const now = Date.now();
    if (current.expiresAtMs <= now) { forecastSession.expire(); return; }
    paintMapHorizon(now);
    writer.notices({ freshness: (intent().model === AUTO_MODEL_ID ? `${current.manifest.model} · ` : '') + formatBuildFreshness(current.manifest, current.expiresAtMs, now) });
  }

  function updateTimeUi(): void {
    const frames = build() ? renderedFrames(build()!.manifest) : [];
    timeline?.update(frames, selectedFrame(), !build() || forecast().expired || forecast().mapFailed);
  }

  function updateOverlay(): void {
    const layer = activeLayer(build(), intent().reference, intent().customLayer);
    if (!mapReady() || !build() || !selectedFrame() || !layer || !forecastSession.ensureLive()) return;
    updateWind();
    clearError(); selectingOverlay = true;
    try {
      overlay!.select(build()!, layer, selectedFrame()!);
      sky?.select(build()!, selectedFrame()!);
      syncWeatherVisibility();
      refreshSeam();
    } catch (error) { showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { selectingOverlay = false; updatePointSelection(); }
  }

  function refreshSeam(): void { seam?.sync(build(), activeLayer(build(), intent().reference, intent().customLayer)); }

  function updatePointSelection(): void { pointFeature?.syncSelection(); }

  function updateWind(): void {
    windSession?.update();
    pointFeature?.syncWind();
  }

  function writeUrl(mode: 'push' | 'replace'): void {
    if (!map || !mapReady() || !urlReady || forecast().pendingModel) return;
    const camera = map.getCenter(), current = build(), cur = intent();
    const validTime = cur.model === AUTO_MODEL_ID ? cur.requestedTime ?? undefined : current?.manifest.frames.find(frame => frame.id === selectedFrame())?.validTime;
    history.write({
      model: cur.model, reference: cur.reference, layer: cur.customLayer, opacity: cur.opacity,
      lat: camera.lat, lon: camera.lng, zoom: map.getZoom(), validTime,
      theme: cur.theme, dockView: cur.dockView, cloudStyle: cur.cloudStyle, rainStyle: cur.rainStyle,
      liftVisible: cur.liftVisible, cloudsVisible: cur.cloudsVisible, rainVisible: cur.rainVisible, isobarsVisible: cur.isobarsVisible,
      ...(cur.windVisibleOverride !== null ? { windVisible: cur.windVisible } : {}),
      windStyle: cur.windStyle, windHeight: cur.windHeight, units: cur.units
    }, mode, true);
  }

  function closePoint(): void {
    activePointEase = null;
    timeline?.setHighlightedDays?.(null);
    pointMarker?.clear();
    pointFeature?.close();
  }

  function prepareFrameIndex(index: number): void {
    const current = build();
    if (!current || !mapReady() || forecast().expired) return;
    const frame = renderedFrames(current.manifest)[index];
    if (!frame) return;
    const layer = activeLayer(current, intent().reference, intent().customLayer);
    if (layer && current.templates[layer] && intent().liftVisible) overlay?.prepare(layer, frame.id);
    sky?.prepare(current, frame.id);
  }

  function selectIndex(index: number, history: 'none' | 'push' | 'replace', fromTimeline = false): void {
    const current = build();
    const frame = current ? renderedFrames(current.manifest)[index] : undefined;
    if (!frame) return;
    if (!fromTimeline) timeline?.cancelGesture();
    if (intent().model === AUTO_MODEL_ID && intent().requestedTime !== frame.validTime) forecastSession.cancelAuto();
    forecastSession.commitFrame(frame.id, frame.validTime);
    updateTimeUi(); pointFeature?.followMapFrame(frame.id); updateOverlay(); updatePointSelection();
    if (history !== 'none') {
      writeUrl(history);
      if (intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto();
    }
  }

  function focusRegion(model: ModelId): void {
    camera?.focusRegion(MODEL_OPTIONS.find(choice => choice.modelId === model)?.bounds);
  }

  async function applyHistory(): Promise<void> {
    if (aborted()) return;
    timeline?.cancelGesture();
    const state = history.read(window.location.search), change = history.beginRestore();
    try {
      const requestedLayer = visibleCustomLayer(state.layer);
      const nextTheme = state.theme ?? preferences.theme() ?? 'stone';
      const nextDockView = state.dockView ?? preferences.dockView() ?? DEFAULT_DOCK_VIEW;
      const nextCloudStyle = state.cloudStyle ?? preferences.cloudStyle() ?? 'auto';
      const nextRainStyle = state.rainStyle ?? preferences.rainStyle() ?? 'auto';
      writer.intent({
        reference: state.reference,
        customLayer: restoredCustomLayer(build(), requestedLayer, Boolean(state.model && state.model !== intent().model)),
        theme: nextTheme,
        dockView: nextDockView,
        cloudStyle: nextCloudStyle,
        rainStyle: nextRainStyle,
        liftVisible: state.liftVisible ?? true,
        cloudsVisible: state.cloudsVisible ?? true,
        rainVisible: state.rainVisible ?? true,
        isobarsVisible: state.isobarsVisible ?? false,
        peeking: false
      });
      syncRootTheme();
      timeline?.setVariant?.(nextDockView);
      applyBasemapTheme(map, nextTheme);
      overlay?.setTheme?.(nextTheme);
      sky?.setTheme(nextTheme);
      sky?.setChannelStyles({ cloudStyle: nextCloudStyle, rainStyle: nextRainStyle });
      syncWeatherVisibility();

      const nextUnits: UnitSystem = state.units ?? 'metric';
      if (nextUnits !== intent().units) commandSetUnits(nextUnits);
      const nextVisible = state.windVisible ?? (preferences.wind()?.visible ?? true);
      const nextStyle = state.windStyle ?? 'trails', nextHeight = state.windHeight ?? 'surface';
      const previousHeight = intent().windHeight;
      lastControlVisible = nextVisible;
      writer.intent({ windVisibleOverride: state.windVisible, windVisible: nextVisible, windStyle: nextStyle, windHeight: nextHeight });
      windControls?.setState?.({ visible: nextVisible, style: nextStyle, height: nextHeight });
      windOverlay?.setOptions({
        style: nextStyle,
        visible: nextVisible && !intent().peeking,
        paused: intent().windPaused,
        units: intent().units,
        darkChrome: themeOption(nextTheme).darkChrome
      });
      syncWindHostVisibility();
      syncWindReservation();
      windSession?.heightChanged(previousHeight);
      if (state.opacity !== null) { writer.intent({ opacity: state.opacity }); overlay?.setOpacity(state.opacity); sky?.setOpacity(state.opacity); syncWeatherVisibility(); }
      if (state.camera) map?.jumpTo(state.camera, { previewHistory: true });
      writer.intent({ requestedTime: state.validTime });
      if (state.model && state.model !== intent().model) { await forecastSession.load(state.model as ModelId); return; }
      if (intent().model === AUTO_MODEL_ID) { await forecastSession.loadAuto(); return; }
      if (build()) {
        const previous = selectedFrame();
        const committed = committedFrame(build()!, state.validTime, Date.now());
        if (committed.id !== previous) { timeline?.pause(); pointFeature?.followMapFrame(committed.id); }
        if (committed.id && committed.validTime) forecastSession.commitFrame(committed.id, committed.validTime);
        updateTimeUi(); updateOverlay();
      }
    } finally { history.endRestore(change); }
  }

  function syncMapClock(settled = false): void {
    if (!map || !camera) return;
    const next = camera.sync();
    if (!Number.isFinite(next.center.lat) || !Number.isFinite(next.center.lng)) return;

    // Avoid mutating forecast store signal (which re-renders <App />) or rebuilding timeline solar DOM at 60 fps mid-pan.
    if (settled || next.changed || forecast().mapCenter === null) {
      writer.forecast({ mapCenter: next.center });
    }
    if (
      settled
      || next.changed
      || !Number.isFinite(lastTimelineLat)
      || Math.abs(next.center.lat - lastTimelineLat) >= 0.20
      || Math.abs(next.center.lng - lastTimelineLng) >= 0.20
    ) {
      lastTimelineLat = next.center.lat;
      lastTimelineLng = next.center.lng;
      timeline?.setMapCenter(next.center.lat, next.center.lng);
    }

    if (!next.changed) return;
    mapOffsetMinutes = camera.offsetMinutes();
    writer.forecast({ offsetMinutes: mapOffsetMinutes });
    timeline?.setOffsetMinutes(mapOffsetMinutes);
    updateTimeUi(); updateOverlayStatus(); paintMapHorizon(); updatePointSelection();
  }

  function prepareLayer(layer: 'lift' | import('@av/contracts/layers').LayerId): void {
    const current = build(), frame = selectedFrame();
    if (!current || !frame) return;
    const target = layer === 'lift' ? (intent().reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl') : layer;
    if (current.templates[target]) overlay?.prepare(target, frame);
  }

  function prepareWeatherChannel(channel: 'lift' | 'wind' | 'clouds' | 'rain' | 'isobars'): void {
    if (channel === 'lift') {
      prepareLayer('lift');
      return;
    }
    if (channel === 'wind') return;
    const current = build(), frame = selectedFrame();
    if (!current || !frame) return;
    sky?.prepare(current, frame, channel);
  }

  function commandSetUnits(units: UnitSystem): void {
    writer.intent({ units });
    preferences.setUnits(units);
    windControls?.setUnits(units);
    windOverlay?.setOptions({ units });
    updateScale(); updatePointSelection();
    writeUrl('replace');
  }

  function commandSetWind(state: { style: import('../features/wind/wind-model').WindStyle; visible: boolean; paused: boolean; height: import('../features/wind/wind-model').WindHeight }, commit = true): void {
    const previousHeight = intent().windHeight;
    const nextFixedHeight = typeof state.height === 'number' ? state.height : intent().fixedWindHeight;
    if (state.visible !== lastControlVisible) { lastControlVisible = state.visible; writer.intent({ windVisibleOverride: state.visible }); }
    writer.intent({
      windStyle: state.style,
      windVisible: state.visible,
      windPaused: state.paused,
      windHeight: state.height,
      fixedWindHeight: nextFixedHeight,
      ...(commit && state.visible ? { peeking: false } : {})
    });
    if (commit) {
      windControls?.setState?.(state);
      preferences.setWind(state, nextFixedHeight);
    }
    syncWeatherVisibility();
    syncWindReservation();
    windOverlay?.setOptions({
      ...state,
      visible: state.visible && !intent().peeking,
      units: intent().units,
      darkChrome: themeOption(intent().theme).darkChrome
    });
    windSession?.heightChanged(previousHeight);
    updateWind(); if (commit) writeUrl('replace');
  }

  const commands: PreviewCommands = {
    selectModel(model) {
      if (forecast().mapFailed) return;
      timeline?.cancelGesture();
      if (intent().model === AUTO_MODEL_ID) history.cancelRestore();
      void forecastSession.load(model);
      focusRegion(model);
    },
    selectReference(reference) {
      timeline?.cancelGesture();
      writer.intent({ reference, customLayer: null, liftVisible: true, peeking: false });
      syncWeatherVisibility();
      updateOverlay(); writeUrl('push');
      if (intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto();
    },
    selectLayer(layer) {
      timeline?.cancelGesture();
      writer.intent({ customLayer: layer === 'lift' ? null : layer, liftVisible: true, peeking: false });
      syncWeatherVisibility();
      updateOverlay(); writeUrl('push');
      if (intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto();
    },
    prepareLayer,
    prepareWeatherChannel,
    setTheme(theme) {
      if (intent().theme === theme) return;
      writer.intent({ theme });
      preferences.setTheme(theme);
      syncRootTheme();
      applyBasemapTheme(map, theme);
      overlay?.setTheme?.(theme);
      sky?.setTheme(theme);
      windOverlay?.setOptions({ darkChrome: themeOption(theme).darkChrome });
      writeUrl('replace');
    },
    setDockView(dockView) {
      if (intent().dockView === dockView) return;
      writer.intent({ dockView });
      preferences.setDockView(dockView);
      syncRootTheme();
      timeline?.setVariant?.(dockView);
      writeUrl('replace');
    },
    setCloudStyle(cloudStyle) {
      if (intent().cloudStyle === cloudStyle) return;
      writer.intent({ cloudStyle, cloudsVisible: true, peeking: false });
      preferences.setCloudStyle(cloudStyle);
      sky?.setChannelStyles({ cloudStyle });
      syncWeatherVisibility();
      writeUrl('replace');
    },
    setRainStyle(rainStyle) {
      if (intent().rainStyle === rainStyle) return;
      writer.intent({ rainStyle, rainVisible: true, peeking: false });
      preferences.setRainStyle(rainStyle);
      sky?.setChannelStyles({ rainStyle });
      syncWeatherVisibility();
      writeUrl('replace');
    },
    toggleWeatherLayer(channel) {
      const cur = intent();
      if (channel === 'wind') {
        commandSetWind({
          style: cur.windStyle,
          visible: cur.peeking ? true : !cur.windVisible,
          paused: cur.windPaused,
          height: cur.windHeight
        });
        return;
      }
      const nextPatch = channel === 'lift' ? { liftVisible: !cur.liftVisible }
        : channel === 'clouds' ? { cloudsVisible: !cur.cloudsVisible }
        : channel === 'rain' ? { rainVisible: !cur.rainVisible }
        : { isobarsVisible: !cur.isobarsVisible };
      writer.intent({ ...nextPatch, peeking: false });
      syncWeatherVisibility();
      writeUrl('replace');
    },
    setPeeking(peeking) {
      if (intent().peeking === peeking) return;
      writer.intent({ peeking });
      syncWeatherVisibility();
    },
    setOpacity(value) {
      const opacity = Math.min(1, Math.max(0, value));
      if (intent().opacity === opacity) return;
      writer.intent({ opacity });
      const showLift = intent().liftVisible && !intent().peeking;
      overlay?.setOpacity(opacity);
      if (overlay && typeof overlay.setVisible !== 'function' && !showLift) overlay.setOpacity(0);
      sky?.setOpacity(opacity);
      if (opacityDragging) {
        opacityDirty = true;
        return;
      }
      preferences.setOpacity(opacity);
      writeUrl(opacityCommitted ? 'replace' : 'push');
      opacityCommitted = true;
    },
    beginOpacityGesture() { opacityCommitted = false; opacityDragging = true; opacityDirty = false; },
    resetOpacityGesture() {
      const shouldCommit = opacityDragging && opacityDirty;
      opacityDragging = false;
      opacityDirty = false;
      if (shouldCommit) {
        preferences.setOpacity(intent().opacity);
        writeUrl(opacityCommitted ? 'replace' : 'push');
      }
      opacityCommitted = false;
    },
    setUnits(units) { commandSetUnits(units); },
    setWind: commandSetWind,
    setPointHorizon(horizon) {
      const next = horizon as PointHorizon;
      if (intent().pointHorizon === next) return;
      writer.intent({ pointHorizon: next });
      void pointFeature?.setHorizon(next);
    },
    setPointViewMode(mode) {
      const nextHorizon: PointHorizon = mode === '3d' ? 'forecast' : intent().pointHorizon;
      const horizonChanged = nextHorizon !== intent().pointHorizon;
      writer.intent({ pointViewMode: mode, pointHorizon: nextHorizon });
      preferences.setPointViewMode(mode);
      if (horizonChanged) void pointFeature?.setHorizon(nextHorizon);
      else pointFeature?.syncViewMode?.();
    },
    selectFrame(index, history) { selectIndex(index, history); },
    setPlaying(playing) {
      writer.forecast({ playing });
      overlay?.setPlayback(playing);
      sky?.setPlayback(playing);
      windSession?.setPlaying(playing);
      updateOverlayStatus();
    },
    locate() { locationController?.locate(); },
    closePoint() { closePoint(); },
    refreshPointDiagnostics() { pointFeature?.refreshDiagnostics(); }
  };

  function start(root: HTMLElement): void {
    if (map || destroyed) return;
    appRoot = root;
    syncRootTheme();
    const container = rootQuery<HTMLElement>('#map', root);
    if (!container) throw new Error('Missing element #map');
    map = createMap({ container, offlineFixture, camera: startup.query.camera, theme: intent().theme });
    const openedAt = map.getCenter();
    camera = createMapCamera(map, {
      home: { lat: openedAt.lat, lng: openedAt.lng },
      followsPlace: startup.query.camera !== null,
      initialOffset,
      browserOffset: browserOffsetMinutes
    });

    overlay = new RasterOverlay(map, apiBaseUrl, intent().opacity, state => {
      const prev = view.overlay.value;
      if (!overlayUiMeaningfullyChanged(prev, state)) return;
      writer.overlay(state);
      windSession?.reconcile();
      updateOverlayStatus();
    }, forecastScheduler.fetch, spec => forecastScheduler.request(spec), {
      budget: preparationBudget, requestLimits, theme: intent().theme,
      protectedBytes: protectedWindBytes,
      beforeReveal: selection => windSession?.beforeRasterReveal(selection),
      onSelectedPending: pending => { rasterPending = pending; syncSelectedAdmission(); }
    });
    sky = new SkyComposite(map, api, apiBaseUrl, {
      theme: intent().theme,
      cloudStyle: intent().cloudStyle,
      rainStyle: intent().rainStyle,
      opacity: intent().opacity,
      cloudsVisible: intent().cloudsVisible,
      rainVisible: intent().rainVisible,
      isobarsVisible: intent().isobarsVisible,
      fetchImpl: forecastScheduler.fetch,
      request: spec => forecastScheduler.request(spec)
    });
    seam = new CoverageSeam(map);
    windOverlay = new WindOverlay(map, { budget: preparationBudget });
    windOverlay.setOptions({
      style: intent().windStyle,
      visible: intent().windVisible && !intent().peeking,
      paused: intent().windPaused,
      units: intent().units,
      darkChrome: themeOption(intent().theme).darkChrome
    });
    syncWeatherVisibility();

    if (!rootQuery<HTMLElement>('#wind-controls', root)) throw new Error('Missing element #wind-controls');
    const mountWindControls = (factory: typeof import('../features/lazy')['createWindControls']) => {
      const liveHost = rootQuery<HTMLElement>('#wind-controls', root);
      if (!liveHost || destroyed) return;
      windControls?.destroy();
      windControls = factory(liveHost, {
        showTrigger: false,
        initial: {
          style: intent().windStyle,
          visible: intent().windVisible,
          paused: intent().windPaused,
          height: intent().windHeight
        },
        onChange: state => commandSetWind(state, false),
        onCommit: () => writeUrl('replace')
      });
      lastControlVisible = windControls.state.visible;
      windControls.setUnits(intent().units);
      windControls.setStatus(view.wind.value.status);
      windControls.setQuality?.(view.wind.value.overview);
      syncWindHostVisibility();
      syncWindReservation();
    };
    startWindControls = async () => {
      const liveHost = rootQuery<HTMLElement>('#wind-controls', root);
      const alreadyMounted = Boolean(windControls && liveHost && (!('childElementCount' in liveHost) || liveHost.childElementCount > 0));
      if (alreadyMounted || destroyed) return;
      const { createWindControls } = await import('../features/lazy');
      const mountedAfterLoad = Boolean(windControls && liveHost && (!('childElementCount' in liveHost) || liveHost.childElementCount > 0));
      if (mountedAfterLoad || destroyed) return;
      mountWindControls(createWindControls);
    };
    if (import.meta.hot) {
      import.meta.hot.accept('../features/lazy', mod => {
        if (mod && 'createWindControls' in mod && Boolean(build()?.manifest.mapData)) {
          mountWindControls((mod as unknown as typeof import('../features/lazy')).createWindControls);
        }
      });
    }

    const timelineHost = rootQuery<HTMLElement>('#compact-timeline', root);
    if (!timelineHost) throw new Error('Missing element #compact-timeline');
    timeline = createCompactTimeline(timelineHost, {
      offsetMinutes: mapOffsetMinutes,
      variant: intent().dockView,
      ...(camera?.followsPlace() && Number.isFinite(camera.home.lat) && Number.isFinite(camera.home.lng) ? { latitude: camera.home.lat, longitude: camera.home.lng } : {}),
      onSelect: (index, history = 'push') => selectIndex(index, history, true),
      onIntent: index => {
        if (intent().model === AUTO_MODEL_ID) forecastSession.cancelAuto();
        prepareFrameIndex(index);
      },
      onPrepare: index => prepareFrameIndex(index),
      onPlayback: playing => commands.setPlaying(playing)
    });

    pointMarker = createPointMarker(map, root.ownerDocument ?? document);
    pointFeature = createPointFeature({
      root: () => appRoot,
      series: pointSeries,
      isOpen: () => view.point.value.open,
      getBuild: build,
      getSelectedFrame: selectedFrame,
      getUnits: () => intent().units,
      getHorizon: () => intent().pointHorizon,
      getViewMode: () => intent().pointViewMode,
      getMapOffset: () => mapOffsetMinutes,
      getDisplayedFrame: displayedPointFrame,
      getWind: () => {
        const installed = windSession?.installed, displayed = displayedRaster();
        return installed && installed.build === build() && displayed?.build === installed.build && displayed.frame === installed.frame
          ? { build: installed.build, frame: installed.frame, overview: installed.isOverview, sample: (lat, lon) => installed.source.sample(lat, lon, installed.height) }
          : null;
      },
      ensureLive: () => forecastSession.ensureLive(),
      pauseTimeline: () => timeline?.pause(),
      selectFrameById: id => {
        const cancelled = timeline?.cancelGesture();
        const current = build();
        const index = current ? renderedFrames(current.manifest).findIndex(frame => frame.id === id) : -1;
        if (index >= 0) { selectIndex(index, 'push'); return; }
        if (cancelled?.changed) writeUrl(cancelled.delivered ? 'push' : 'replace');
        if (cancelled?.changed && intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto();
      },
      onViewModeChange: mode => commands.setPointViewMode?.(mode),
      onRequestFullHorizon: () => {
        if (intent().pointHorizon !== 'forecast') commands.setPointHorizon('forecast');
      },
      onVisibleDaysChange: days => timeline?.setHighlightedDays?.(days),
      publish: {
        open: point => {
          const easeToken = { point, settled: false };
          activePointEase = easeToken;
          pointMarker?.show(point);
          writer.point({ open: true, location: `${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°` });
          const schedule = root.ownerDocument?.defaultView?.requestAnimationFrame ?? ((cb: FrameRequestCallback) => { cb(0); return 0; });
          schedule(() => {
            if (!destroyed && activePointEase === easeToken && view.point.value.open && map && appRoot) {
              easePointIntoClearView(map, appRoot, point);
            }
          });
        },
        close: () => {
          activePointEase = null;
          timeline?.setHighlightedDays?.(null);
          pointMarker?.clear();
          writer.point({ open: false, status: '', wind: '' });
        },
        status: text => writer.point({ status: text }),
        busy: busy => {
          writer.point({ busy });
          const easeToken = activePointEase;
          if (easeToken && !easeToken.settled && rootQuery('#point-body .av-point-series', root)) {
            easeToken.settled = true;
            const schedule = root.ownerDocument?.defaultView?.requestAnimationFrame ?? ((cb: FrameRequestCallback) => { cb(0); return 0; });
            schedule(() => {
              if (!destroyed && activePointEase === easeToken && view.point.value.open && map && appRoot) {
                easePointIntoClearView(map, appRoot, easeToken.point);
              }
            });
          }
        },
        horizon: (selectable, label) => writer.point({ horizonSelectable: selectable, horizonLabel: label }),
        wind: text => writer.point({ wind: text })
      }
    });

    windSession = createWindSession({
      apiBaseUrl, map, lowMemory, scheduler: forecastScheduler, cache: windCache, budget: preparationBudget,
      selectedPending: pending => { windPending = pending; syncSelectedAdmission(); },
      relieveDisplay: () => overlay!.relievePressure(Math.max(1, protectedWindBytes())) || windOverlay!.relievePressure(),
      overlay: { setWindActive: (active, resident) => overlay!.setWindActive(active, resident) },
      field: { install: (field, prepared, mode, frame) => windOverlay!.install(field, prepared, mode, frame), setField: (field, mode, frame) => windOverlay!.setField(field, mode, frame), setPrepared: (prepared, frame) => windOverlay!.setPrepared(prepared, frame), clear: () => windOverlay!.clear() },
      publish: {
        status: status => { writer.wind({ status }); windControls?.setStatus(status); },
        quality: overview => { writer.wind({ overview }); windControls?.setQuality?.(overview); },
        displayed: displayed => writer.wind({ displayed }),
        reservation: syncWindReservation,
        pointWind: () => pointFeature?.syncWind()
      },
      state: () => ({
        build: build(), selectedFrame: selectedFrame(), height: intent().windHeight, visible: intent().windVisible,
        mapReady: mapReady(), expired: forecast().expired, mapFailed: mapFailed(), aborted: aborted()
      }),
      displayedRaster,
      replacementFailed: () => view.overlay.value.replacementFailed
    });

    locationController = createLocationController({
      map,
      publish: {
        message: message => writer.location({ message }),
        detail: detail => writer.location({ detail }),
        busy: busy => writer.location({ busy })
      },
      isAborted: aborted,
      isMapFailed: mapFailed
    });

    const globalListener = { signal: lifecycle.signal };
    const popoverSelectors = ['#theme-picker[open]', '#model-picker[open]', '#legend-key[open]', '#point-settings[open]', '.av-windgram-key-pop[open]'];
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        let closedPopover = false;
        for (const selector of popoverSelectors) {
          const openPopover = rootQuery<HTMLDetailsElement>(selector, root);
          if (openPopover) { openPopover.open = false; closedPopover = true; }
        }
        if (closedPopover) {
          event.preventDefault();
        } else if (isPointOpen() && !(event.target instanceof Node && rootQuery('#point-body', root)?.contains(event.target))) {
          closePoint();
          event.preventDefault();
        }
      }
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement | null)?.matches?.('input,select,textarea,button,summary')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat && !intent().peeking) {
          spacePeekActive = true;
          commands.setPeeking(true);
        }
        return;
      }
      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        spacePeekActive = false;
        commands.setPeeking(!intent().peeking);
        return;
      }
      if ((event.key === 'w' || event.key === 'W') && view.wind.value.supported) {
        event.preventDefault();
        commands.toggleWeatherLayer('wind');
        return;
      }
      if (event.key === 'i' || event.key === 'I') {
        event.preventDefault();
        commands.toggleWeatherLayer('isobars');
        return;
      }
      if ((event.key === '1' || event.key === '3') && isPointOpen()) {
        event.preventDefault();
        commands.setPointViewMode?.(event.key === '3' ? '3d' : '1d');
        return;
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        const idx = THEME_OPTIONS.findIndex(item => item.id === intent().theme);
        const step = event.key === ']' ? 1 : -1;
        const next = THEME_OPTIONS[(idx + step + THEME_OPTIONS.length) % THEME_OPTIONS.length];
        if (next) commands.setTheme(next.id);
        return;
      }
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !build() || !forecastSession.ensureLive()) return;
      event.preventDefault();
      const frames = renderedFrames(build()!.manifest), index = frames.findIndex(frame => frame.id === selectedFrame());
      timeline?.pause();
      selectIndex(Math.max(0, Math.min(frames.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))), 'replace');
    }, globalListener);

    document.addEventListener('keyup', event => {
      if (event.code === 'Space' && spacePeekActive) {
        spacePeekActive = false;
        commands.setPeeking(false);
      }
    }, globalListener);

    window.addEventListener('blur', () => {
      if (spacePeekActive) {
        spacePeekActive = false;
        commands.setPeeking(false);
      }
    }, globalListener);

    document.addEventListener('pointerdown', event => {
      const targetEl = event.target && typeof (event.target as Element).closest === 'function' ? event.target as Element : null;
      if (targetEl) {
        for (const selector of popoverSelectors) {
          const openEl = rootQuery<HTMLDetailsElement>(selector, root);
          if (openEl && !openEl.contains(targetEl)) openEl.open = false;
        }
      }
      if (map) pointFeature?.dismiss(event.target, map.getContainer());
    }, globalListener);

    const timeInput = rootQuery<HTMLInputElement>('#time', root);
    if (timeInput) {
      timeInput.addEventListener('input', () => { timeline?.pause(); selectIndex(Number(timeInput.value), 'none'); }, globalListener);
      timeInput.addEventListener('change', () => { writeUrl('replace'); if (intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto(); }, globalListener);
    }

    map.on('click', event => {
      if (mapFailed()) return;
      if (isPointOpen()) {
        closePoint();
        return;
      }
      const point = normalizePoint(event.lngLat.lat, event.lngLat.lng);
      void pointFeature?.open(point);
    });
    map.on('move', () => { syncMapClock(false); pointMarker?.sync(); windSession?.reconcile(); });
    map.on('resize', () => { pointMarker?.sync(); });
    map.on('movestart', event => {
      if (!('pointCamera' in event)) activePointEase = null;
      if (intent().model === AUTO_MODEL_ID && !('previewHistory' in event) && !('pointCamera' in event)) {
        history.cancelRestore();
        forecastSession.cancelAuto();
      }
    });
    map.on('moveend', event => {
      syncMapClock(true); pointMarker?.sync(); updateScale();
      if (intent().model !== AUTO_MODEL_ID) updateWind();
      if (build() && !forecast().expired) updateTimeUi();
      const pointCameraMove = Boolean(event && typeof event === 'object' && 'pointCamera' in event);
      if (intent().model === AUTO_MODEL_ID && !history.restoring() && !pointCameraMove) void forecastSession.loadAuto();
      if (urlReady && !history.restoring()) writeUrl('push');
      refreshSeam();
    });
    map.on('error', (event: { error?: unknown }) => {
      if (mapFailed() || !(event.error instanceof maplibregl.GPUInitializationError)) return;
      showMapFailure(event.error);
    });

    installBrowserLifecycle({
      document, window, signal: lifecycle.signal,
      onVisibility: updateFreshness,
      onPageHide: pageHide,
      onPageShow: pageShow
    });
    window.addEventListener('popstate', () => { void applyHistory(); }, globalListener);

    syncWindSupport(); syncLayers(); updateScale();
    map.once('style.load', () => {
      if (aborted() || mapFailed()) return;
      if (!startup.query.camera) focusRegion(intent().model);
      writer.forecast({ mapReady: true });
      seam!.markReady(); updateOverlay(); refreshSeam(); writeUrl('replace');
    });
    void forecastSession.load(store.view.intent.value.model);

    function pageHide(event: PageTransitionEvent): void {
      if (!event.persisted) { disposePermanently(); return; }
      const pointInterrupted = pointFeature?.pending;
      cleanup([
        () => { resumeModel = forecastSession.suspend(); },
        () => windSession?.clear(), () => windCache.clear(), () => locationController?.reset(),
        () => {
          pointMarker?.clear();
          if (!pointInterrupted) return;
          try { pointFeature?.suspend(); }
          finally { writer.point({ open: true, busy: false, status: 'Point request interrupted. Click the map again.' }); }
        },
        () => sky?.clear(),
        () => overlay?.clear(true)
      ]);
    }

    function pageShow(event: PageTransitionEvent): void {
      if (!event.persisted) return;
      if (resumeModel !== null) { const model = resumeModel; resumeModel = null; forecastSession.resume(model); return; }
      if (build() && forecastSession.ensureLive()) {
        updateTimeUi(); updateOverlay(); refreshSeam(); updateFreshness();
      }
    }
  }

  function showMapFailure(error: unknown): void {
    writer.forecast({ mapFailed: true, pendingModel: null });
    writer.notices({
      error: error instanceof maplibregl.GPUInitializationError
        ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
        : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      freshness: ''
    });
    pointMarker?.clear();
    writer.point({ open: false });
    disposePermanently();
  }

  function disposePermanently(): void {
    if (destroyed) return;
    destroyed = true;
    activePointEase = null;
    cleanup([
      () => forecastSession.dispose(), () => lifecycle.abort(),
      () => timeline?.destroy(), () => windControls?.destroy(), () => locationController?.dispose(),
      () => pointMarker?.dispose(), () => pointFeature?.dispose(), () => pointSeries.close(),
      () => windSession?.destroy(), () => windOverlay?.destroy(), () => windCache.clear(),
      () => seam?.destroy(), () => sky?.destroy(), () => overlay?.destroy(),
      () => forecastScheduler.dispose(), () => map?.remove()
    ]);
    timeline = windControls = locationController = null; pointMarker = null; pointFeature = null;
    windSession = null; windOverlay = seam = sky = overlay = null; map = null;
  }

  function cleanup(releases: readonly (() => void)[]): void {
    for (const release of releases) {
      try { release(); } catch (error) { console.error('Preview cleanup failed', error); }
    }
  }

  return { store, commands, start, dispose: disposePermanently };
}

function rootQuery<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}
