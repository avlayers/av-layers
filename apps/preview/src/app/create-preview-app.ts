import {
  ApiClient, AUTO_MODEL_ID, createForecastRequestScheduler, createPreparationBudget, formatBuildFreshness, formatPlaceTime,
  isGlobeView, mapForecastHorizonNotice, watchBuildExpiry, normalizePoint, PointSeriesController,
  type PinnedBuild, type PointHorizon, type UnitSystem
} from '@av/client';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import { WindDataCache } from '@av/client/wind';
import type { MapChannel } from '../channels/channel';
import { activeLayer, committedFrame, layerOptions, restoredCustomLayer, validatedCustomLayer, visibleCustomLayer } from '../features/forecast/forecast-model';
import { createForecastSession } from '../features/forecast/forecast-session';
import { createLocationController } from '../features/location/location-controller';
import { BasemapChannel } from '../features/map/basemap';
import { CoverageSeam } from '../features/map/coverage-seam';
import { createMap, createMapCamera, maplibregl, type MapCamera } from '../features/map/map-controller';
import { createHistoryController } from '../features/navigation/history-controller';
import { preparationBudgetBytes, WIND_CACHE_CAPACITY_BYTES } from '../features/raster/raster-budget';
import { RasterOverlay } from '../features/raster/raster-overlay';
import { SkyComposite } from '../features/sky/sky-composite';
import { createCompactTimeline, type CompactTimeline } from '../features/timeline/timeline-controller';
import { installBrowserLifecycle } from '../platform/browser-lifecycle';
import { createPreviewStore, preparedAxisReadiness, type PreviewStore } from '../stores/app-store';
import { themeOption } from '../themes/registry';
import { overlayNotices, overlayUiChanged } from './overlay-status';
import { createPointWiring, type PointWiring } from './point-wiring';
import type { PreviewCommands } from './preview-commands';
import { installShortcuts } from './shortcuts';
import { apiBaseUrl, createStartup, offlineFixture, resolveDisplay, safeStorage } from './startup';
import { createWindWiring, type WindWiring } from './wind-wiring';

export interface PreviewApp {
  readonly store: PreviewStore;
  readonly commands: PreviewCommands;
  start(root: HTMLElement): void;
  dispose(): void;
}

/**
 * Composition root: builds the store, request scheduler and API client, then on `start`
 * creates the map, its channels (lift raster, sky weather, wind), the timeline, the point
 * card and the shortcuts, and routes commands and forecast events between them.
 */
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
  preferences.setUnits(view.intent.value.units);
  const windCache = new WindDataCache(WIND_CACHE_CAPACITY_BYTES, 4096, preparationBudget);

  let map: maplibregl.Map | null = null, camera: MapCamera | null = null, appRoot: HTMLElement | null = null;
  let overlay: RasterOverlay | null = null, sky: SkyComposite | null = null, seam: CoverageSeam | null = null;
  let wind: WindWiring | null = null, point: PointWiring | null = null, timeline: CompactTimeline | null = null;
  let locationController: ReturnType<typeof createLocationController> | null = null;
  let channels: MapChannel[] = [];
  let admissionEpoch = 0, rasterPending = false, windPending = false;
  let mapOffsetMinutes = initialOffset, lastTimelineLat = Number.NaN, lastTimelineLng = Number.NaN;
  let urlReady = false, selectingOverlay = false, destroyed = false;
  let opacityCommitted = false, opacityDragging = false, opacityDirty = false;
  let expiryTimer: number | null = null, resumeModel: ModelId | null = null;

  const intent = () => view.intent.value;
  const forecast = () => view.forecast.value;
  const build = (): PinnedBuild | null => forecast().build;
  const selectedFrame = () => forecast().selectedFrame;
  const mapFailed = () => forecast().mapFailed;
  const aborted = () => lifecycle.signal.aborted;
  const layer = () => activeLayer(build(), intent().reference, intent().customLayer);
  const displayedRaster = () => {
    const displayed = view.overlay.value.displayed;
    return displayed ? { build: displayed.build, frame: displayed.frame } : null;
  };
  const syncSelectedAdmission = () => forecastScheduler.setForegroundPending(++admissionEpoch, rasterPending || windPending);
  const showError = (message: string): void => { writer.notices({ error: message }); };

  function syncRootTheme(): void {
    if (!appRoot?.dataset) return;
    const cur = intent();
    appRoot.dataset.chrome = themeOption(cur.theme).darkChrome ? 'dark' : 'light';
  }

  /** Forwards theme, opacity, visibility and units to every map channel. */
  function syncChannels(): void {
    for (const channel of channels) channel.update(intent());
    wind?.syncHostVisibility();
  }

  function clearForecast(): void {
    wind?.session.clear(); point?.close(); for (const channel of [...channels].reverse()) channel.clear(); seam?.sync(null, null); updateTimeUi();
  }

  const forecastSession = createForecastSession({
    api, writer, intent,
    center: () => { const center = map!.getCenter(); return normalizePoint(center.lat, center.lng); },
    bounds: () => {
      if (!map) return null;
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] as const;
    },
    globe: () => {
      if (!map) return false;
      const bounds = map.getBounds();
      return isGlobeView({ zoom: map.getZoom(), west: bounds.getWest(), east: bounds.getEast() });
    },
    mapFailed, aborted, now: () => Date.now(),
    hooks: {
      onLoading(model) {
        wind?.session.clear(); point?.close();
        writer.notices({ tileError: '', horizon: '', error: '', frameStatus: 'Loading forecast…', freshness: `Loading ${model} latest immutable build…` });
        updateTimeUi();
      },
      onBuild(next) {
        urlReady = true;
        writer.forecast({ layers: layerOptions(next) });
        const customLayer = validatedCustomLayer(next, intent().customLayer);
        if (customLayer !== intent().customLayer) writer.intent({ customLayer });
        wind?.syncSupport(); updateTimeUi(); updateOverlay(); updateFreshness();
      },
      onSameBuild(frame) {
        timeline?.pause();
        if (point?.feature.frameId === selectedFrame()) point.feature.followMapFrame(frame);
      },
      onCleared(message) {
        urlReady = true;
        wind?.syncSupport(); syncLayers(); clearForecast();
        showError(message); writer.notices({ freshness: 'No viewable build' });
      },
      onExpired() {
        writer.notices({ tileError: '', horizon: '' });
        windCache.clear(); clearForecast();
        writer.notices({ freshness: 'Expired immutable build' });
        showError('This build has expired. Reload to discover the latest retained build.');
      },
      onUrl(mode) { writeUrl(mode); },
      watchExpiry(next, expire) { return watchBuildExpiry(next.expiresAtMs, expire, [document, window]); },
      startTimer() { if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000); },
      stopTimer() { if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; } }
    }
  });

  function updatePreparation(): void {
    const current = build(), raster = view.overlay.value;
    const frames = current && !forecast().expired ? renderedFrames(current.manifest) : [];
    const compatible = raster.requested?.build === current && raster.requested?.layer === layer();
    const previews = new Set(compatible ? raster.previewReadyFrames ?? [] : []);
    const details = new Set(compatible ? raster.detailDrawableFrames ?? raster.detailReadyFrames ?? [] : []);
    const readiness = preparedAxisReadiness(frames, previews, details, wind?.readyFrames() ?? null);
    writer.notices({ ...readiness, preparationLimited: Boolean(raster.limited || wind?.limited()) });
    timeline?.setReadiness?.(readiness.overviewReady, readiness.overviewTotal, raster.viewLoading);
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
    const { pendingModel, expired, playing } = forecast();
    writer.notices(overlayNotices(view.overlay.value, { build: build(), pendingModel, expired, playing, offsetMinutes: mapOffsetMinutes }));
    updatePreparation();
    if (!selectingOverlay) point?.feature.syncSelection();
  }

  function paintMapHorizon(now = Date.now()): void {
    const current = build();
    if (!current || forecast().expired) return;
    writer.notices({ horizon: mapForecastHorizonNotice(current.manifest, now, ms => formatPlaceTime(ms, mapOffsetMinutes, 'stamp')) ?? '' });
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

  function updateWind(): void { wind?.session.update(); point?.feature.syncWind(); }
  function refreshSeam(): void { seam?.sync(build(), layer()); }

  function updateOverlay(): void {
    const current = build(), frame = selectedFrame(), selected = layer();
    if (!forecast().mapReady || !current || !frame || !selected || !forecastSession.ensureLive()) return;
    updateWind();
    writer.notices({ error: '' }); selectingOverlay = true;
    try {
      overlay!.select(current, selected, frame);
      sky?.select(current, frame);
      syncChannels();
      refreshSeam();
    } catch (error) { showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { selectingOverlay = false; point?.feature.syncSelection(); }
  }

  function writeUrl(mode: 'push' | 'replace'): void {
    if (!map || !forecast().mapReady || !urlReady || forecast().pendingModel) return;
    const center = map.getCenter(), current = build(), cur = intent();
    const validTime = cur.model === AUTO_MODEL_ID ? cur.requestedTime ?? undefined : current?.manifest.frames.find(frame => frame.id === selectedFrame())?.validTime;
    history.write({
      model: cur.model, reference: cur.reference, layer: cur.customLayer, opacity: cur.opacity,
      lat: center.lat, lon: center.lng, zoom: map.getZoom(), validTime, theme: cur.theme, dockView: cur.dockView,
      liftVisible: cur.liftVisible, cloudsVisible: cur.cloudsVisible, rainVisible: cur.rainVisible, isobarsVisible: cur.isobarsVisible,
      ...(cur.windVisibleOverride !== null ? { windVisible: cur.windVisible } : {}),
      windStyle: cur.windStyle, windHeight: cur.windHeight, units: cur.units
    }, mode, true);
  }

  /** Warms `frameId` for every visible channel, or for one sky channel. */
  function prepareFrame(frameId: string, channel?: 'clouds' | 'rain' | 'isobars'): void {
    const current = build();
    if (!current) return;
    const selected = layer();
    if (!channel && selected && current.templates[selected] && intent().liftVisible) overlay?.prepare(selected, frameId);
    sky?.prepare(current, frameId, channel);
  }

  function prepareFrameIndex(index: number): void {
    const current = build();
    const frame = current && forecast().mapReady && !forecast().expired ? renderedFrames(current.manifest)[index] : undefined;
    if (frame) prepareFrame(frame.id);
  }

  function selectIndex(index: number, mode: 'none' | 'push' | 'replace', fromTimeline = false): void {
    const current = build();
    const frame = current ? renderedFrames(current.manifest)[index] : undefined;
    if (!frame) return;
    if (!fromTimeline) timeline?.cancelGesture();
    if (intent().model === AUTO_MODEL_ID && intent().requestedTime !== frame.validTime) forecastSession.cancelAuto();
    forecastSession.commitFrame(frame.id, frame.validTime);
    updateTimeUi(); point?.feature.followMapFrame(frame.id); updateOverlay(); point?.feature.syncSelection();
    if (mode !== 'none') {
      writeUrl(mode);
      if (intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto();
    }
  }

  function focusRegion(model: ModelId): void {
    camera?.focusRegion(MODEL_OPTIONS.find(choice => choice.modelId === model)?.bounds);
  }

  function setUnits(units: UnitSystem): void {
    writer.intent({ units });
    preferences.setUnits(units);
    wind?.setUnits(units);
    syncChannels();
    point?.relabel(units);
    updateScale(); point?.feature.syncSelection();
    writeUrl('replace');
  }

  async function applyHistory(): Promise<void> {
    if (aborted()) return;
    timeline?.cancelGesture();
    const state = history.read(window.location.search), change = history.beginRestore();
    try {
      const display = resolveDisplay(state, preferences);
      writer.intent({
        reference: state.reference,
        customLayer: restoredCustomLayer(build(), visibleCustomLayer(state.layer), Boolean(state.model && state.model !== intent().model)),
        theme: display.theme, dockView: display.dockView, opacity: display.opacity,
        liftVisible: display.liftVisible, cloudsVisible: display.cloudsVisible, rainVisible: display.rainVisible,
        isobarsVisible: display.isobarsVisible, peeking: false
      });
      syncRootTheme();
      timeline?.setVariant?.(display.dockView);
      syncChannels();
      if (display.units !== intent().units) setUnits(display.units);
      wind?.restore({ visible: display.windVisible, style: display.windStyle, height: display.windHeight }, state.windVisible);
      if (state.camera) map?.jumpTo(state.camera, { previewHistory: true });
      writer.intent({ requestedTime: state.validTime });
      if (state.model && state.model !== intent().model) { await forecastSession.load(state.model as ModelId); return; }
      if (intent().model === AUTO_MODEL_ID) { await forecastSession.loadAuto(); return; }
      const current = build();
      if (current) {
        const committed = committedFrame(current, state.validTime, Date.now());
        if (committed.id !== selectedFrame()) { timeline?.pause(); point?.feature.followMapFrame(committed.id); }
        if (committed.id && committed.validTime) forecastSession.commitFrame(committed.id, committed.validTime);
        updateTimeUi(); updateOverlay();
      }
    } finally { history.endRestore(change); }
  }

  function syncMapClock(settled = false): void {
    if (!map || !camera) return;
    const next = camera.sync();
    if (!Number.isFinite(next.center.lat) || !Number.isFinite(next.center.lng)) return;
    // Avoid re-rendering <App /> or rebuilding the timeline's solar DOM at 60 fps mid-pan.
    if (settled || next.changed || forecast().mapCenter === null) writer.forecast({ mapCenter: next.center });
    if (settled || next.changed || !Number.isFinite(lastTimelineLat)
      || Math.abs(next.center.lat - lastTimelineLat) >= 0.20 || Math.abs(next.center.lng - lastTimelineLng) >= 0.20) {
      lastTimelineLat = next.center.lat;
      lastTimelineLng = next.center.lng;
      timeline?.setMapCenter(next.center.lat, next.center.lng);
    }
    if (!next.changed) return;
    mapOffsetMinutes = camera.offsetMinutes();
    writer.forecast({ offsetMinutes: mapOffsetMinutes });
    timeline?.setOffsetMinutes(mapOffsetMinutes);
    updateTimeUi(); updateOverlayStatus(); paintMapHorizon(); point?.feature.syncSelection();
  }

  const showLayer = (patch: Partial<Pick<ReturnType<typeof intent>, 'reference' | 'customLayer'>>): void => {
    timeline?.cancelGesture();
    writer.intent({ ...patch, liftVisible: true, peeking: false });
    syncChannels();
    updateOverlay(); writeUrl('push');
    if (intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto();
  };

  const commands: PreviewCommands = {
    selectModel(model) {
      if (forecast().mapFailed) return;
      timeline?.cancelGesture();
      if (intent().model === AUTO_MODEL_ID) history.cancelRestore();
      void forecastSession.load(model);
      focusRegion(model);
    },
    selectReference(reference) { showLayer({ reference, customLayer: null }); },
    selectLayer(selected) { showLayer({ customLayer: selected === 'lift' ? null : selected }); },
    prepareLayer(target) {
      const current = build(), frame = selectedFrame();
      const id = target === 'lift' ? (intent().reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl') : target;
      if (current && frame && current.templates[id]) overlay?.prepare(id, frame);
    },
    prepareWeatherChannel(channel) {
      const frame = selectedFrame();
      if (channel === 'lift') commands.prepareLayer('lift');
      else if (channel !== 'wind' && frame) prepareFrame(frame, channel);
    },
    setTheme(theme) {
      if (intent().theme === theme) return;
      writer.intent({ theme });
      preferences.setTheme(theme);
      syncRootTheme();
      syncChannels();
      writeUrl('replace');
    },
    setDockView(dockView) {
      if (intent().dockView === dockView) return;
      writer.intent({ dockView });
      preferences.setDockView(dockView);
      timeline?.setVariant?.(dockView);
      writeUrl('replace');
    },
    toggleWeatherLayer(channel) {
      const cur = intent();
      if (channel === 'wind') {
        wind?.set({ style: cur.windStyle, visible: cur.peeking ? true : !cur.windVisible, paused: cur.windPaused, height: cur.windHeight });
        return;
      }
      const key = `${channel}Visible` as const;
      writer.intent({ [key]: !cur[key], peeking: false });
      syncChannels();
      writeUrl('replace');
    },
    setPeeking(peeking) {
      if (intent().peeking === peeking) return;
      writer.intent({ peeking });
      syncChannels();
    },
    setOpacity(value) {
      const opacity = Math.min(1, Math.max(0, value));
      if (intent().opacity === opacity) return;
      writer.intent({ opacity });
      syncChannels();
      if (opacityDragging) { opacityDirty = true; return; }
      preferences.setOpacity(opacity);
      writeUrl(opacityCommitted ? 'replace' : 'push');
      opacityCommitted = true;
    },
    beginOpacityGesture() { opacityCommitted = false; opacityDragging = true; opacityDirty = false; },
    resetOpacityGesture() {
      const commit = opacityDragging && opacityDirty;
      opacityDragging = opacityDirty = false;
      if (commit) {
        preferences.setOpacity(intent().opacity);
        writeUrl(opacityCommitted ? 'replace' : 'push');
      }
      opacityCommitted = false;
    },
    setUnits,
    setWind(state) { wind?.set(state); },
    setPointHorizon(horizon) {
      const next = horizon as PointHorizon;
      if (intent().pointHorizon === next) return;
      writer.intent({ pointHorizon: next });
      void point?.feature.setHorizon(next);
    },
    setPointViewMode(mode) {
      const nextHorizon: PointHorizon = mode === '3d' ? 'forecast' : intent().pointHorizon;
      const horizonChanged = nextHorizon !== intent().pointHorizon;
      writer.intent({ pointViewMode: mode, pointHorizon: nextHorizon });
      preferences.setPointViewMode(mode);
      if (horizonChanged) void point?.feature.setHorizon(nextHorizon);
      else point?.feature.syncViewMode?.();
    },
    selectFrame(index, mode) { selectIndex(index, mode); },
    setPlaying(playing) {
      writer.forecast({ playing });
      for (const channel of channels) channel.setPlayback?.(playing);
      wind?.session.playbackChanged();
      updateOverlayStatus();
    },
    locate() { locationController?.locate(); },
    closePoint() { point?.close(); },
    refreshPointDiagnostics() { point?.feature.refreshDiagnostics(); }
  };

  function start(root: HTMLElement): void {
    if (map || destroyed) return;
    appRoot = root;
    syncRootTheme();
    const container = root.querySelector<HTMLElement>('#map');
    if (!container) throw new Error('Missing element #map');
    for (const id of ['#wind-controls', '#compact-timeline']) if (!root.querySelector(id)) throw new Error(`Missing element ${id}`);
    const liveMap = map = createMap({ container, offlineFixture, camera: startup.query.camera, theme: intent().theme });
    const openedAt = liveMap.getCenter();
    camera = createMapCamera(liveMap, {
      home: { lat: openedAt.lat, lng: openedAt.lng },
      followsPlace: startup.query.camera !== null,
      initialOffset,
      browserOffset: browserOffsetMinutes
    });

    wind = createWindWiring({
      root, map: liveMap, store, preferences, apiBaseUrl, scheduler: forecastScheduler, cache: windCache, budget: preparationBudget,
      lowMemory: preparationBudget.limit <= 128 * 1024 * 1024,
      raster: () => overlay, displayedRaster,
      selectedPending: pending => { windPending = pending; syncSelectedAdmission(); },
      syncChannels, preparationChanged: updatePreparation, pointWindChanged: () => point?.feature.syncWind(),
      writeUrl: () => writeUrl('replace'), destroyed: () => destroyed, aborted
    });
    const windWiring = wind;
    overlay = new RasterOverlay(liveMap, apiBaseUrl, intent().opacity, state => {
      if (!overlayUiChanged(view.overlay.value, state)) return;
      writer.overlay(state);
      windWiring.session.reconcile();
      updateOverlayStatus();
    }, forecastScheduler.fetch, spec => forecastScheduler.request(spec), {
      budget: preparationBudget, requestLimits, theme: intent().theme,
      protectedBytes: windWiring.protectedBytes,
      beforeReveal: selection => windWiring.session.beforeRasterReveal(selection),
      onSelectedPending: pending => { rasterPending = pending; syncSelectedAdmission(); }
    });
    const cur = intent();
    sky = new SkyComposite(liveMap, api, apiBaseUrl, {
      theme: cur.theme, opacity: cur.opacity, cloudsVisible: cur.cloudsVisible, rainVisible: cur.rainVisible, isobarsVisible: cur.isobarsVisible,
      fetchImpl: forecastScheduler.fetch, request: spec => forecastScheduler.request(spec)
    });
    seam = new CoverageSeam(liveMap);
    channels = [new BasemapChannel(liveMap, intent().theme), overlay, sky, windWiring.overlay];
    syncChannels();

    timeline = createCompactTimeline(root.querySelector<HTMLElement>('#compact-timeline')!, {
      offsetMinutes: mapOffsetMinutes,
      variant: intent().dockView,
      ...(camera.followsPlace() && Number.isFinite(camera.home.lat) && Number.isFinite(camera.home.lng) ? { latitude: camera.home.lat, longitude: camera.home.lng } : {}),
      onSelect: (index, mode = 'push') => selectIndex(index, mode, true),
      onIntent: index => {
        if (intent().model === AUTO_MODEL_ID) forecastSession.cancelAuto();
        prepareFrameIndex(index);
      },
      onPrepare: prepareFrameIndex,
      onPlayback: playing => commands.setPlaying(playing)
    });

    const livePoint = point = createPointWiring({
      root, map: liveMap, store, series: pointSeries, build, selectedFrame,
      offsetMinutes: () => mapOffsetMinutes,
      displayedFrame: () => {
        const displayed = view.overlay.value.displayed;
        return displayed && displayed.build === build() ? displayed.frame : null;
      },
      wind: () => windWiring.pointWind(),
      ensureLive: () => forecastSession.ensureLive(),
      timeline: () => timeline,
      selectFrameById: id => {
        const cancelled = timeline?.cancelGesture();
        const current = build();
        const index = current ? renderedFrames(current.manifest).findIndex(frame => frame.id === id) : -1;
        if (index >= 0) { selectIndex(index, 'push'); return; }
        if (cancelled?.changed) writeUrl(cancelled.delivered ? 'push' : 'replace');
        if (cancelled?.changed && intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto();
      },
      setViewMode: mode => commands.setPointViewMode?.(mode),
      setHorizon: horizon => commands.setPointHorizon(horizon),
      destroyed: () => destroyed
    });

    locationController = createLocationController({
      map: liveMap,
      publish: {
        message: message => writer.location({ message }),
        detail: detail => writer.location({ detail }),
        busy: busy => writer.location({ busy })
      },
      isAborted: aborted,
      isMapFailed: mapFailed
    });

    installShortcuts({
      root, signal: lifecycle.signal, store, commands,
      point: { isOpen: livePoint.isOpen, close: livePoint.close, dismiss: target => livePoint.feature.dismiss(target, liveMap.getContainer()) },
      stepFrame: step => {
        const current = build();
        if (!current || !forecastSession.ensureLive()) return false;
        const frames = renderedFrames(current.manifest), index = frames.findIndex(frame => frame.id === selectedFrame());
        timeline?.pause();
        selectIndex(Math.max(0, Math.min(frames.length - 1, index + step)), 'replace');
        return true;
      }
    });
    const timeInput = root.querySelector<HTMLInputElement>('#time');
    if (timeInput) {
      timeInput.addEventListener('input', () => { timeline?.pause(); selectIndex(Number(timeInput.value), 'none'); }, { signal: lifecycle.signal });
      timeInput.addEventListener('change', () => { writeUrl('replace'); if (intent().model === AUTO_MODEL_ID) void forecastSession.loadAuto(); }, { signal: lifecycle.signal });
    }

    liveMap.on('click', event => {
      if (mapFailed()) return;
      if (livePoint.isOpen()) { livePoint.close(); return; }
      void livePoint.feature.open(normalizePoint(event.lngLat.lat, event.lngLat.lng));
    });
    liveMap.on('move', () => { syncMapClock(false); livePoint.marker.sync(); windWiring.session.reconcile(); });
    liveMap.on('resize', () => { livePoint.marker.sync(); livePoint.syncBarReserve(); });
    liveMap.on('movestart', event => {
      if (!('pointCamera' in event)) livePoint.cancelEase();
      if (intent().model === AUTO_MODEL_ID && !('previewHistory' in event) && !('pointCamera' in event)) {
        history.cancelRestore();
        forecastSession.cancelAuto();
      }
    });
    liveMap.on('moveend', event => {
      syncMapClock(true); livePoint.marker.sync(); updateScale();
      const pointCameraMove = Boolean(event && typeof event === 'object' && 'pointCamera' in event);
      if (intent().model !== AUTO_MODEL_ID || pointCameraMove) updateWind();
      if (build() && !forecast().expired) updateTimeUi();
      if (intent().model === AUTO_MODEL_ID && !history.restoring() && !pointCameraMove) void forecastSession.loadAuto();
      if (urlReady && !history.restoring()) writeUrl('push');
      refreshSeam();
    });
    liveMap.on('error', (event: { error?: unknown }) => {
      if (mapFailed() || !(event.error instanceof maplibregl.GPUInitializationError)) return;
      showMapFailure(event.error);
    });

    installBrowserLifecycle({ document, window, signal: lifecycle.signal, onVisibility: updateFreshness, onPageHide: pageHide, onPageShow: pageShow });
    window.addEventListener('popstate', () => { void applyHistory(); }, { signal: lifecycle.signal });

    windWiring.syncSupport(); syncLayers(); updateScale();
    liveMap.once('style.load', () => {
      if (aborted() || mapFailed()) return;
      if (!startup.query.camera) focusRegion(intent().model);
      writer.forecast({ mapReady: true });
      seam?.markReady(); updateOverlay(); refreshSeam(); writeUrl('replace');
    });
    void forecastSession.load(intent().model);
  }

  function pageHide(event: PageTransitionEvent): void {
    if (!event.persisted) { disposePermanently(); return; }
    const pointInterrupted = point?.feature.pending;
    cleanup([
      () => { resumeModel = forecastSession.suspend(); },
      () => wind?.session.clear(), () => windCache.clear(), () => locationController?.reset(),
      () => {
        point?.marker.clear();
        if (!pointInterrupted) return;
        try { point?.feature.suspend(); }
        finally { writer.point({ open: true, busy: false, status: 'Point request interrupted. Click the map again.' }); }
      },
      ...[...channels].reverse().map(channel => () => channel.clear(true))
    ]);
  }

  function pageShow(event: PageTransitionEvent): void {
    if (!event.persisted) return;
    if (resumeModel !== null) { const model = resumeModel; resumeModel = null; forecastSession.resume(model); return; }
    if (build() && forecastSession.ensureLive()) { updateTimeUi(); updateOverlay(); refreshSeam(); updateFreshness(); }
  }

  function showMapFailure(error: unknown): void {
    writer.forecast({ mapFailed: true, pendingModel: null });
    writer.notices({
      error: error instanceof maplibregl.GPUInitializationError
        ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
        : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      freshness: ''
    });
    point?.marker.clear();
    writer.point({ open: false });
    disposePermanently();
  }

  function disposePermanently(): void {
    if (destroyed) return;
    destroyed = true;
    point?.cancelEase();
    cleanup([
      () => forecastSession.dispose(), () => lifecycle.abort(),
      () => timeline?.destroy(), () => locationController?.dispose(),
      () => point?.marker.dispose(), () => point?.feature.dispose(), () => pointSeries.close(),
      () => wind?.destroyControls(), () => wind?.session.destroy(), () => windCache.clear(), () => seam?.destroy(),
      ...[...channels].reverse().map(channel => () => channel.destroy()),
      () => forecastScheduler.dispose(), () => map?.remove()
    ]);
    timeline = locationController = point = wind = null;
    seam = sky = overlay = null; channels = []; map = null;
  }

  return { store, commands, start, dispose: disposePermanently };
}

function cleanup(releases: readonly (() => void)[]): void {
  for (const release of releases) {
    try { release(); } catch (error) { console.error('Preview cleanup failed', error); }
  }
}
