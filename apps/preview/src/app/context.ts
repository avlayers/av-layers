import {
  ApiClient, createForecastRequestScheduler, createPreparationBudget, PointSeriesController, type PinnedBuild
} from '@av/client';
import { WindDataCache } from '@av/client/wind';
import type { MapChannel } from '../channels/channel';
import { activeLayer } from '../features/forecast/forecast-model';
import type { createForecastSession } from '../features/forecast/forecast-session';
import type { createLocationController } from '../features/location/location-controller';
import type { CoverageSeam } from '../features/map/coverage-seam';
import type { MapCamera, maplibregl } from '../features/map/map-controller';
import { createHistoryController } from '../features/navigation/history-controller';
import { preparationBudgetBytes, WIND_CACHE_CAPACITY_BYTES } from '../features/raster/raster-budget';
import type { RasterOverlay } from '../features/raster/raster-overlay';
import type { SkyComposite } from '../features/sky/sky-composite';
import type { CompactTimeline } from '../features/timeline/timeline-controller';
import { createPreviewStore } from '../stores/app-store';
import type { PointWiring } from './point-wiring';
import { apiBaseUrl, createStartup, offlineFixture, safeStorage } from './startup';
import type { WindWiring } from './wind-wiring';

/** Request scheduling, memory budget, API and caches: everything the app builds before the map. */
function createServices() {
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
  return {
    preparationBudget, requestLimits, forecastScheduler, api,
    pointSeries: new PointSeriesController(api),
    windCache: new WindDataCache(WIND_CACHE_CAPACITY_BYTES, 4096, preparationBudget)
  };
}

/** The parts created on `start`, once the map exists; null before start and after disposal. */
interface LiveParts {
  map: maplibregl.Map | null;
  camera: MapCamera | null;
  overlay: RasterOverlay | null;
  sky: SkyComposite | null;
  seam: CoverageSeam | null;
  wind: WindWiring | null;
  point: PointWiring | null;
  timeline: CompactTimeline | null;
  locationController: ReturnType<typeof createLocationController> | null;
  channels: MapChannel[];
}

/**
 * Shared state of one preview app. The wiring modules in this folder each take the context and
 * the shared `ops` table, and call each other only through `ops`, so none of them owns another.
 */
export function createPreviewContext() {
  const startup = createStartup(window.location.search, safeStorage());
  const store = createPreviewStore(startup.initial);
  const { view } = store;
  const history = createHistoryController({
    pathname: () => window.location.pathname,
    search: () => window.location.search,
    push: url => window.history.pushState(null, '', url),
    replace: url => window.history.replaceState(null, '', url)
  }, offlineFixture);
  const services = createServices();
  startup.preferences.setUnits(view.intent.value.units);
  const live: LiveParts = {
    map: null, camera: null, overlay: null, sky: null, seam: null,
    wind: null, point: null, timeline: null, locationController: null, channels: []
  };
  const state = {
    admissionEpoch: 0, rasterPending: false, windPending: false,
    lastTimelineLat: Number.NaN, lastTimelineLng: Number.NaN,
    urlReady: false, selectingOverlay: false, destroyed: false
  };
  const lifecycle = new AbortController();
  const intent = () => view.intent.value;
  const forecast = () => view.forecast.value;
  const build = (): PinnedBuild | null => forecast().build;
  return {
    startup, store, history, services, live, state, lifecycle,
    /** Set once by `createForecastWiring`, before anything can call it. */
    forecastSession: null as unknown as ReturnType<typeof createForecastSession>,
    intent, forecast, build,
    selectedFrame: () => forecast().selectedFrame,
    mapFailed: () => forecast().mapFailed,
    aborted: () => lifecycle.signal.aborted,
    layer: () => activeLayer(build(), intent().reference, intent().customLayer)
  };
}
export type PreviewContext = ReturnType<typeof createPreviewContext>;
