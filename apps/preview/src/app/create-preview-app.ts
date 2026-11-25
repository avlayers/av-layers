import { AUTO_MODEL_ID, timeZoneOffsetMinutesAt } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import { createLocationController } from '../features/location/location-controller';
import { BasemapChannel } from '../features/map/basemap';
import { CoverageSeam } from '../features/map/coverage-seam';
import { createMap, createMapCamera } from '../features/map/map-controller';
import { RasterOverlay } from '../features/raster/raster-overlay';
import { SkyComposite } from '../features/sky/sky-composite';
import { createCompactTimeline } from '../features/timeline/timeline-controller';
import { installBrowserLifecycle } from '../platform/browser-lifecycle';
import type { PreviewStore } from '../stores/app-store';
import { createCommands } from './command-handlers';
import { createPreviewContext } from './context';
import { createDisplayOps, installDerivedViews, type PreviewOps } from './display-ops';
import { createForecastWiring } from './forecast-wiring';
import { installMapWiring } from './map-wiring';
import { overlayUiChanged, sameSelection } from './overlay-status';
import { createPageLifecycle } from './page-lifecycle';
import { createPointWiring } from './point-wiring';
import type { PreviewCommands } from './preview-commands';
import { installShortcuts } from './shortcuts';
import { apiBaseUrl, offlineFixture } from './startup';
import { createUrlWiring } from './url-wiring';
import { createWindWiring } from './wind-wiring';

export interface PreviewApp {
  readonly store: PreviewStore;
  readonly commands: PreviewCommands;
  start(root: HTMLElement): void;
  dispose(): void;
}

/**
 * Composition root: builds the shared context and the wiring modules, then on `start` creates
 * the map, its channels (basemap, lift raster, sky weather, wind), the timeline, the point card
 * and the shortcuts. Behaviour lives in the wiring modules; this file connects them.
 */
export function createPreviewApp(): PreviewApp {
  const ctx = createPreviewContext();
  const { store, live, state, services, startup } = ctx, { writer, view } = store;
  const ops = {} as PreviewOps;
  Object.assign(ops, createDisplayOps(ctx, ops), createUrlWiring(ctx, ops));
  ctx.forecastSession = createForecastWiring(ctx, ops);
  const commands = createCommands(ctx, ops);
  const page = createPageLifecycle(ctx, ops);

  function start(root: HTMLElement): void {
    if (live.map || state.destroyed) return;
    installDerivedViews(ctx, root, ctx.lifecycle.signal);
    const container = root.querySelector<HTMLElement>('#map');
    if (!container) throw new Error('Missing element #map');
    for (const id of ['#wind-controls', '#compact-timeline']) if (!root.querySelector(id)) throw new Error(`Missing element ${id}`);
    const map = live.map = createMap({ container, offlineFixture, camera: startup.query.camera, theme: ctx.intent().theme });
    const openedAt = map.getCenter();
    const camera = live.camera = createMapCamera(map, {
      home: { lat: openedAt.lat, lng: openedAt.lng },
      followsPlace: startup.query.camera !== null,
      browserTimeZone: startup.browserZone,
      loadZoneLookup: () => import('@av/client/timezone').then(module => module.mapClockTimeZone)
    });

    const { forecastScheduler, preparationBudget } = services;
    const wind = live.wind = createWindWiring({
      root, map, store, preferences: startup.preferences, apiBaseUrl, scheduler: forecastScheduler, cache: services.windCache, budget: preparationBudget,
      lowMemory: preparationBudget.limit <= 128 * 1024 * 1024,
      raster: () => live.overlay,
      displayedRaster: () => {
        const displayed = view.overlay.value.displayed;
        return displayed ? { build: displayed.build, frame: displayed.frame } : null;
      },
      selectedPending: pending => { state.windPending = pending; ops.syncSelectedAdmission(); },
      syncChannels: () => ops.syncChannels(), preparationChanged: () => ops.updatePreparation(), pointWindChanged: () => live.point?.feature.syncWind(),
      writeUrl: () => ops.writeUrl('replace'), destroyed: () => state.destroyed, aborted: ctx.aborted
    });
    const overlay = live.overlay = new RasterOverlay(map, apiBaseUrl, ctx.intent().opacity, next => {
      if (!overlayUiChanged(view.overlay.value, next)) return;
      const displayedChanged = !sameSelection(view.overlay.value.displayed, next.displayed);
      writer.overlay(next);
      if (displayedChanged) ops.syncSky(null);
      wind.session.reconcile();
      ops.updatePreparation();
      if (!state.selectingOverlay) live.point?.feature.syncSelection();
    }, forecastScheduler.fetch, spec => forecastScheduler.request(spec), {
      budget: preparationBudget, requestLimits: services.requestLimits, theme: ctx.intent().theme,
      protectedBytes: wind.protectedBytes,
      beforeReveal: selection => { wind.session.beforeRasterReveal(selection); ops.syncSky(selection); },
      onSelectedPending: pending => { state.rasterPending = pending; ops.syncSelectedAdmission(); }
    });
    const cur = ctx.intent();
    live.sky = new SkyComposite(map, services.api, apiBaseUrl, {
      theme: cur.theme, opacity: cur.opacity, cloudsVisible: cur.cloudsVisible, rainVisible: cur.rainVisible, isobarsVisible: cur.isobarsVisible,
      fetchImpl: forecastScheduler.fetch, request: spec => forecastScheduler.request(spec),
      onStatus: skyStatus => writer.notices({ skyStatus })
    });
    live.seam = new CoverageSeam(map);
    live.channels = [new BasemapChannel(map, ctx.intent().theme), overlay, live.sky, wind.overlay];
    ops.syncChannels();

    live.timeline = createCompactTimeline(root.querySelector<HTMLElement>('#compact-timeline')!, {
      timeZone: ctx.forecast().timeZone,
      variant: ctx.intent().dockView,
      ...(camera.followsPlace() && Number.isFinite(camera.home.lat) && Number.isFinite(camera.home.lng) ? { latitude: camera.home.lat, longitude: camera.home.lng } : {}),
      onSelect: (index, mode = 'push') => ops.selectIndex(index, mode, true),
      onIntent: index => {
        if (ctx.intent().model === AUTO_MODEL_ID) ctx.forecastSession.cancelAuto();
        ops.prepareFrameIndex(index);
      },
      onPrepare: index => ops.prepareFrameIndex(index),
      onPlayback: playing => commands.setPlaying(playing)
    });

    const point = live.point = createPointWiring({
      root, map, store, series: services.pointSeries, build: ctx.build, selectedFrame: ctx.selectedFrame,
      mapOffsetMinutes: () => {
        const frame = ctx.build()?.manifest.frames.find(item => item.id === ctx.selectedFrame());
        return timeZoneOffsetMinutesAt(frame ? Date.parse(frame.validTime) : Date.now(), ctx.forecast().timeZone);
      },
      displayedFrame: () => {
        const displayed = view.overlay.value.displayed;
        return displayed && displayed.build === ctx.build() ? displayed.frame : null;
      },
      wind: () => wind.pointWind(),
      ensureLive: () => ctx.forecastSession.ensureLive(),
      timeline: () => live.timeline,
      selectFrameById: id => {
        const cancelled = live.timeline?.cancelGesture();
        const current = ctx.build();
        const index = current ? renderedFrames(current.manifest).findIndex(frame => frame.id === id) : -1;
        if (index >= 0) { ops.selectIndex(index, 'push'); return; }
        if (cancelled?.changed) ops.writeUrl(cancelled.delivered ? 'push' : 'replace');
        if (cancelled?.changed && ctx.intent().model === AUTO_MODEL_ID) void ctx.forecastSession.loadAuto();
      },
      setViewMode: mode => commands.setPointViewMode?.(mode),
      setHorizon: horizon => commands.setPointHorizon(horizon),
      destroyed: () => state.destroyed
    });

    live.locationController = createLocationController({
      map,
      publish: {
        message: message => writer.location({ message }),
        detail: detail => writer.location({ detail }),
        busy: busy => writer.location({ busy })
      },
      isAborted: ctx.aborted,
      isMapFailed: ctx.mapFailed
    });

    const signal = ctx.lifecycle.signal;
    installShortcuts({
      root, signal, store, commands,
      point: { isOpen: point.isOpen, close: point.close, dismiss: target => point.feature.dismiss(target, map.getContainer()) },
      stepFrame: step => {
        const current = ctx.build();
        if (!current || !ctx.forecastSession.ensureLive()) return false;
        const frames = renderedFrames(current.manifest), index = frames.findIndex(frame => frame.id === ctx.selectedFrame());
        live.timeline?.pause();
        ops.selectIndex(Math.max(0, Math.min(frames.length - 1, index + step)), 'replace');
        return true;
      }
    });
    const timeInput = root.querySelector<HTMLInputElement>('#time');
    if (timeInput) {
      timeInput.addEventListener('input', () => { live.timeline?.pause(); ops.selectIndex(Number(timeInput.value), 'none'); }, { signal });
      timeInput.addEventListener('change', () => { ops.writeUrl('replace'); if (ctx.intent().model === AUTO_MODEL_ID) void ctx.forecastSession.loadAuto(); }, { signal });
    }

    installMapWiring(ctx, ops, map, point, wind, page.showMapFailure);
    installBrowserLifecycle({ document, window, signal, onVisibility: () => ops.updateFreshness(), onPageHide: page.pageHide, onPageShow: page.pageShow });
    window.addEventListener('popstate', () => { void ops.applyHistory(); }, { signal });

    wind.syncSupport(); ops.syncLayers(); ops.updateScale();
    void ctx.forecastSession.load(ctx.intent().model);
  }

  return { store, commands, start, dispose: page.disposePermanently };
}
