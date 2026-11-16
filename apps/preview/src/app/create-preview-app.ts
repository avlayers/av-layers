import {
  ApiClient, assertNotExpired, AUTO_MODEL_ID, createForecastRequestScheduler, formatBuildFreshness, formatPlaceTime,
  longitudeOffsetHours, mapForecastHorizonNotice, resolveAutoBuild, watchBuildExpiry,
  normalizePoint, PointSeriesController, type AutoForecastSelection, type PinnedBuild, type PointHorizon, type UnitSystem
} from '@av/client';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import { displayedWindSpeed, windSpeedUnitLabel } from '@av/contracts/units';
import { WIND_NUMERIC_BYTES, WIND_WINDOW_BYTES, WIND_WINDOW_ENTRIES, WindDataCache } from '@av/client/wind';
import { previewQuery, previewUrl } from '../features/navigation/url-state';
import type { PreviewCommands } from './preview-commands';
import type { PreviewInitialState, PreviewStore } from '../stores/app-store';
import { createPreviewStore, emptyOverlay } from '../stores/app-store';
import { activeLayer, committedFrame, LIFT_LAYERS, layerOptions, resumeModelFor, selectedFrameFor, validatedCustomLayer, visibleCustomLayer } from '../features/forecast/forecast-model';
import { createMap, maplibregl } from '../features/map/map-controller';
import { RasterOverlay } from '../features/raster/raster-overlay';
import { CoverageSeam } from '../features/map/coverage-seam';
import { createWindSession } from '../features/wind/wind-session';
type WindControls = import('../features/wind/wind-controls').WindControls;
import { parseWindPreferences, WIND_STOPS } from '../features/wind/wind-model';
import { WindOverlay } from '../features/wind/wind-overlay';
import { createCompactTimeline, type CompactTimeline } from '../features/timeline/timeline-controller';
type PointSession = ReturnType<typeof import('../features/point/point-session').createPointSession>;
import { createLocationController } from '../features/location/location-controller';
import { installBrowserLifecycle } from '../platform/browser-lifecycle';

const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
const fixtureModel = (import.meta.env.VITE_MODEL ?? 'gfs') as ModelId;

export interface PreviewApp {
  readonly store: PreviewStore;
  readonly commands: PreviewCommands;
  start(root: HTMLElement): void;
  dispose(): void;
}

/** Builds the preview's state and commands. Map and renderer resources start on `start`. */
export function createPreviewApp(): PreviewApp {
  const startup = previewQuery(window.location.search, offlineFixture);
  const storage = safeStorage();
  const readPreference = (key: string): string | null => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const writePreference = (key: string, value: string): void => { try { storage?.setItem(key, value); } catch { /* ignore */ } };
  const preferences = {
    units(): UnitSystem | null { const value = readPreference('preview-units'); return value === 'imperial' ? 'imperial' : value === 'metric' ? 'metric' : null; },
    opacity(): number | null { const raw = readPreference('preview-lift-opacity'), value = raw?.trim() ? Number(raw) : Number.NaN; return value >= 0 && value <= 1 ? value : null; },
    wind() { return parseWindPreferences(readPreference('av.wind-controls.v1')); },
    setUnits(units: UnitSystem) { writePreference('preview-units', units); },
    setOpacity(opacity: number) { writePreference('preview-lift-opacity', String(opacity)); }
  };
  const storedWind = preferences.wind();
  const initialModel = startup.model ?? (offlineFixture ? fixtureModel : AUTO_MODEL_ID);
  const initialOpacity = startup.opacity ?? preferences.opacity() ?? 0.5;
  const initialUnits: UnitSystem = startup.units ?? preferences.units() ?? 'metric';
  const initialWindHeight = startup.windHeight ?? storedWind?.height ?? 'surface';
  const initialFixedHeight = typeof initialWindHeight === 'number' ? initialWindHeight : storedWind?.fixedHeight ?? WIND_STOPS[0];
  const browserOffsetMinutes = -new Date().getTimezoneOffset();
  const initialOffset = startup.camera && Number.isFinite(startup.camera.center[1]) ? longitudeOffsetHours(startup.camera.center[0]) * 60 : browserOffsetMinutes;

  const initial: PreviewInitialState = {
    intent: {
      model: initialModel, reference: startup.reference, customLayer: visibleCustomLayer(startup.layer), opacity: initialOpacity, units: initialUnits,
      windStyle: startup.windStyle ?? storedWind?.style ?? 'trails', windVisible: startup.windVisible ?? storedWind?.visible ?? true,
      windVisibleOverride: startup.windVisible, windPaused: false, windHeight: initialWindHeight, fixedWindHeight: initialFixedHeight,
      pointHorizon: 'day', requestedTime: startup.validTime
    },
    forecast: {
      build: null, selectedFrame: null, pendingModel: null, expired: false, mapReady: false, mapFailed: false, layers: [],
      offsetMinutes: initialOffset, mapCenter: startup.camera ? { lat: startup.camera.center[1], lng: startup.camera.center[0] } : null, playing: false
    },
    overlay: emptyOverlay,
    wind: { status: 'unavailable', overview: false, displayed: false, supported: false },
    point: { open: false, location: '', horizonSelectable: false, horizonLabel: '24 hours', busy: false, status: '', wind: '' },
    location: { message: '', detail: '', busy: false },
    notices: { error: '', tileError: '', horizon: '', freshness: 'Loading latest immutable build…', frameStatus: 'Loading forecast…', overviewReady: 0, overviewTotal: 0, overviewFailed: 0, scaleWidth: 1, scaleText: '' }
  };
  const store = createPreviewStore(initial);
  const { writer, view } = store;

  const api = new ApiClient({ baseUrl: apiBaseUrl });
  const pointSeries = new PointSeriesController(api);
  const lifecycle = new AbortController();

  preferences.setUnits(initialUnits);
  const lowMemory = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? Number.POSITIVE_INFINITY) <= 4;
  const windCache = new WindDataCache(lowMemory ? WIND_NUMERIC_BYTES : WIND_WINDOW_BYTES, lowMemory ? 256 : WIND_WINDOW_ENTRIES);
  const rasterScheduler = createForecastRequestScheduler({ maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024 });
  const windScheduler = createForecastRequestScheduler();

  let map: maplibregl.Map | null = null;
  let overlay: RasterOverlay | null = null;
  let seam: CoverageSeam | null = null;
  let windOverlay: WindOverlay | null = null;
  let windSession: ReturnType<typeof createWindSession> | null = null;
  let windControls: WindControls | null = null;
  let startWindControls: () => Promise<void> = async () => {};
  let timeline: CompactTimeline | null = null;
  let pointSession: PointSession | null = null;
  let pointSessionPromise: Promise<void> | null = null;
  let ensurePointSession: () => Promise<void> = async () => {};
  let locationController: ReturnType<typeof createLocationController> | null = null;

  let home = { lat: 0, lng: 0 };
  let followsPlace = startup.camera !== null;
  let mapOffsetMinutes = initialOffset;
  let urlReady = false, historyRevision = 0, applyingHistory: number | null = null, opacityCommitted = false;
  let lastControlVisible = initial.intent.windVisible;
  let expiryTimer: number | null = null, disposeExpiry = (): void => {};
  let loadAbort: AbortController | null = null, autoAbort: AbortController | null = null, resumeModel: ModelId | null = null;
  let destroyed = false;
  let appRoot: HTMLElement | null = null;

  const intent = () => view.intent.value;
  const forecast = () => view.forecast.value;
  const build = (): PinnedBuild | null => forecast().build;
  const mapReady = () => forecast().mapReady;
  const mapFailed = () => forecast().mapFailed;
  const selectedFrame = () => forecast().selectedFrame;
  const aborted = () => lifecycle.signal.aborted;
  const displayedRaster = () => {
    const displayed = view.overlay.value.displayed;
    return displayed && displayed.build === build() ? { build: displayed.build, frame: displayed.frame } : null;
  };

  const showError = (message: string): void => { writer.notices({ error: message }); };
  const clearError = (): void => { writer.notices({ error: '' }); };

  function syncWindReservation(): void {
    if (!overlay) return;
    const active = Boolean(build()?.manifest.mapData) && intent().windVisible;
    overlay.setWindActive(active, active || Boolean(windSession?.resident) || windCache.allocatedBytes > 0);
  }

  function syncWindSupport(): void {
    const supported = Boolean(build()?.manifest.mapData);
    const host = rootQuery<HTMLElement>('#wind-controls');
    if (host) host.hidden = !supported;
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
    if (!map) return;
    const metres = 80 * 2 * Math.PI * 6371000 * Math.cos(Math.min(85, Math.abs(map.getCenter().lat)) * Math.PI / 180) / (512 * 2 ** map.getZoom());
    const distance = metres / (intent().units === 'metric' ? 1000 : 1609.344);
    const magnitude = 10 ** Math.floor(Math.log10(distance)), value = ([10, 5, 2, 1].find(candidate => candidate * magnitude <= distance) ?? 1) * magnitude;
    writer.notices({ scaleWidth: Math.max(1, 80 * value / distance), scaleText: `${Number(value.toPrecision(2))} ${intent().units === 'metric' ? 'km' : 'mi'}` });
  }

  function updateOverlayStatus(): void {
    const state = view.overlay.value;
    const { displayed, requested, quality, viewLoading, overviewReady, overviewTotal, overviewFailed, incomplete, replacementFailed } = state;
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
    writer.notices({ frameStatus: status, overviewReady, overviewTotal, overviewFailed, tileError });
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
    if (current.expiresAtMs <= now) { expireView(); return; }
    paintMapHorizon(now);
    writer.notices({ freshness: (intent().model === AUTO_MODEL_ID ? `${current.manifest.model} · ` : '') + formatBuildFreshness(current.manifest, current.expiresAtMs, now) });
  }

  function updateTimeUi(): void {
    const frames = build() ? renderedFrames(build()!.manifest) : [];
    timeline?.update(frames, selectedFrame(), !build() || forecast().expired || forecast().mapFailed);
  }

  function ensureLive(): boolean {
    const current = build();
    if (!current || forecast().mapFailed) return false;
    try { assertNotExpired(current.manifest.expiresAt, Date.now()); return true; }
    catch { expireView(); return false; }
  }

  function expireView(): void {
    if (forecast().expired || destroyed) return;
    writer.forecast({ expired: true });
    writer.notices({ tileError: '', horizon: '' });
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    loadAbort?.abort(); windCache.clear(); windSession?.clear(); closePoint(); disposeExpiry(); overlay?.clear(); seam?.sync(null, null);
    updateTimeUi();
    writer.notices({ freshness: 'Expired immutable build' });
    showError('This build has expired. Reload to discover the latest retained build.');
    if (intent().model === AUTO_MODEL_ID) void loadAuto();
  }

  function updateOverlay(): void {
    const layer = activeLayer(build(), intent().reference, intent().customLayer);
    if (!mapReady() || !build() || !selectedFrame() || !layer || !ensureLive()) return;
    clearError(); selectingOverlay = true;
    try { overlay!.select(build()!, layer, selectedFrame()!); refreshSeam(); }
    catch (error) { showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { selectingOverlay = false; updatePointSelection(); }
    updateWind();
  }

  function refreshSeam(): void { seam?.sync(build(), activeLayer(build(), intent().reference, intent().customLayer)); }

  function updatePointWind(): void {
    const current = windSession?.current, context = pointSession?.current;
    if (!current || !windSession?.displayed || !context || context.build !== current.build || pointSession?.frameId !== current.frame) { writer.point({ wind: '' }); return; }
    const validTime = current.build.manifest.frames.find(frame => frame.id === current.frame)?.validTime;
    if (!validTime) { writer.point({ wind: '' }); return; }
    const sample = current.source.sample(context.point.lat, context.point.lon, intent().windHeight);
    const speed = sample.status === 'valid' && sample.u !== null && sample.v !== null ? displayedWindSpeed(Math.hypot(sample.u, sample.v), intent().units) : null;
    const value = speed !== null ? `${speed} ${windSpeedUnitLabel(intent().units)}`
      : sample.status === 'outside' ? 'Outside forecast area' : sample.status === 'no-lift' ? 'No usable lift' : 'Wind unavailable';
    writer.point({ wind: `Map wind · ${formatPlaceTime(Date.parse(validTime), longitudeOffsetHours(context.point.lon) * 60, 'stamp')} · ${value}` });
  }

  function updatePointSelection(): void {
    updatePointWind();
    pointSession?.updateSelection();
  }

  function updateWind(): void {
    windSession?.update();
    updatePointWind();
  }

  function writeUrl(mode: 'push' | 'replace'): void {
    if (applyingHistory !== null || !mapReady() || !urlReady || forecast().pendingModel) return;
    if (!map) return;
    const camera = map.getCenter(), current = build();
    const validTime = intent().model === AUTO_MODEL_ID ? intent().requestedTime ?? undefined : current?.manifest.frames.find(frame => frame.id === selectedFrame())?.validTime;
    const next = previewUrl(window.location.pathname, {
      model: intent().model, reference: intent().reference, layer: intent().customLayer, opacity: intent().opacity,
      lat: camera.lat, lon: camera.lng, zoom: map.getZoom(), validTime,
      ...(intent().windVisibleOverride !== null ? { windVisible: intent().windVisible } : {}),
      windStyle: intent().windStyle, windHeight: intent().windHeight, units: intent().units
    });
    if (next === `${window.location.pathname}${window.location.search}`) return;
    (mode === 'push' ? window.history.pushState : window.history.replaceState).call(window.history, null, '', next);
  }

  function closePoint(): void {
    pointSession?.close();
    if (appRoot) rootQuery<HTMLElement>('#meta', appRoot)?.replaceChildren();
    for (const id of ['#point-settings', '#point-build-details']) { const node = rootQuery<HTMLDetailsElement>(id); if (node) node.open = false; }
  }

  function selectIndex(index: number, history: 'none' | 'push' | 'replace'): void {
    const current = build();
    const frame = current ? renderedFrames(current.manifest)[index] : undefined;
    if (!frame) return;
    if (intent().model === AUTO_MODEL_ID && intent().requestedTime !== frame.validTime) autoAbort?.abort();
    writer.forecast({ selectedFrame: frame.id });
    writer.intent({ requestedTime: frame.validTime });
    updateTimeUi(); pointSession?.followMapFrame(frame.id); updateOverlay(); updatePointSelection();
    if (history !== 'none') { writeUrl(history); if (intent().model === AUTO_MODEL_ID) void loadAuto(); }
  }

  async function loadAuto(): Promise<void> {
    if (intent().model !== AUTO_MODEL_ID || mapFailed() || aborted() || !map) return;
    autoAbort?.abort();
    const request = new AbortController(); autoAbort = request;
    const { lat, lng } = map.getCenter(), time = Date.parse(intent().requestedTime ?? '');
    const custom = intent().customLayer;
    const layers = custom ? [custom, ...LIFT_LAYERS] : intent().reference === 'agl' ? [...LIFT_LAYERS] : [...LIFT_LAYERS].reverse();
    if (!build()) writer.notices({ freshness: 'Finding a forecast for this location…' });
    try {
      const next = await resolveAutoBuild(api, { ...normalizePoint(lat, lng), layers, signal: request.signal, ...(Number.isFinite(time) ? { validTimeMs: time } : {}) });
      if (destroyed || request.signal.aborted || autoAbort !== request || intent().model !== AUTO_MODEL_ID) return;
      if (next) {
        const current = build();
        if (current?.manifest.model === next.build.manifest.model && current.manifest.buildId === next.build.manifest.buildId) {
          if (selectedFrame() !== null && selectedFrame() !== next.frame.id) timeline?.pause();
          writer.forecast({ selectedFrame: next.frame.id });
          pointSession?.followMapFrame(next.frame.id);
          updateTimeUi(); updateOverlay(); updateFreshness();
          if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
          writeUrl('replace');
        } else await loadModel(AUTO_MODEL_ID, next);
        return;
      }
      disposeExpiry();
      if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
      writer.forecast({ build: null, selectedFrame: null });
      syncWindSupport(); syncLayers();
      windSession?.clear(); closePoint(); overlay?.clear(); seam?.sync(null, null); updateTimeUi();
      showError('No forecast covers this location and time.');
      writer.notices({ freshness: 'No viewable build' });
      urlReady = true; writeUrl('replace');
    } catch (error) {
      if (!request.signal.aborted) showError(error instanceof Error ? error.message : String(error));
    } finally { if (autoAbort === request) autoAbort = null; }
  }

  async function loadModel(model: ModelId, resolved?: AutoForecastSelection): Promise<void> {
    if (mapFailed() || !map || destroyed) return;
    resumeModel = null;
    windSession?.clear();
    if (model === AUTO_MODEL_ID && !resolved) {
      loadAbort?.abort(); loadAbort = null;
      writer.forecast({ pendingModel: null });
      writer.intent({ model });
      await loadAuto(); return;
    }
    if (model !== AUTO_MODEL_ID) autoAbort?.abort();
    const replaceUrl = applyingHistory === null, revision = historyRevision;
    disposeExpiry();
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    loadAbort?.abort();
    const requestAbort = new AbortController(); loadAbort = requestAbort;
    writer.intent({ model });
    writer.forecast({ pendingModel: model, expired: false, build: null, selectedFrame: null, layers: [] });
    writer.notices({ tileError: '', horizon: '', error: '', frameStatus: 'Loading forecast…', freshness: `Loading ${model} latest immutable build…` });
    syncWindSupport(); closePoint(); updateTimeUi();
    try {
      const next = resolved?.build ?? await api.latest(model, { signal: requestAbort.signal });
      if (destroyed || requestAbort.signal.aborted || loadAbort !== requestAbort) return;
      writer.forecast({ build: next });
      syncWindSupport(); syncLayers();
      const committed = resolved ? { id: resolved.frame.id, validTime: resolved.frame.validTime } : committedFrame(next, intent().requestedTime, Date.now());
      writer.forecast({ selectedFrame: committed.id });
      if (!resolved && committed.validTime) writer.intent({ requestedTime: committed.validTime });
      updateTimeUi(); updateOverlay(); updateFreshness();
      disposeExpiry = watchBuildExpiry(next.expiresAtMs, expireView, [document, window]);
      if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
      writer.forecast({ pendingModel: null });
      urlReady = true;
      if (replaceUrl && revision === historyRevision) writeUrl('replace');
    } catch (error) {
      if (requestAbort.signal.aborted || loadAbort !== requestAbort || (error instanceof DOMException && error.name === 'AbortError')) return;
      showError(error instanceof Error ? error.message : String(error));
      writer.notices({ freshness: 'No viewable build' });
    } finally {
      if (loadAbort === requestAbort) { loadAbort = null; writer.forecast({ pendingModel: null }); updateOverlayStatus(); }
    }
  }

  function focusRegion(model: ModelId): void {
    if (!map) return;
    const bounds = MODEL_OPTIONS.find(choice => choice.modelId === model)?.bounds;
    if (bounds && bounds[2] - bounds[0] < 360) map.fitBounds([[bounds[0], bounds[1]], [bounds[0] <= bounds[2] ? bounds[2] : bounds[2] + 360, bounds[3]]], { padding: 32, duration: 0 });
  }

  async function applyHistory(): Promise<void> {
    if (aborted()) return;
    const state = previewQuery(window.location.search, offlineFixture), change = ++historyRevision;
    applyingHistory = change;
    try {
      writer.intent({ reference: state.reference, customLayer: visibleCustomLayer(state.layer) });
      const nextUnits: UnitSystem = state.units ?? 'metric';
      if (nextUnits !== intent().units) commandSetUnits(nextUnits);
      const nextVisible = state.windVisible ?? (preferences.wind()?.visible ?? true);
      const nextStyle = state.windStyle ?? 'trails', nextHeight = state.windHeight ?? 'surface';
      const previousHeight = intent().windHeight;
      lastControlVisible = nextVisible;
      writer.intent({ windVisibleOverride: state.windVisible, windVisible: nextVisible, windStyle: nextStyle, windHeight: nextHeight });
      windControls?.setState?.({ visible: nextVisible, style: nextStyle, height: nextHeight });
      windOverlay?.setOptions({ style: nextStyle, visible: nextVisible, paused: intent().windPaused, units: intent().units });
      syncWindReservation();
      windSession?.heightChanged(previousHeight);
      if (state.opacity !== null) { writer.intent({ opacity: state.opacity }); overlay?.setOpacity(state.opacity); }
      if (state.camera) map?.jumpTo(state.camera, { previewHistory: true });
      writer.intent({ requestedTime: state.validTime });
      if (state.model && state.model !== intent().model) { await loadModel(state.model as ModelId); return; }
      if (intent().model === AUTO_MODEL_ID) { await loadAuto(); return; }
      if (build()) {
        const previous = selectedFrame();
        const frame = selectedFrameFor(build()!, state.validTime, Date.now());
        if (frame !== previous) { timeline?.pause(); writer.forecast({ selectedFrame: frame }); pointSession?.followMapFrame(frame); }
        updateTimeUi(); updateOverlay();
      }
    } finally { if (applyingHistory === change) applyingHistory = null; }
  }

  function syncMapClock(): void {
    if (!map) return;
    const center = map.getCenter();
    if (!followsPlace) {
      const moved = Math.abs(center.lat - home.lat) > 1e-4 || Math.abs(((center.lng - home.lng + 540) % 360) - 180) > 1e-4;
      if (!moved) return;
      followsPlace = true;
    }
    if (Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
      writer.forecast({ mapCenter: { lat: center.lat, lng: center.lng } });
      timeline?.setMapCenter(center.lat, center.lng);
    }
    const next = Number.isFinite(center.lng) ? longitudeOffsetHours(center.lng) * 60 : mapOffsetMinutes;
    if (next === mapOffsetMinutes) return;
    mapOffsetMinutes = next;
    writer.forecast({ offsetMinutes: next });
    timeline?.setOffsetMinutes(next);
    updateTimeUi(); updateOverlayStatus(); paintMapHorizon(); updatePointSelection();
  }

  function prepareLayer(layer: 'lift' | import('@av/contracts/layers').LayerId): void {
    const current = build(), frame = selectedFrame();
    if (!current || !frame) return;
    const target = layer === 'lift' ? (intent().reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl') : layer;
    if (current.templates[target]) overlay?.prepare(target, frame);
  }

  function commandSetUnits(units: UnitSystem): void {
    writer.intent({ units });
    preferences.setUnits(units);
    windControls?.setUnits(units);
    windOverlay?.setOptions({ units });
    updateScale(); updatePointSelection(); updatePointWind();
    writeUrl('replace');
  }

  function commandSetWind(state: { style: import('../features/wind/wind-model').WindStyle; visible: boolean; paused: boolean; height: import('../features/wind/wind-model').WindHeight }): void {
    const previousHeight = intent().windHeight;
    if (state.visible !== lastControlVisible) { lastControlVisible = state.visible; writer.intent({ windVisibleOverride: state.visible }); }
    writer.intent({
      windStyle: state.style, windVisible: state.visible, windPaused: state.paused, windHeight: state.height,
      ...(typeof state.height === 'number' ? { fixedWindHeight: state.height } : {})
    });
    syncWindReservation();
    windOverlay?.setOptions({ ...state, units: intent().units });
    windSession?.heightChanged(previousHeight);
    updateWind(); updatePointWind(); writeUrl('replace');
  }

  const commands: PreviewCommands = {
    selectModel(model) {
      if (forecast().mapFailed) return;
      if (intent().model === AUTO_MODEL_ID) applyingHistory = null;
      void loadModel(model);
      focusRegion(model);
    },
    selectReference(reference) {
      writer.intent({ reference, customLayer: null });
      updateOverlay(); writeUrl('push');
      if (intent().model === AUTO_MODEL_ID) void loadAuto();
    },
    selectLayer(layer) {
      writer.intent({ customLayer: layer === 'lift' ? null : layer });
      updateOverlay(); writeUrl('push');
      if (intent().model === AUTO_MODEL_ID) void loadAuto();
    },
    prepareLayer,
    setOpacity(value) {
      const opacity = Math.min(1, Math.max(0, value));
      writer.intent({ opacity });
      preferences.setOpacity(opacity);
      overlay?.setOpacity(opacity);
      writeUrl(opacityCommitted ? 'replace' : 'push'); opacityCommitted = true;
    },
    beginOpacityGesture() { opacityCommitted = false; },
    resetOpacityGesture() { opacityCommitted = false; },
    setUnits(units) { commandSetUnits(units); },
    setWind: commandSetWind,
    setPointHorizon(horizon) { writer.intent({ pointHorizon: horizon as PointHorizon }); void pointSession?.loadRange(); },
    selectFrame(index, history) { selectIndex(index, history); },
    setPlaying(playing) {
      writer.forecast({ playing });
      overlay?.setPlayback(playing);
      windSession?.setPlaying(playing);
      updateOverlayStatus();
    },
    locate() { locationController?.locate(); },
    closePoint() { closePoint(); },
    refreshPointDiagnostics() {
      const meta = appRoot ? rootQuery<HTMLElement>('#meta', appRoot) : null, current = build();
      if (meta && current && pointSession?.current && !meta.children.length) pointSession.renderBuildDetails(meta, current);
    }
  };

  function start(root: HTMLElement): void {
    if (map || destroyed) return;
    appRoot = root;
    const container = rootQuery<HTMLElement>('#map', root);
    if (!container) throw new Error('Missing element #map');
    map = createMap({ container, offlineFixture, camera: startup.camera, deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory });
    const openedAt = map.getCenter();
    home = { lat: openedAt.lat, lng: openedAt.lng };

    overlay = new RasterOverlay(map, apiBaseUrl, intent().opacity, state => {
      writer.overlay(state);
      windSession?.reconcile();
      updateOverlayStatus();
    }, rasterScheduler.fetch);
    seam = new CoverageSeam(map);
    windOverlay = new WindOverlay(map);
    windOverlay.setOptions({ style: intent().windStyle, visible: intent().windVisible, paused: intent().windPaused, units: intent().units });

    const windHost = rootQuery<HTMLElement>('#wind-controls', root);
    if (!windHost) throw new Error('Missing element #wind-controls');
    startWindControls = async () => {
      if (windControls || destroyed) return;
      const { createWindControls } = await import('../features/lazy');
      if (windControls || destroyed) return;
      windControls = createWindControls(windHost, {
        initial: { style: intent().windStyle, visible: intent().windVisible, height: intent().windHeight },
        onChange: state => commandSetWind(state)
      });
      lastControlVisible = windControls.state.visible;
      windControls.setUnits(intent().units);
      windControls.setStatus(view.wind.value.status);
      windControls.setQuality?.(view.wind.value.overview);
      syncWindReservation();
    };

    const timelineHost = rootQuery<HTMLElement>('#compact-timeline', root);
    if (!timelineHost) throw new Error('Missing element #compact-timeline');
    timeline = createCompactTimeline(timelineHost, {
      offsetMinutes: mapOffsetMinutes,
      ...(followsPlace && Number.isFinite(home.lat) && Number.isFinite(home.lng) ? { latitude: home.lat, longitude: home.lng } : {}),
      onSelect: (index, history = 'push') => selectIndex(index, history),
      onPlayback: playing => commands.setPlaying(playing)
    });

    ensurePointSession = async () => {
      if (pointSession) return;
      pointSessionPromise ??= (async () => {
        const { createPointSession } = await import('../features/lazy');
        if (destroyed) return;
        pointSession = createPointSession({
        api, series: pointSeries,
        body: () => rootQuery<HTMLElement>('#point-body', root),
        getBuild: build,
        getSelectedFrame: selectedFrame,
        getUnits: () => intent().units,
        getHorizon: () => intent().pointHorizon,
        getMapOffset: () => mapOffsetMinutes,
        getDisplayedFrame: () => displayedRaster()?.frame ?? null,
        ensureLive,
        pauseTimeline: () => timeline?.pause(),
        selectFrameById: id => {
          const current = build();
          if (!current) return;
          const index = renderedFrames(current.manifest).findIndex(frame => frame.id === id);
          if (index >= 0) selectIndex(index, 'push');
        },
        publish: {
          open: point => { rootQuery<HTMLElement>('#meta', root)?.replaceChildren(); writer.point({ open: true, location: `${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°` }); },
          close: () => { writer.point({ open: false, status: '', wind: '' }); },
          status: text => writer.point({ status: text }),
          busy: busy => writer.point({ busy }),
          horizon: (selectable, label) => writer.point({ horizonSelectable: selectable, horizonLabel: label }),
          wind: text => writer.point({ wind: text }),
            changed: () => updatePointWind()
          }
        });
      })();
      try { await pointSessionPromise; } catch { pointSessionPromise = null; }
    };

    windSession = createWindSession({
      apiBaseUrl, map, lowMemory, scheduler: windScheduler, cache: windCache,
      overlay: { setWindActive: (active, resident) => overlay!.setWindActive(active, resident) },
      field: { setField: (field, mode) => windOverlay!.setField(field, mode), clear: () => windOverlay!.clear() },
      publish: {
        status: status => { writer.wind({ status }); windControls?.setStatus(status); },
        quality: overview => { writer.wind({ overview }); windControls?.setQuality?.(overview); },
        displayed: displayed => writer.wind({ displayed }),
        reservation: syncWindReservation,
        pointWind: updatePointWind
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
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement | null)?.matches?.('input,select,textarea,button')) return;
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !build() || !ensureLive()) return;
      event.preventDefault();
      const frames = renderedFrames(build()!.manifest), index = frames.findIndex(frame => frame.id === selectedFrame());
      timeline?.pause();
      selectIndex(Math.max(0, Math.min(frames.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))), 'replace');
    }, globalListener);

    document.addEventListener('pointerdown', event => {
      if (!pointSession?.current) return;
      const target = event.target;
      const pointControls = ['#point-card', '#ref-agl', '#ref-msl', '#layer-picker', '#time', '#wind-controls', '#compact-timeline', '#display-units'];
      if (!(target instanceof Node) || map!.getContainer().contains(target) || pointControls.some(selector => rootQuery(selector, root)?.contains(target))) return;
      closePoint();
    }, globalListener);

    const timeInput = rootQuery<HTMLInputElement>('#time', root);
    if (timeInput) {
      timeInput.addEventListener('input', () => { timeline?.pause(); selectIndex(Number(timeInput.value), 'none'); }, globalListener);
      timeInput.addEventListener('change', () => { writeUrl('replace'); if (intent().model === AUTO_MODEL_ID) void loadAuto(); }, globalListener);
    }

    map.on('click', event => {
      if (mapFailed()) return;
      const point = normalizePoint(event.lngLat.lat, event.lngLat.lng);
      void (async () => { await ensurePointSession(); await pointSession?.open(point); })();
    });
    map.on('move', syncMapClock);
    map.on('movestart', event => { if (intent().model === AUTO_MODEL_ID && !('previewHistory' in event)) { applyingHistory = null; autoAbort?.abort(); } });
    map.on('moveend', () => {
      syncMapClock(); updateScale();
      if (intent().model !== AUTO_MODEL_ID) updateWind();
      if (build() && !forecast().expired) updateTimeUi();
      if (intent().model === AUTO_MODEL_ID && applyingHistory === null) void loadAuto();
      if (urlReady && applyingHistory === null) writeUrl('push');
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
      if (!startup.camera) focusRegion(intent().model);
      writer.forecast({ mapReady: true });
      seam!.markReady(); updateOverlay(); refreshSeam(); writeUrl('replace');
    });
    void loadModel(initialModel);

    function pageHide(event: PageTransitionEvent): void {
      windCache.clear(); windSession?.clear(); locationController?.reset();
      resumeModel = event.persisted ? resumeModelFor(forecast().pendingModel, intent().model) : null;
      loadAbort?.abort(); autoAbort?.abort();
      const pointInterrupted = event.persisted && pointSession?.pending;
      if (pointInterrupted) {
        pointSession?.suspend();
        writer.point({ open: true, busy: false, status: 'Point request interrupted. Click the map again.' });
      } else if (!event.persisted) pointSession?.close();
      if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
      overlay?.clear(true);
      if (event.persisted) return;
      disposePermanently();
    }

    function pageShow(event: PageTransitionEvent): void {
      if (!event.persisted) return;
      if (resumeModel !== null) { const model = resumeModel; resumeModel = null; void loadModel(model); return; }
      if (build() && ensureLive()) {
        updateTimeUi(); updateOverlay(); refreshSeam(); updateFreshness();
        if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
      }
    }
  }

  function showMapFailure(error: unknown): void {
    lifecycle.abort(); autoAbort?.abort(); loadAbort?.abort(); loadAbort = null;
    writer.forecast({ mapFailed: true, pendingModel: null });
    writer.notices({
      error: error instanceof maplibregl.GPUInitializationError
        ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
        : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      freshness: ''
    });
    closePoint(); disposeExpiry(); windSession?.clear(); locationController?.reset();
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    disposePermanently();
  }

  function disposePermanently(): void {
    if (destroyed) return;
    destroyed = true;
    loadAbort?.abort(); autoAbort?.abort();
    lifecycle.abort();
    disposeExpiry();
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    timeline?.destroy(); windControls?.destroy(); locationController?.dispose(); pointSession?.dispose();
    windSession?.destroy(); windOverlay?.destroy(); seam?.destroy(); overlay?.destroy(); rasterScheduler.dispose();
    map?.remove();
    timeline = windControls = locationController = null; pointSession = null; windSession = null; windOverlay = seam = overlay = null; map = null;
  }

  return { store, commands, start, dispose: disposePermanently };
}

function rootQuery<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
