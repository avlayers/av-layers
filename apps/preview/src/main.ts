import { renderBuildDiagnostics } from '@av/client/dom';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LIFT_RENDER_STYLE, LIFT_STEP_RENDER_STYLE, renderedLayers, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, type LayerId } from '@av/contracts/layers';
import { normalizeLon } from '@av/contracts/geometry';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import { displayedWindSpeed, windSpeedUnitLabel } from '@av/contracts/units';
import {
  ApiClient, createForecastRequestScheduler, AUTO_MODEL_ID, activePalettes, assertNotExpired,
  pointSeriesSelection, mapForecastHorizonNotice, formatBuildFreshness, formatPlaceTime, formatViewerTime, browserTimeZone, longitudeOffsetHours,
  normalizePoint, PointSeriesController, resolveAutoBuild, watchBuildExpiry,
  type AutoForecastSelection, type GeoPoint, type PinnedBuild, type PointSeries, type PointSeriesContext, type PointHorizon, type UnitSystem
} from '@av/client';
import { WIND_NUMERIC_BYTES, WIND_WINDOW_BYTES, WIND_WINDOW_ENTRIES, WindDataCache, WindDataSource } from '@av/client/wind';
import './style.css';
import { CoverageSeam } from './coverage-seam';
import { RasterOverlay, type OverlayState } from './raster-overlay';
import { FOCUS_DWELL_MS } from './raster-overview';
import { RASTER_CACHE_TILES } from './raster-budget';
import { previewQuery, previewUrl, type AltitudeReference } from './url-state';
import { frameIndexFor, PLAYBACK_STEP_MS } from './timeline';
import { WindOverlay } from './wind-overlay';
import { createWindControls, type WindStatus } from './wind-controls';
import { createCompactTimeline } from './compact-timeline';
import { naturalBasemapStyle } from './basemap';

type PointWindgram = typeof import('@av/windgram');

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const modelBar = element<HTMLDivElement>('models'), modelPicker = element<HTMLDetailsElement>('model-picker'), modelSelected = element<HTMLElement>('model-selected');
const layerPicker = element<HTMLDivElement>('layer-picker'), metricButton = element<HTMLButtonElement>('units-metric'), imperialButton = element<HTMLButtonElement>('units-imperial');
const locateButton = element<HTMLButtonElement>('locate'), locationStatus = element<HTMLParagraphElement>('location-status'), distanceScale = element<HTMLParagraphElement>('distance-scale');
const referenceGroup = element<HTMLDivElement>('reference'), refAgl = element<HTMLButtonElement>('ref-agl'), refMsl = element<HTMLButtonElement>('ref-msl');
const opacityInput = element<HTMLInputElement>('opacity'), opacityReadout = element<HTMLSpanElement>('opacity-readout'), timeInput = element<HTMLInputElement>('time');
const timestamp = element<HTMLParagraphElement>('timestamp'), frameStatus = element<HTMLParagraphElement>('frame-status'), timelineStatus = element<HTMLParagraphElement>('timeline-status');
const legend = element<HTMLElement>('legend'), legendBody = element<HTMLDivElement>('legend-body'), horizonNotice = element<HTMLParagraphElement>('horizon-notice');
const tileErrorBox = element<HTMLParagraphElement>('tile-error'), errorBox = element<HTMLParagraphElement>('error'), freshness = element<HTMLParagraphElement>('freshness');
const pointCard = element<HTMLElement>('point-card'), pointClose = element<HTMLButtonElement>('point-close'), pointSettings = element<HTMLDetailsElement>('point-settings');
const pointBuildDetails = element<HTMLDetailsElement>('point-build-details'), pointLocation = element<HTMLParagraphElement>('point-location'), pointWind = element<HTMLParagraphElement>('point-wind');
const pointStatus = element<HTMLParagraphElement>('point-status'), pointBody = element<HTMLDivElement>('point-body');
const windControlsHost = element<HTMLElement>('wind-controls');
const pointHorizonSelect = element<HTMLSelectElement>('point-horizon'), pointHorizonLabel = element<HTMLLabelElement>('point-horizon-label'), meta = element<HTMLDListElement>('meta');

const LIFT: readonly LayerId[] = ['usable-lift-agl', 'usable-lift-msl'];
const HIDDEN_PREVIEW_LAYERS: ReadonlySet<LayerId> = new Set(['precip-rate']);
const isLiftLayer = (layer: LayerId): boolean => layer === 'usable-lift-agl' || layer === 'usable-lift-msl';
const visibleCustomLayer = (layer: LayerId | null): LayerId | null => layer && !HIDDEN_PREVIEW_LAYERS.has(layer) ? layer : null;
const shortLayerName = (layer: LayerId, d?: { label: string }): string =>
  layer.startsWith('cloud') ? 'Cloud' : (d?.label ?? layer).replace(/\s*\(.*\)$/, '');

const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
const api = new ApiClient({ baseUrl: apiBaseUrl });
const startup = previewQuery(window.location.search, offlineFixture);

const stored = (key: string): string | null => { try { return window.localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string): void => { try { window.localStorage.setItem(key, value); } catch { /* ignore */ } };

const initialModel = startup.model ?? (offlineFixture ? import.meta.env.VITE_MODEL ?? 'gfs' : AUTO_MODEL_ID);
const savedOpacity = stored('preview-lift-opacity'), savedOpacityNum = savedOpacity?.trim() ? Number(savedOpacity) : NaN;
const initialOpacity = startup.opacity ?? (savedOpacityNum >= 0 && savedOpacityNum <= 1 ? savedOpacityNum : 0.5);

if (offlineFixture) {
  const warning = Object.assign(document.createElement('p'), { className: 'toast fixture-warning', textContent: 'SYNTHETIC FIXTURE — development data, not a forecast' });
  document.getElementById('app')?.prepend(warning);
}

maplibregl.setWorkerUrl(workerUrl);
opacityInput.value = String(initialOpacity);
opacityReadout.textContent = `${Math.round(initialOpacity * 100)}%`;

const modelButtons: HTMLButtonElement[] = [];

interface WindView { zoom: number; build: PinnedBuild; frame: string; bounds: [number, number, number, number]; source: WindDataSource }
interface WindRequest extends WindView { controller: AbortController; key: string; core?: [number, number, number, number]; settled?: 'ready' | 'unavailable'; failed?: unknown; done?: Promise<'ready' | 'unavailable'> }

function startPreview(lifecycle: AbortController): void {
  modelBar.replaceChildren(); modelButtons.length = 0;
  for (const choice of offlineFixture ? [{ modelId: initialModel, label: 'Synthetic fixture' }] : [...MODEL_OPTIONS, { modelId: AUTO_MODEL_ID, label: 'Auto' }]) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'model-button', value: choice.modelId, textContent: choice.label });
    modelButtons.push(button); modelBar.append(button);
  }

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const map = new maplibregl.Map({
    container: 'map', center: startup.camera?.center ?? [0, 20], zoom: startup.camera?.zoom ?? 2,
    ...(deviceMemory !== undefined && deviceMemory <= 4 ? { maxTileCacheSize: RASTER_CACHE_TILES } : {}),
    style: offlineFixture ? { version: 8, sources: {}, layers: [{ id: 'neutral-background', type: 'background', paint: { 'background-color': '#d5dde3' } }] } : naturalBasemapStyle(window.devicePixelRatio)
  });
  const globalListener = { signal: lifecycle.signal };

  let build: PinnedBuild | null = null, currentModel: ModelId = initialModel, reference: AltitudeReference = startup.reference;
  let customLayer: LayerId | null = visibleCustomLayer(startup.layer), requestedTime = startup.validTime, selectedFrame: string | null = null, opacity = initialOpacity;
  let expired = false, mapFailed = false, mapReady = false, selectingOverlay = false;
  let overlayState: OverlayState = { displayed: null, requested: null, quality: null, viewLoading: false, overviewReady: 0, overviewTotal: 0, overviewFailed: 0, incomplete: false, replacementFailed: false };
  const rasterScheduler = createForecastRequestScheduler({ maxActive: 8, maxInFlightBytes: 4 * 1024 * 1024 });
  const lowMemory = deviceMemory !== undefined && deviceMemory <= 4;
  const windScheduler = createForecastRequestScheduler(), windCache = new WindDataCache(lowMemory ? WIND_NUMERIC_BYTES : WIND_WINDOW_BYTES, lowMemory ? 256 : WIND_WINDOW_ENTRIES);
  const overlay = new RasterOverlay(map, apiBaseUrl, opacity, state => { overlayState = state; reconcileWind(); updateOverlayStatus(); }, rasterScheduler.fetch);
  const seam = new CoverageSeam(map);
  const refreshSeam = (): void => { seam.sync(build, activeLayer()); };

  let ribbon: { build: PinnedBuild; layer: LayerId } | null = null, layerButtons: HTMLButtonElement[] = [], layerMenuSignature = '';
  let pendingModel: ModelId | null = null, resumeModel: ModelId | null = null;
  let loadAbort: AbortController | null = null, autoAbort: AbortController | null = null;
  const pointSeries = new PointSeriesController(api);
  const savedUnits = startup.units ?? stored('preview-units');
  let pointUnitSystem: UnitSystem = savedUnits === 'imperial' ? 'imperial' : 'metric';
  let pointHorizon: PointHorizon = 'day', windgram: PointWindgram | null = null;
  let updatePointSeries: ReturnType<PointWindgram['renderPointWindgram']> | null = null;
  let pointSelection: { update: ReturnType<PointWindgram['renderPointWindgram']>; frame: string | null; units: UnitSystem; mapFrame: string | null; mapOffset: number } | null = null;
  let expiryTimer: number | null = null, disposeExpiry = () => {};
  let urlReady = false, historyRevision = 0, applyingHistory: number | null = null, opacityCommitted = false;
  let windVisibleOverride: boolean | null = startup.windVisible;
  let windView: WindView | null = null, windRequest: WindRequest | null = null, windPrefetch: WindRequest | null = null, installedWind: WindView | null = null;
  let windPlaying = false, windPrefetchBlocked = false;
  const windHeld = new Map<string, WindRequest>();
  let fillTimer: ReturnType<typeof setTimeout> | null = null;
  const retiring = new Map<WindView, ReturnType<typeof setTimeout>>();
  let windLoadStatus: WindStatus = 'unavailable', windDisplayed = false, windLoading = false, windHeight: 'surface' | number | 'lift' = 'surface';
  let queuedWindLoad: (() => void) | null = null;
  let locationRevision = 0, locationMarker: HTMLElement | null = null, locationPoint: [number, number] | null = null, locationTimer: ReturnType<typeof setTimeout> | null = null;

  const openedAt = map.getCenter();
  const home = { lat: openedAt.lat, lng: openedAt.lng };
  let followsPlace = startup.camera !== null;
  const browserOffsetMinutes = -new Date().getTimezoneOffset();
  let mapOffsetMinutes = followsPlace && Number.isFinite(home.lng) ? longitudeOffsetHours(home.lng) * 60 : browserOffsetMinutes;
  const hasWindData = (): boolean => Boolean(build?.manifest.mapData);

  const windOverlay = new WindOverlay(map);
  let lastControlVisible = true;
  const windControls = createWindControls(windControlsHost, {
    initial: {
      ...(startup.windStyle ? { style: startup.windStyle } : {}),
      ...(startup.windVisible !== null ? { visible: startup.windVisible } : {}),
      ...(startup.windHeight !== null ? { height: startup.windHeight } : {})
    },
    onChange(state) {
      if (state.visible !== lastControlVisible) { lastControlVisible = state.visible; windVisibleOverride = state.visible; }
      syncWindReservation();
      windOverlay.setOptions({ ...state, units: pointUnitSystem });
      if (windDisplayed && windHeight !== state.height) setWindField('replace');
      updateWind(); updatePointWind(); writeUrl('replace');
    }
  });
  lastControlVisible = windControls.state.visible;
  const syncWindReservation = (): void => {
    const active = hasWindData() && windControls.state.visible;
    overlay.setWindActive(active, active || Boolean(windView) || windCache.allocatedBytes > 0);
  };
  const syncWindSupport = (): void => {
    windControlsHost.hidden = !hasWindData();
    if (!hasWindData()) clearWind();
    syncWindReservation();
  };
  const compactTimeline = createCompactTimeline(element('compact-timeline'), {
    offsetMinutes: mapOffsetMinutes,
    ...(followsPlace && Number.isFinite(home.lat) && Number.isFinite(home.lng) ? { latitude: home.lat, longitude: home.lng } : {}),
    onSelect: (index, history = 'push') => selectIndex(index, history),
    onPlayback: playing => {
      windPlaying = playing; overlay.setPlayback(playing);
      if (playing) windPrefetchBlocked = false;
      scheduleWindFill(playing ? 0 : FOCUS_DWELL_MS);
    }
  });
  syncWindSupport();
  windControls.setUnits(pointUnitSystem);
  windOverlay.setOptions({ ...windControls.state, units: pointUnitSystem });

  function syncMapClock(): void {
    const center = map.getCenter();
    if (!followsPlace) {
      const moved = Math.abs(center.lat - home.lat) > 1e-4 || Math.abs(normalizeLon(center.lng) - normalizeLon(home.lng)) > 1e-4;
      if (!moved) return;
      followsPlace = true;
    }
    if (Number.isFinite(center.lat) && Number.isFinite(center.lng)) compactTimeline.setMapCenter(center.lat, center.lng);
    const next = Number.isFinite(center.lng) ? longitudeOffsetHours(center.lng) * 60 : mapOffsetMinutes;
    if (next === mapOffsetMinutes) return;
    mapOffsetMinutes = next;
    compactTimeline.setOffsetMinutes(next);
    updateTimeUi();
    updateOverlayStatus();
    paintMapHorizon();
    updatePointSelection();
  }

  function cameraBounds(): [number, number, number, number] {
    const bounds = map.getBounds(), west = bounds.getWest(), east = bounds.getEast();
    return [east - west >= 360 ? -180 : normalizeLon(west), Math.max(-90, bounds.getSouth()), east - west >= 360 ? 180 : normalizeLon(east), Math.min(90, bounds.getNorth())];
  }

  function windBounds(): [number, number, number, number] {
    const [west, south, east, north] = cameraBounds();
    if (east - west >= 360 || lowMemory) return [west, south, east, north];
    const lat = Math.min(85, Math.max(-85, (south + north) / 2));
    const height = north - south, width = east >= west ? east - west : east + 360 - west;
    const meters = Math.PI * 6_371_000 / 180, lonScale = Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const pad = Math.min(height * meters, width * meters * lonScale) / 2;
    return [Math.max(-180, west - pad / (meters * lonScale)), Math.max(-90, south - pad / meters), Math.min(180, east + pad / (meters * lonScale)), Math.min(90, north + pad / meters)];
  }

  function windRetained(view: WindView): boolean {
    return windView === view || windRequest === view || windPrefetch === view || retiring.has(view) || [...windHeld.values()].includes(view as WindRequest);
  }

  function dropRetired(): void {
    for (const [view, timer] of retiring) { clearTimeout(timer); view.source.dispose(); }
    retiring.clear();
  }

  function retire(view: WindView): void {
    if (retiring.has(view)) return;
    retiring.set(view, setTimeout(() => {
      retiring.delete(view);
      if (!windRetained(view)) view.source.dispose();
    }, PLAYBACK_STEP_MS + 50));
  }

  function releasePrefetch(): void {
    const prefetch = windPrefetch;
    windPrefetch = null;
    if (!prefetch) return;
    prefetch.controller.abort();
    if (!windRetained(prefetch)) prefetch.source.dispose();
  }

  function setWindField(mode: 'replace' | 'swap'): void {
    const view = windView;
    if (!view) return;
    if (mode === 'swap' && installedWind === view) return;
    const previous = mode === 'swap' ? installedWind : null;
    const height = windControls.state.height;
    windHeight = height;
    windOverlay.setField(typeof view.source.field === 'function' ? view.source.field(height) : {
      sample: (lat, lon) => {
        const s = view.source.sample(lat, normalizeLon(lon), height);
        const status = s.status === 'valid' ? STATUS_VALID : s.status === 'no-lift' ? STATUS_NO_LIFT : s.status === 'outside' ? STATUS_OUTSIDE : STATUS_UNAVAILABLE;
        return { ...s, status };
      }
    }, mode);
    installedWind = view;
    windDisplayed = true;
    if (previous && previous !== view) retire(previous);
  }

  function reconcileWind(): void {
    const displayed = overlayState.displayed;
    const sameBuild = Boolean(windView && windView.build === build && (windLoadStatus !== 'unavailable' || windView.frame !== selectedFrame));
    const aligned = Boolean(sameBuild && windView!.frame === selectedFrame && (!displayed || displayed.build === windView!.build && displayed.frame === windView!.frame));
    if (aligned) setWindField(installedWind && installedWind.build === windView!.build ? 'swap' : 'replace');
    else if (!sameBuild && windDisplayed) { windOverlay.clear(); windDisplayed = false; installedWind = null; }
    windControls.setQuality?.(!!(aligned && windView?.source.isOverview));
    if (windLoadStatus === 'ready') windControls.setStatus(aligned ? 'ready' : overlayState.replacementFailed ? 'unavailable' : 'loading');
    syncWindReservation();
    updatePointWind();
  }

  function setWindStatus(status: WindStatus): void { windLoadStatus = status; windControls.setStatus(status); }
  function cancelWindRequest(): void {
    const request = windRequest;
    windRequest = null; queuedWindLoad = null;
    request?.controller.abort();
    if (request && !windRetained(request)) request.source.dispose();
  }

  function clearWind(): void {
    cancelFill();
    for (const view of windHeld.values()) if (view !== windView && view !== windRequest) view.source.dispose();
    windHeld.clear();
    releasePrefetch(); dropRetired(); cancelWindRequest();
    if (installedWind && installedWind !== windView) installedWind.source.dispose();
    windView?.source.dispose(); windView = null; installedWind = null; windDisplayed = false;
    windOverlay.clear(); windControls.setQuality?.(false); setWindStatus('unavailable'); syncWindReservation(); updatePointWind();
  }

  function updatePointWind(): void {
    const context = pointSeries.current, identity = windView;
    if (!context || !windDisplayed || !identity || context.build !== identity.build || pointSeries.frameId !== identity.frame) { pointWind.textContent = ''; return; }
    const validTime = identity.build.manifest.frames.find(f => f.id === identity.frame)?.validTime;
    if (!validTime) { pointWind.textContent = ''; return; }
    const sample = identity.source.sample(context.point.lat, context.point.lon, windControls.state.height);
    const speed = sample.status === 'valid' && sample.u !== null && sample.v !== null ? displayedWindSpeed(Math.hypot(sample.u, sample.v), pointUnitSystem) : null;
    const value = speed !== null ? `${speed} ${windSpeedUnitLabel(pointUnitSystem)}`
      : sample.status === 'outside' ? 'Outside forecast area' : sample.status === 'no-lift' ? 'No usable lift' : 'Wind unavailable';
    pointWind.textContent = `Map wind · ${formatPlaceTime(Date.parse(validTime), longitudeOffsetHours(context.point.lon) * 60, 'stamp')} · ${value}`;
  }

  function coversBounds(outer: readonly [number, number, number, number], inner: readonly [number, number, number, number]): boolean {
    const span = (w: number, e: number) => (e - w + 360) % 360 || (e === w ? 0 : 360);
    return inner[1] >= outer[1] && inner[3] <= outer[3] && span(outer[0], inner[0]) + span(inner[0], inner[2]) <= span(outer[0], outer[2]);
  }

  function updateWind(): void {
    if (!windControls.state.visible || !hasWindData()) { cancelWindRequest(); releasePrefetch(); syncWindReservation(); return; }
    if (!mapReady || !build || !selectedFrame || expired || mapFailed || lifecycle.signal.aborted) return;
    if (windCache.isBuildUnavailable(build.manifest.buildId)) { clearWind(); return; }
    const camera = cameraBounds(), view = windBounds(), identity = windView;
    const covered = (candidate: WindView) => (candidate.source.isOverview === false || map.getZoom() <= candidate.zoom) && coversBounds(candidate.bounds, camera);
    for (const [frame, held] of windHeld) if (held.build !== build || !covered(held)) { windHeld.delete(frame); if (!windRetained(held)) held.source.dispose(); }
    if (identity && identity.build === build && identity.frame === selectedFrame && covered(identity)) {
      cancelWindRequest(); setWindStatus('ready'); reconcileWind(); scheduleWindFill(); return;
    }
    cancelFill();
    if (windPrefetch && !covered(windPrefetch)) releasePrefetch();
    const held = windHeld.get(selectedFrame);
    if (held && held.build === build && covered(held) && held.done) {
      windHeld.delete(selectedFrame); cancelWindRequest();
      watch(held, held.settled ? Promise.resolve(held.settled) : held.done); return;
    }
    const prefetch = windPrefetch;
    if (prefetch && prefetch.build === build && prefetch.frame === selectedFrame && covered(prefetch) && prefetch.done) {
      windPrefetch = null; cancelWindRequest();
      watch(prefetch, prefetch.settled ? Promise.resolve(prefetch.settled) : prefetch.done); return;
    }
    const key = JSON.stringify([build.manifest.model, build.manifest.buildId, selectedFrame, view, map.getZoom()]);
    if (key === windRequest?.key) return;
    if (identity && identity.build !== build) clearWind();
    else cancelWindRequest();
    setWindStatus('loading');
    const request: WindRequest = {
      zoom: map.getZoom(), build, frame: selectedFrame, bounds: view, core: camera, key, controller: new AbortController(),
      source: new WindDataSource(apiBaseUrl, { fetchImpl: windScheduler.fetch, cache: windCache, coalesceSpans: true })
    };
    watch(request);
  }

  function cancelFill(): void {
    if (fillTimer !== null) { clearTimeout(fillTimer); fillTimer = null; }
  }

  function scheduleWindFill(delay = FOCUS_DWELL_MS): void {
    if (fillTimer !== null || windPrefetch || windPrefetchBlocked || lowMemory) return;
    fillTimer = setTimeout(() => { fillTimer = null; ensurePrefetch(); }, delay);
  }

  function ensurePrefetch(): void {
    if (windPrefetchBlocked || windPrefetch || lowMemory || !windControls.state.visible || !hasWindData() || !mapReady || !build || !selectedFrame || expired || mapFailed) return;
    const frames = renderedFrames(build.manifest), index = frames.findIndex(frame => frame.id === selectedFrame);
    const frame = frames.map(item => item.id)
      .filter(id => id !== selectedFrame && id !== windView?.frame && id !== windRequest?.frame && !windHeld.has(id))
      .sort((a, b) => Math.abs(frames.findIndex(item => item.id === a) - index) - Math.abs(frames.findIndex(item => item.id === b) - index))[0];
    if (!frame) return;
    const view = windBounds();
    const request: WindRequest = {
      zoom: map.getZoom(), build, frame, bounds: view, core: cameraBounds(), key: `prefetch:${frame}`, controller: new AbortController(),
      source: new WindDataSource(apiBaseUrl, { fetchImpl: windScheduler.fetch, cache: windCache, coalesceSpans: true })
    };
    windPrefetch = request;
    const done = request.source.load({ ...request, signal: request.controller.signal }).then(status => { request.settled = status; return status; }, error => { request.failed = error; throw error; });
    request.done = done;
    void done.then(status => {
      if (windPrefetch !== request) return;
      windPrefetch = null;
      if (status === 'ready') {
        const admitted = request.source.admitted;
        if (admitted) request.bounds = [admitted[0], admitted[1], admitted[2], admitted[3]];
        windHeld.set(request.frame, request); scheduleWindFill(0);
      }
      else if (!windRetained(request)) request.source.dispose();
    }, error => {
      if (error instanceof RangeError) windPrefetchBlocked = true;
      if (windPrefetch === request) windPrefetch = null;
      if (!windRetained(request)) request.source.dispose();
    });
  }

  function watch(request: WindRequest, work?: Promise<'ready' | 'unavailable'>): void {
    windRequest = request;
    const run = async () => {
      windLoading = true;
      const retain = () => Boolean(windView && windView.build === request.build && windView.frame === request.frame && coversBounds(windView.bounds, request.bounds));
      const pending = work ?? (request.done = request.source.load({ ...request, signal: request.controller.signal }));
      try {
        let status: 'ready' | 'unavailable';
        try { status = await pending; }
        catch (error) {
          if (!(error instanceof RangeError) || request.controller.signal.aborted) throw error;
          releasePrefetch();
          if (!windView || retain()) throw error;
          windPrefetchBlocked = true;
          for (const held of windHeld.values()) if (held !== windView) held.source.dispose();
          windHeld.clear();
          dropRetired(); windView.source.dispose(); windView = null; windDisplayed = false; installedWind = null; windOverlay.clear();
          status = await request.source.load({ ...request, signal: request.controller.signal });
        }
        if (windRequest !== request || request.controller.signal.aborted || !ensureLive()) return;
        if (status === 'ready') {
          const previous = windView;
          const admitted = request.source.admitted;
          if (admitted) request.bounds = [admitted[0], admitted[1], admitted[2], admitted[3]];
          windView = request;
          windHeld.set(request.frame, request);
          if (previous && previous !== request && previous.frame !== request.frame && previous.build === request.build) windHeld.set(previous.frame, previous as WindRequest);
          else if (previous && previous !== request && (previous !== installedWind || !(windDisplayed && previous.build === request.build))) {
            if (previous === installedWind) installedWind = null;
            if (!windRetained(previous)) previous.source.dispose();
          }
          setWindStatus('ready');
        } else setWindStatus(retain() ? 'ready' : status);
        reconcileWind();
        if (status === 'ready') scheduleWindFill();
      } catch {
        if (windRequest === request && !request.controller.signal.aborted) { setWindStatus(retain() ? 'ready' : 'unavailable'); reconcileWind(); }
      } finally {
        if (windRequest === request) windRequest = null;
        if (!windRetained(request)) request.source.dispose();
        windLoading = false;
        const next = queuedWindLoad; queuedWindLoad = null; next?.();
      }
    };
    if (windLoading) queuedWindLoad = () => { void run(); };
    else void run();
  }

  function updateScale(): void {
    const metres = 80 * 2 * Math.PI * 6371000 * Math.cos(Math.min(85, Math.abs(map.getCenter().lat)) * Math.PI / 180) / (512 * 2 ** map.getZoom());
    const distance = metres / (pointUnitSystem === 'metric' ? 1000 : 1609.344);
    const magnitude = 10 ** Math.floor(Math.log10(distance)), value = ([10, 5, 2, 1].find(v => v * magnitude <= distance) ?? 1) * magnitude;
    distanceScale.style.width = `${Math.max(1, 80 * value / distance)}px`;
    distanceScale.textContent = `${Number(value.toPrecision(2))} ${pointUnitSystem === 'metric' ? 'km' : 'mi'}`;
  }

  function setUnits(choice: UnitSystem, updateHistory = false): void {
    pointUnitSystem = choice;
    store('preview-units', choice);
    for (const [b, key] of [[metricButton, 'metric'], [imperialButton, 'imperial']] as const) b.ariaPressed = String(choice === key);
    if (!overlayState.displayed || isLiftLayer(overlayState.displayed.layer)) element('lift-units').textContent = pointUnitSystem === 'metric' ? 'Lift m' : 'Lift ft';
    windControls.setUnits(pointUnitSystem); windOverlay.setOptions({ units: pointUnitSystem });
    ribbon = null;
    if (overlayState.displayed) renderRibbon(overlayState.displayed.layer, overlayState.displayed.build);
    updateScale(); updatePointSelection(); updatePointWind();
    if (updateHistory) writeUrl('replace');
  }

  const liftLayers = (v: PinnedBuild): LayerId[] => LIFT.filter(l => v.templates[l]);
  const nonLiftLayers = (v: PinnedBuild): LayerId[] => renderedLayers(v.manifest.layers, v.manifest.descriptors.layers).filter(l => v.templates[l] && !isLiftLayer(l) && !HIDDEN_PREVIEW_LAYERS.has(l));

  function activeLayer(): LayerId | null {
    if (!build) return null;
    if (customLayer && build.templates[customLayer]) return customLayer;
    const preferred: LayerId = reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl';
    return build.templates[preferred] ? preferred : liftLayers(build)[0] ?? nonLiftLayers(build)[0] ?? null;
  }

  function syncLayerPicker(): void {
    if (!build) { layerPicker.hidden = true; return; }
    if (customLayer && !build.templates[customLayer]) customLayer = null;
    const items = [...(liftLayers(build).length ? [{ id: 'lift', label: 'Lift' }] : []), ...nonLiftLayers(build).map(id => ({ id, label: shortLayerName(id, build!.manifest.descriptors.layers[id]) }))];
    const sig = items.map(i => i.id).join('|');
    if (sig !== layerMenuSignature) {
      layerMenuSignature = sig;
      layerButtons = items.map(item => {
        const b = Object.assign(document.createElement('button'), { type: 'button', value: item.id, textContent: item.label });
        const prepare = () => {
          if (b.disabled || !selectedFrame || !build) return;
          const target = item.id === 'lift' ? (reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl') : item.id as LayerId;
          if (build.templates[target]) overlay.prepare(target, selectedFrame);
        };
        for (const ev of ['pointerenter', 'focus', 'pointerdown']) b.addEventListener(ev, prepare);
        b.addEventListener('click', () => {
          if (b.disabled) return;
          customLayer = item.id === 'lift' ? null : item.id as LayerId;
          syncLayerPicker(); syncReference(); updateOverlay(); writeUrl('push');
          if (currentModel === AUTO_MODEL_ID) void loadAuto();
        });
        return b;
      });
      layerPicker.replaceChildren(...layerButtons);
    }
    layerPicker.hidden = items.length <= 1;
    const selectedId = customLayer ?? 'lift';
    for (const b of layerButtons) {
      b.className = b.value === selectedId ? 'layer-button is-selected' : 'layer-button';
      b.ariaPressed = String(b.value === selectedId); b.disabled = !build || expired || mapFailed;
    }
  }

  function syncReference(): void {
    for (const [b, r] of [[refAgl, 'agl'], [refMsl, 'msl']] as const) { b.className = reference === r ? 'ref is-selected' : 'ref'; b.ariaPressed = String(reference === r); }
    referenceGroup.hidden = customLayer !== null;
  }

  function syncModels(): void {
    for (const b of modelButtons) b.className = b.value === currentModel ? 'model-button is-selected' : 'model-button';
    const label = modelButtons.find(b => b.value === currentModel)?.textContent ?? currentModel;
    element('model-name').textContent = currentModel === AUTO_MODEL_ID && build ? `${label} · ${build.manifest.model}` : label;
    modelSelected.dataset.model = currentModel === AUTO_MODEL_ID ? build?.manifest.model ?? 'auto' : currentModel;
  }

  function writeUrl(mode: 'push' | 'replace'): void {
    if (applyingHistory || !mapReady || !urlReady || pendingModel) return;
    const camera = map.getCenter(), wState = windControls.state;
    const validTime = currentModel === AUTO_MODEL_ID ? requestedTime ?? undefined : build?.manifest.frames.find(f => f.id === selectedFrame)?.validTime;
    const next = previewUrl(window.location.pathname, {
      model: currentModel, reference, layer: customLayer, opacity, lat: camera.lat, lon: camera.lng, zoom: map.getZoom(),
      validTime, ...(windVisibleOverride !== null ? { windVisible: wState.visible } : {}), windStyle: wState.style, windHeight: wState.height, units: pointUnitSystem
    });
    if (next !== `${window.location.pathname}${window.location.search}`) window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', next);
  }

  const showError = (msg: string): void => { errorBox.hidden = false; errorBox.textContent = msg; };
  const clearError = (): void => { errorBox.hidden = true; errorBox.textContent = ''; };
  const setPointStatus = (msg = ''): void => { pointStatus.textContent = msg; pointStatus.hidden = !msg; };

  function closePoint(): void {
    pointSeries.close(); pointCard.hidden = true; pointCard.ariaBusy = 'false';
    pointSettings.open = pointBuildDetails.open = false; setPointStatus();
    windgram?.disposePointWindgram(pointBody); pointBody.replaceChildren();
    updatePointSeries = pointSelection = null; pointWind.textContent = ''; pointBody.tabIndex = -1; meta.replaceChildren();
  }

  function setControlsEnabled(enabled: boolean): void {
    for (const b of modelButtons) b.disabled = mapFailed || pendingModel !== null;
    for (const b of layerButtons) b.disabled = !enabled;
    refAgl.disabled = refMsl.disabled = opacityInput.disabled = timeInput.disabled = !enabled;
    compactTimeline.update(build ? renderedFrames(build.manifest) : [], selectedFrame, !enabled);
  }

  function paintMapHorizon(now = Date.now()): void {
    if (!build || expired) return;
    const notice = mapForecastHorizonNotice(build.manifest, now, ms => formatPlaceTime(ms, mapOffsetMinutes, 'stamp'));
    horizonNotice.textContent = notice ?? ''; horizonNotice.hidden = notice === null;
  }

  function updateFreshness(): void {
    overlay.refresh();
    if (!build || expired) return;
    const now = Date.now();
    if (build.expiresAtMs <= now) { expireView(); return; }
    paintMapHorizon(now);
    freshness.textContent = (currentModel === AUTO_MODEL_ID ? `${build.manifest.model} · ` : '') + formatBuildFreshness(build.manifest, build.expiresAtMs, now);
  }

  function renderRibbon(layer: LayerId, displayedBuild = build): void {
    if (!legend.hidden && ribbon?.build === displayedBuild && ribbon.layer === layer) return;
    const palette = displayedBuild ? activePalettes(displayedBuild.manifest.descriptors.palettes, layer, displayedBuild.manifest.descriptors.layers)[0] : undefined;
    if (!displayedBuild || !palette) { legend.hidden = true; legendBody.replaceChildren(); return; }
    legend.hidden = false; ribbon = { build: displayedBuild, layer };
    const descriptor = displayedBuild.manifest.descriptors.layers[layer], liftLayer = isLiftLayer(layer);
    referenceGroup.hidden = !liftLayer;
    const altitudeUnit = pointUnitSystem === 'imperial' ? 'ft' : 'm';
    element('lift-units').textContent = liftLayer ? `Lift ${altitudeUnit}` : `${shortLayerName(layer, descriptor)} ${palette.units}`;

    const title = Object.assign(document.createElement('p'), {
      className: 'ribbon-title',
      textContent: layer === 'usable-lift-agl' ? `Lift above ground (${altitudeUnit} AGL)` : layer === 'usable-lift-msl' ? `Top of usable lift (${altitudeUnit} MSL)` : `${descriptor.label} (${palette.units})`
    });
    const scale = Object.assign(document.createElement('div'), { className: 'ribbon-scale' }), colorCount = palette.colors.length;
    palette.colors.forEach((color, index) => {
      const edge = index === colorCount - 1 && palette.edges.length > colorCount ? palette.edges[colorCount] : palette.edges[index];
      const showTick = edge !== undefined && (index === 0 || index === colorCount - 1 || index === Math.floor(colorCount / 3) || index === Math.floor(colorCount * 2 / 3));
      const val = edge === undefined ? 0 : liftLayer ? Math.round(edge * (pointUnitSystem === 'imperial' ? 3.280839895 : 1)) : edge;
      const label = !showTick ? '' : !liftLayer ? (val >= 100 ? String(Math.round(val)) : String(Number(val.toFixed(1)))) : val >= 1000 ? `${Number((val / 1000).toFixed(1))}k` : String(val);
      const row = Object.assign(document.createElement('div'), { className: 'ribbon-stop' }), swatch = document.createElement('span'), tick = Object.assign(document.createElement('span'), { textContent: label });
      swatch.style.background = color; row.append(swatch, tick); scale.append(row);
    });
    const body = Object.assign(document.createElement('div'), { className: 'ribbon-main' });
    body.append(title, scale);
    if (liftLayer) {
      element('legend-reference').textContent = layer === 'usable-lift-agl' ? 'AGL shows usable lift height above ground.' : 'MSL includes ground elevation. Choose AGL to see usable lift height above ground.';
      const renderStyle = displayedBuild.manifest.tool.liftRenderStyle;
      element('legend-no-lift').textContent = layer === 'usable-lift-msl' && (renderStyle === LIFT_STEP_RENDER_STYLE || renderStyle === LIFT_RENDER_STYLE)
        ? 'No usable lift: the map shows ground elevation, including at night.' : 'No usable lift: clear areas on the map.';
      const sink = displayedBuild.manifest.descriptors.methods[descriptor.methodId]?.parameters.sinkRateMps;
      element('legend-cutoff').textContent = Number.isFinite(sink) && sink > 0 ? `Usable lift requires predicted updrafts above ${sink} m/s. Nearby terrain can cross this cutoff.` : 'Usable lift depends on the predicted updraft and terrain.';
    } else {
      element('legend-reference').textContent = `${descriptor.label} in ${palette.units}.`;
      element('legend-no-lift').textContent = descriptor.hideNonPositiveValues ? 'Zero or trace values are clear on the map.' : 'Shaded across all covered cells.';
      element('legend-cutoff').textContent = descriptor.timeSupport.startsWith('interval') ? 'Aggregated over the forecast interval ending at the selected time.' : 'Instantaneous value at the selected valid time.';
    }
    legendBody.replaceChildren(body);
  }

  function updateTimeUi(): void {
    const frames = build ? renderedFrames(build.manifest) : [];
    compactTimeline.update(frames, selectedFrame, !build || expired || mapFailed);
    if (!build || !selectedFrame) { timestamp.textContent = expired ? 'Build expired — overlay removed' : 'No frame selected'; return; }
    const selected = frames.find(f => f.id === selectedFrame) ?? frames[0];
    timeInput.max = String(Math.max(0, frames.length - 1));
    if (document.activeElement !== timeInput) timeInput.value = String(Math.max(0, frames.findIndex(f => f.id === selectedFrame)));
    timestamp.textContent = selected ? `Selected · ${formatPlaceTime(Date.parse(selected.validTime), mapOffsetMinutes, 'stamp')}` : 'No frame selected';
  }

  function updateOverlayStatus(): void {
    const { displayed, requested, quality, viewLoading, overviewReady, overviewTotal, overviewFailed, incomplete, replacementFailed } = overlayState;
    const showing = displayed ? `Showing ${displayed.build.manifest.model} ${displayed.frame} ${displayed.layer}.` : 'No forecast displayed.';
    const pending = requested && (!displayed || displayed.build !== requested.build || displayed.layer !== requested.layer || displayed.frame !== requested.frame);
    const olderBuild = displayed && displayed.build !== build;
    const displayedTime = displayed?.build.manifest.frames.find(f => f.id === displayed.frame)?.validTime;
    const displayedLabel = displayedTime ? formatPlaceTime(Date.parse(displayedTime), mapOffsetMinutes, 'stamp') : '';
    frameStatus.dataset.quality = quality ?? 'none';
    const status = !displayed ? requested ? replacementFailed ? 'Forecast unavailable · No forecast shown' : 'Loading selected time · No forecast shown' : expired ? 'Forecast expired' : pendingModel ? 'Loading forecast…' : 'No forecast shown'
      : pending ? `Showing ${displayedLabel} · ${replacementFailed ? 'Selected time unavailable' : 'Loading selected time…'}`
      : quality === 'overview' ? `${displayedLabel} · Overview${windPlaying ? '' : (replacementFailed ? ' · Detail unavailable' : ' · Loading detail…')}`
      : viewLoading ? `${displayedLabel} · Loading this view…` : `${displayedLabel} · ${incomplete ? 'Detail incomplete' : 'Full detail'}`;
    if (frameStatus.textContent !== status) frameStatus.textContent = status;
    timelineStatus.dataset.ready = String(overviewReady); timelineStatus.dataset.total = String(overviewTotal); timelineStatus.hidden = !overviewTotal;
    timelineStatus.textContent = overviewReady === overviewTotal ? 'Timeline ready' : `${overviewReady + overviewFailed === overviewTotal ? 'Timeline partly ready' : 'Preparing timeline'} · ${overviewReady} / ${overviewTotal} times ready`;
    const alert = replacementFailed || incomplete;
    tileErrorBox.className = alert ? 'toast error' : 'toast status'; tileErrorBox.role = alert ? 'alert' : 'status';
    tileErrorBox.hidden = !alert && !pendingModel && !olderBuild;
    tileErrorBox.textContent = replacementFailed ? `Forecast replacement failed. ${showing}` : incomplete ? `Overlay tile failed to load — forecast display may be incomplete. ${showing}` : pendingModel ? `Loading ${pendingModel}. ${showing}` : olderBuild ? showing : '';
    if (displayed) renderRibbon(displayed.layer, displayed.build); else { legend.hidden = true; legendBody.replaceChildren(); }
    if (!selectingOverlay) updatePointSelection();
  }

  const displayedPointFrame = (): string | null => overlayState.displayed?.build === build ? overlayState.displayed.frame : null;

  function updatePointSelection(): void {
    updatePointWind();
    if (!updatePointSeries) return;
    const frame = pointSeries.frameId, mapFrame = displayedPointFrame();
    if (pointSelection?.update === updatePointSeries && pointSelection.frame === frame && pointSelection.units === pointUnitSystem && pointSelection.mapFrame === mapFrame && pointSelection.mapOffset === mapOffsetMinutes) return;
    pointSelection = { update: updatePointSeries, frame, units: pointUnitSystem, mapFrame, mapOffset: mapOffsetMinutes };
    updatePointSeries(frame, pointUnitSystem, mapFrame, undefined, mapOffsetMinutes);
  }

  function expireView(): void {
    if (expired) return;
    expired = true;
    tileErrorBox.hidden = horizonNotice.hidden = true; tileErrorBox.textContent = horizonNotice.textContent = '';
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    loadAbort?.abort(); windCache.clear(); clearWind(); closePoint(); disposeExpiry(); overlay.clear(); seam.sync(null, null);
    setControlsEnabled(false);
    timestamp.textContent = 'Build expired — overlay removed'; freshness.textContent = 'Expired immutable build';
    showError('This build has expired. Reload to discover the latest retained build.');
    if (currentModel === AUTO_MODEL_ID) void loadAuto();
  }

  function ensureLive(): boolean {
    if (!build || mapFailed) return false;
    try { assertNotExpired(build.manifest.expiresAt, Date.now()); return true; } catch { expireView(); return false; }
  }

  function updateOverlay(): void {
    const layer = activeLayer();
    if (!mapReady || !build || !selectedFrame || !layer || !ensureLive()) return;
    clearError(); selectingOverlay = true;
    try { overlay.select(build, layer, selectedFrame); refreshSeam(); }
    catch (error) { showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { selectingOverlay = false; updatePointSelection(); }
    updateWind();
  }

  function selectIndex(index: number, history: 'none' | 'push' | 'replace'): void {
    const frame = build ? renderedFrames(build.manifest)[index] : undefined;
    if (!frame) return;
    if (currentModel === AUTO_MODEL_ID && requestedTime !== frame.validTime) autoAbort?.abort();
    selectedFrame = frame.id; requestedTime = frame.validTime;
    updateTimeUi(); pointSeries.followMapFrame(selectedFrame); updateOverlay(); updatePointSelection();
    if (history !== 'none') { writeUrl(history); if (currentModel === AUTO_MODEL_ID) void loadAuto(); }
  }

  const followMapFrame = (): void => { pointSeries.followMapFrame(selectedFrame); updatePointSelection(); };
  function chooseFrame(value: PinnedBuild): void {
    const frames = renderedFrames(value.manifest);
    selectedFrame = frames[frameIndexFor(frames, requestedTime, Date.now())]?.id ?? null;
    const frame = value.manifest.frames.find(f => f.id === selectedFrame);
    if (frame) requestedTime = frame.validTime;
  }

  async function loadAuto(): Promise<void> {
    if (currentModel !== AUTO_MODEL_ID || mapFailed || lifecycle.signal.aborted) return;
    autoAbort?.abort();
    const request = new AbortController(); autoAbort = request;
    const { lat, lng } = map.getCenter(), time = Date.parse(requestedTime ?? '');
    const layers = customLayer ? [customLayer, ...LIFT] : reference === 'agl' ? LIFT : [...LIFT].reverse();
    if (!build) freshness.textContent = 'Finding a forecast for this location…';
    try {
      const next = await resolveAutoBuild(api, { ...normalizePoint(lat, lng), layers, signal: request.signal, ...(Number.isFinite(time) ? { validTimeMs: time } : {}) });
      if (request.signal.aborted || autoAbort !== request || currentModel !== AUTO_MODEL_ID) return;
      if (next) {
        if (build?.manifest.model === next.build.manifest.model && build.manifest.buildId === next.build.manifest.buildId) {
          if (selectedFrame !== null && selectedFrame !== next.frame.id) compactTimeline.pause();
          selectedFrame = next.frame.id; followMapFrame(); updateTimeUi(); updateOverlay(); updateFreshness();
          if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
          writeUrl('replace');
        } else await loadModel(AUTO_MODEL_ID, next);
        return;
      }
      disposeExpiry();
      if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
      build = selectedFrame = null; syncModels(); syncWindSupport();
      clearWind(); closePoint(); overlay.clear(); seam.sync(null, null); updateTimeUi(); setControlsEnabled(false);
      showError('No forecast covers this location and time.'); freshness.textContent = 'No viewable build';
      urlReady = true; writeUrl('replace');
    } catch (error) {
      if (!request.signal.aborted) showError(error instanceof Error ? error.message : String(error));
    } finally { if (autoAbort === request) autoAbort = null; }
  }

  async function loadModel(model: ModelId, resolved?: AutoForecastSelection): Promise<void> {
    if (mapFailed) return;
    clearWind();
    if (model === AUTO_MODEL_ID && !resolved) {
      loadAbort?.abort(); loadAbort = pendingModel = null; currentModel = model;
      syncModels(); setControlsEnabled(build !== null && !expired);
      await loadAuto(); return;
    }
    if (model !== AUTO_MODEL_ID) autoAbort?.abort();
    const replaceUrl = applyingHistory === null, revision = historyRevision;
    disposeExpiry();
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    loadAbort?.abort();
    const requestAbort = new AbortController(); loadAbort = requestAbort;
    pendingModel = model; resumeModel = null; currentModel = model; expired = false;
    syncModels();
    tileErrorBox.hidden = horizonNotice.hidden = legend.hidden = true; tileErrorBox.textContent = horizonNotice.textContent = '';
    build = selectedFrame = null; syncWindSupport(); syncLayerPicker(); updateTimeUi(); legendBody.replaceChildren();
    closePoint(); setControlsEnabled(false); clearError();
    freshness.textContent = `Loading ${model} latest immutable build…`; timestamp.textContent = 'No frame selected';
    updateOverlayStatus();
    try {
      const next = resolved?.build ?? await api.latest(model, { signal: requestAbort.signal });
      if (requestAbort.signal.aborted || loadAbort !== requestAbort) return;
      build = next; syncModels(); syncWindSupport(); syncLayerPicker();
      pointHorizonLabel.hidden = pointSeriesSelection(next).frames.length === next.manifest.frames.length;
      pointHorizonSelect.children[0].textContent = next.manifest.mapFrameCount !== undefined ? 'Map forecast' : '24 hours';
      if (resolved) selectedFrame = resolved.frame.id; else chooseFrame(next);
      updateTimeUi(); updateOverlay(); updateFreshness(); setControlsEnabled(true); syncReference();
      disposeExpiry = watchBuildExpiry(next.expiresAtMs, expireView, [document, window]);
      if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
      if (loadAbort === requestAbort) pendingModel = null;
      urlReady = true;
      if (replaceUrl && revision === historyRevision) writeUrl('replace');
    } catch (error) {
      if (requestAbort.signal.aborted || loadAbort !== requestAbort || (error instanceof DOMException && error.name === 'AbortError')) return;
      showError(error instanceof Error ? error.message : String(error)); freshness.textContent = 'No viewable build'; setControlsEnabled(false);
    } finally {
      if (loadAbort === requestAbort) {
        loadAbort = pendingModel = null;
        for (const b of modelButtons) b.disabled = mapFailed;
        updateOverlayStatus();
      }
    }
  }

  function focusRegion(model: ModelId): void {
    const bounds = MODEL_OPTIONS.find(c => c.modelId === model)?.bounds;
    if (bounds && bounds[2] - bounds[0] < 360) map.fitBounds([[bounds[0], bounds[1]], [bounds[0] <= bounds[2] ? bounds[2] : bounds[2] + 360, bounds[3]]], { padding: 32, duration: 0 });
  }

  function showPoint(context: PointSeriesContext, payload: PointSeries, totalFrames: number, loading: boolean): void {
    if (!windgram) return;
    updatePointSeries = windgram.renderPointWindgram(pointBody, payload, context.build, {
      point: context.point, frameId: pointSeries.frameId, mapFrameId: displayedPointFrame(), mapOffsetMinutes, unitSystem: pointUnitSystem, totalFrames, loading,
      onFrame(id) {
        if (build !== context.build || !ensureLive() || !pointSeries.selectFrame(context, id)) return;
        compactTimeline.pause();
        const index = renderedFrames(context.build.manifest).findIndex(f => f.id === id);
        if (index >= 0) selectIndex(index, 'push'); else updatePointSelection();
      }
    });
    pointBody.tabIndex = 0; pointCard.ariaBusy = String(loading);
    if (!loading) setPointStatus();
  }

  async function openPoint(point: GeoPoint): Promise<void> {
    if (!build || expired || mapFailed || !ensureLive()) return;
    pointSeries.open(build, point);
    pointCard.hidden = false; pointSettings.open = pointBuildDetails.open = false;
    pointLocation.textContent = `${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°`;
    updatePointWind(); meta.replaceChildren(); windgram?.disposePointWindgram(pointBody);
    pointBody.replaceChildren(); updatePointSeries = pointSelection = null; pointBody.tabIndex = -1;
    await loadPointRange();
  }

  async function loadPointRange(): Promise<void> {
    const context = pointSeries.current;
    if (!context || build !== context.build || !ensureLive()) return;
    await pointSeries.load(pointHorizon, selectedFrame, {
      canRender: () => build === context.build && ensureLive(),
      prepare: windgram ? undefined : async () => { windgram = await import('@av/windgram'); },
      onLoading() { pointCard.ariaBusy = 'true'; setPointStatus('Loading forecast…'); updatePointWind(); },
      onProgress(payload, totalFrames, loading) { showPoint(context, payload, totalFrames, loading); },
      onError(detail) {
        updatePointSeries?.(pointSeries.frameId, pointUnitSystem, displayedPointFrame(), false);
        pointCard.ariaBusy = 'false'; setPointStatus(pointBody.children.length ? detail : `Forecast unavailable. ${detail}`);
      }
    });
  }

  async function applyHistory(): Promise<void> {
    if (lifecycle.signal.aborted) return;
    const state = previewQuery(window.location.search, offlineFixture), change = ++historyRevision;
    applyingHistory = change;
    try {
      reference = state.reference; customLayer = visibleCustomLayer(state.layer);
      syncLayerPicker(); syncReference();
      const nextUnits: UnitSystem = state.units ?? 'metric';
      if (nextUnits !== pointUnitSystem) setUnits(nextUnits);
      windVisibleOverride = state.windVisible;
      const nextVisible = state.windVisible ?? (windControls.preferredVisible?.() ?? true), nextStyle = state.windStyle ?? 'trails', nextHeight = state.windHeight ?? 'surface';
      lastControlVisible = nextVisible;
      if (nextVisible !== windControls.state.visible || nextStyle !== windControls.state.style || nextHeight !== windControls.state.height) {
        windControls.setState?.({ visible: nextVisible, style: nextStyle, height: nextHeight });
        syncWindReservation();
        windOverlay.setOptions({ ...windControls.state, units: pointUnitSystem });
        if (windDisplayed && windHeight !== windControls.state.height) setWindField('replace');
      }
      if (state.opacity !== null) {
        opacity = state.opacity; opacityInput.value = String(opacity);
        opacityReadout.textContent = `${Math.round(opacity * 100)}%`; overlay.setOpacity(opacity);
      }
      if (state.camera) map.jumpTo(state.camera, { previewHistory: true });
      requestedTime = state.validTime;
      if (state.model && state.model !== currentModel) { await loadModel(state.model); return; }
      if (currentModel === AUTO_MODEL_ID) { await loadAuto(); return; }
      if (build) {
        const previousFrame = selectedFrame;
        chooseFrame(build);
        if (selectedFrame !== previousFrame) { compactTimeline.pause(); followMapFrame(); }
        updateTimeUi(); updateOverlay();
      }
    } finally { if (applyingHistory === change) applyingHistory = null; }
  }

  for (const button of modelButtons) {
    button.addEventListener('click', () => {
      if (button.disabled || mapFailed) return;
      if (currentModel === AUTO_MODEL_ID) applyingHistory = null;
      modelPicker.open = false; void loadModel(button.value as ModelId); focusRegion(button.value as ModelId);
    });
  }
  for (const [control, layer, nextRef] of [[refAgl, 'usable-lift-agl', 'agl'], [refMsl, 'usable-lift-msl', 'msl']] as const) {
    const prepare = () => { if (!control.disabled && selectedFrame) overlay.prepare(layer, selectedFrame); };
    for (const ev of ['pointerenter', 'focus', 'pointerdown']) control.addEventListener(ev, prepare);
    control.addEventListener('click', () => {
      reference = nextRef; customLayer = null;
      syncLayerPicker(); syncReference(); updateOverlay(); writeUrl('push');
      if (currentModel === AUTO_MODEL_ID) void loadAuto();
    });
  }
  opacityInput.addEventListener('pointerdown', () => { opacityCommitted = false; });
  opacityInput.addEventListener('input', () => {
    opacity = Math.min(1, Math.max(0, Number(opacityInput.value)));
    store('preview-lift-opacity', String(opacity));
    opacityReadout.textContent = `${Math.round(opacity * 100)}%`; overlay.setOpacity(opacity);
    writeUrl(opacityCommitted ? 'replace' : 'push'); opacityCommitted = true;
  });
  opacityInput.addEventListener('change', () => { opacityCommitted = false; });
  timeInput.addEventListener('input', () => { compactTimeline.pause(); selectIndex(Number(timeInput.value), 'none'); });
  timeInput.addEventListener('change', () => { writeUrl('replace'); if (currentModel === AUTO_MODEL_ID) void loadAuto(); });
  setUnits(pointUnitSystem);
  metricButton.addEventListener('click', () => setUnits('metric', true));
  imperialButton.addEventListener('click', () => setUnits('imperial', true));

  const positionLocationMarker = (): void => {
    if (!locationMarker || !locationPoint) return;
    const p = map.project(locationPoint); locationMarker.style.left = `${p.x}px`; locationMarker.style.top = `${p.y}px`;
  };
  const clearLocationMarker = (): void => {
    if (locationTimer !== null) clearTimeout(locationTimer);
    locationTimer = null; map.off('move', positionLocationMarker);
    locationMarker?.remove(); locationMarker = locationPoint = null;
  };

  const showLocationStatus = (message: string, detail = ''): void => {
    locationStatus.hidden = message === '';
    locationStatus.textContent = message;
    locationStatus.title = detail;
  };
  const finishLocate = (revision: number): void => {
    if (revision !== locationRevision) return;
    locateButton.disabled = false;
    locateButton.ariaBusy = 'false';
  };
  const locateMessage = (error: GeolocationPositionError): string =>
    error.code === 1 ? 'Location permission denied' : error.code === 3 ? 'Location timed out' : 'Location unavailable';

  locateButton.addEventListener('click', () => {
    if (locateButton.disabled || mapFailed) return;
    const revision = ++locationRevision;
    if (!navigator.geolocation) { showLocationStatus('Location unavailable'); return; }
    locateButton.disabled = true; locateButton.ariaBusy = 'true'; showLocationStatus('Locating…');
    // Chrome often reports position-unavailable for the request that showed the Allow prompt, then succeeds on the next precise request. A third try uses the network provider.
    const accuracies = [true, true, false];
    const requestLocate = (attempt: number): void => {
      try {
        navigator.geolocation.getCurrentPosition(position => {
          if (revision !== locationRevision || lifecycle.signal.aborted) return;
          finishLocate(revision);
          showLocationStatus('');
          clearLocationMarker();
          const point: [number, number] = [position.coords.longitude, position.coords.latitude];
          map.jumpTo({ center: point, zoom: Math.max(map.getZoom(), 10) });
          const dot = Object.assign(document.createElement('div'), { className: 'location-pulse' });
          dot.setAttribute('aria-hidden', 'true'); locationMarker = dot; locationPoint = point;
          element('map').append(dot); positionLocationMarker(); map.on('move', positionLocationMarker);
          locationTimer = setTimeout(clearLocationMarker, 2000);
        }, error => {
          if (revision !== locationRevision || lifecycle.signal.aborted) return;
          if (error.code === 2 && attempt < accuracies.length - 1) { requestLocate(attempt + 1); return; }
          finishLocate(revision);
          showLocationStatus(locateMessage(error), error.message);
        }, { enableHighAccuracy: accuracies[attempt] ?? false, maximumAge: 300_000, timeout: 10_000 });
      } catch {
        finishLocate(revision);
        showLocationStatus('Location unavailable');
      }
    };
    requestLocate(0);
  });

  function displayDiagnostic(label: string, value: string): string {
    if (label === 'Cycle' || label === 'Expires') {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? formatViewerTime(ms, browserTimeZone()) : value;
    }
    if (label === 'Horizon') {
      const [start, end] = value.split(' → ');
      const a = Date.parse(start ?? ''), b = Date.parse(end ?? ''), lon = pointSeries.current?.point.lon;
      if (!Number.isFinite(a) || !Number.isFinite(b) || lon === undefined || !Number.isFinite(lon)) return value;
      const offset = longitudeOffsetHours(lon) * 60;
      return `${formatPlaceTime(a, offset, 'stamp')} → ${formatPlaceTime(b, offset, 'stamp')}`;
    }
    return value;
  }

  pointHorizonSelect.value = pointHorizon;
  pointHorizonSelect.addEventListener('change', () => { pointHorizon = pointHorizonSelect.value === 'forecast' ? 'forecast' : 'day'; void loadPointRange(); });
  pointClose.addEventListener('click', closePoint);
  pointBuildDetails.addEventListener('toggle', () => {
    if (pointBuildDetails.open && build && pointSeries.current && !meta.children.length) renderBuildDiagnostics(meta, build, displayDiagnostic);
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement | null)?.matches?.('input,select,textarea,button')) return;
    if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !build || !ensureLive()) return;
    event.preventDefault();
    const frames = renderedFrames(build.manifest), index = frames.findIndex(f => f.id === selectedFrame);
    compactTimeline.pause();
    selectIndex(Math.max(0, Math.min(frames.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))), 'replace');
  }, globalListener);

  const pointControls = [pointCard, refAgl, refMsl, layerPicker, timeInput, element('wind-controls'), element('compact-timeline'), element('display-units')];
  document.addEventListener('pointerdown', event => {
    if (!pointSeries.current) return;
    const target = event.target;
    if (!(target instanceof Node) || map.getContainer().contains(target) || pointControls.some(c => c.contains(target))) return;
    closePoint();
  }, globalListener);

  map.on('click', event => { if (!mapFailed) void openPoint(normalizePoint(event.lngLat.lat, event.lngLat.lng)); });
  map.on('move', syncMapClock);
  map.on('movestart', event => { cancelFill(); if (currentModel === AUTO_MODEL_ID && !('previewHistory' in event)) { applyingHistory = null; autoAbort?.abort(); } });
  map.on('moveend', () => {
    syncMapClock();
    updateScale();
    if (currentModel !== AUTO_MODEL_ID) updateWind();
    if (build && !expired) updateTimeUi();
    if (currentModel === AUTO_MODEL_ID && !applyingHistory) void loadAuto();
    if (urlReady && !applyingHistory) writeUrl('push');
    refreshSeam();
  });

  const teardownAll = () => {
    windOverlay.destroy(); windControls.destroy(); compactTimeline.destroy();
    seam.destroy(); overlay.destroy(); windScheduler.dispose(); rasterScheduler.dispose(); map.remove();
  };

  map.on('error', (event: { error?: unknown }) => {
    if (mapFailed || !(event.error instanceof maplibregl.GPUInitializationError)) return;
    mapFailed = true; lifecycle.abort(); autoAbort?.abort(); loadAbort?.abort(); loadAbort = pendingModel = resumeModel = null;
    closePoint(); disposeExpiry(); windCache.clear(); clearWind(); locationRevision++; clearLocationMarker();
    locateButton.disabled = false; locateButton.ariaBusy = 'false'; showLocationStatus('');
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    teardownAll(); showMapFailure(event.error);
  });

  window.addEventListener('popstate', applyHistory, globalListener);
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    windCache.clear(); clearWind(); locationRevision++; clearLocationMarker();
    locateButton.disabled = false; locateButton.ariaBusy = 'false'; showLocationStatus('');
    resumeModel = event.persisted ? (pendingModel ?? (currentModel === AUTO_MODEL_ID ? AUTO_MODEL_ID : null)) : null;
    loadAbort?.abort(); autoAbort?.abort();
    const pointInterrupted = event.persisted && pointSeries.pending;
    if (pointInterrupted) {
      pointCard.hidden = false; pointCard.ariaBusy = 'false';
      setPointStatus('Point request interrupted. Click the map again.');
      windgram?.disposePointWindgram(pointBody); updatePointSeries = pointSelection = null;
    }
    if (!event.persisted || pointInterrupted) pointSeries.close();
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    overlay.clear(true);
    if (event.persisted) return;
    lifecycle.abort(); windgram?.disposePointWindgram(pointBody); updatePointSeries = pointSelection = null;
    disposeExpiry(); teardownAll();
  }, globalListener);

  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    if (resumeModel !== null) { const m = resumeModel; resumeModel = null; void loadModel(m); return; }
    if (build && ensureLive()) {
      updateTimeUi(); updateOverlay(); refreshSeam(); setControlsEnabled(true); updateFreshness();
      if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
    }
  }, globalListener);

  document.addEventListener('visibilitychange', updateFreshness, globalListener);
  window.addEventListener('focus', updateFreshness, globalListener);
  syncReference(); syncModels();

  map.once('style.load', () => {
    if (lifecycle.signal.aborted || mapFailed) return;
    if (!startup.camera) focusRegion(currentModel);
    mapReady = true; seam.markReady(); updateOverlay(); refreshSeam(); writeUrl('replace');
  });
  void loadModel(initialModel);
}

function showMapFailure(error: unknown): void {
  for (const b of modelButtons) b.disabled = true;
  for (const c of [refAgl, refMsl, opacityInput, timeInput]) c.disabled = true;
  errorBox.hidden = false;
  errorBox.textContent = error instanceof maplibregl.GPUInitializationError
    ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
    : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`;
  timestamp.textContent = 'Map unavailable'; freshness.textContent = '';
}

function bootstrap(): void {
  const lifecycle = new AbortController();
  try { startPreview(lifecycle); } catch (error) { lifecycle.abort(); showMapFailure(error); }
}

bootstrap();
