import { AUTO_MODEL_ID, browserTimeZone, type UnitSystem } from '@av/client';
import type { PointViewMode } from '@av/windgram';
import type { ModelId } from '@av/contracts/publication';
import { DEFAULT_DOCK_VIEW, isDockViewId, type DockViewId } from '../features/controls/bottom-dock-model';
import { DEFAULT_THEME, parseMapTheme, type MapTheme } from '../themes/registry';
import { previewQuery } from '../features/navigation/url-state';
import {
  parseWindPreferences,
  serializeWindPreferences,
  WIND_STORAGE_KEY,
  WIND_STOPS,
  type StoredWindPreferences,
  type WindControlState
} from '../features/wind/wind-model';
import { visibleCustomLayer } from '../features/forecast/forecast-model';
import { emptyOverlay, type PreviewInitialState, type PreviewIntent } from '../stores/app-store';

export const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
export const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
const fixtureModel = (import.meta.env.VITE_MODEL ?? 'gfs') as ModelId;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Preferences {
  units(): UnitSystem | null;
  opacity(): number | null;
  theme(): MapTheme | null;
  dockView(): DockViewId | null;
  pointViewMode(): PointViewMode | null;
  wind(): StoredWindPreferences | null;
  setUnits(units: UnitSystem): void;
  setOpacity(opacity: number): void;
  setTheme(theme: MapTheme): void;
  setDockView(dockView: DockViewId): void;
  setPointViewMode(mode: PointViewMode): void;
  setWind(state: WindControlState, fixedHeight: number): void;
}

type PreviewQuery = ReturnType<typeof previewQuery>;
type ResolvedDisplay = Pick<PreviewIntent, 'units' | 'opacity' | 'theme' | 'dockView' | 'liftVisible' | 'cloudsVisible'
  | 'rainVisible' | 'isobarsVisible' | 'windStyle' | 'windVisible' | 'windHeight'>;

/**
 * Display settings in their one precedence: URL value, then stored preference, then default.
 * Startup and history restore both read it, so back/forward lands where a fresh load would.
 */
export function resolveDisplay(query: PreviewQuery, preferences: Pick<Preferences, 'units' | 'opacity' | 'theme' | 'dockView' | 'wind'>): ResolvedDisplay {
  const storedWind = preferences.wind();
  return {
    units: query.units ?? preferences.units() ?? 'metric',
    opacity: query.opacity ?? preferences.opacity() ?? 0.72,
    theme: query.theme ?? preferences.theme() ?? DEFAULT_THEME,
    dockView: query.dockView ?? preferences.dockView() ?? DEFAULT_DOCK_VIEW,
    liftVisible: query.liftVisible ?? true,
    cloudsVisible: query.cloudsVisible ?? true,
    rainVisible: query.rainVisible ?? true,
    isobarsVisible: query.isobarsVisible ?? false,
    windStyle: query.windStyle ?? storedWind?.style ?? 'trails',
    windVisible: query.windVisible ?? storedWind?.visible ?? true,
    windHeight: query.windHeight ?? storedWind?.height ?? 'surface'
  };
}

interface StartupSnapshot {
  readonly query: PreviewQuery;
  readonly preferences: Preferences;
  readonly initial: PreviewInitialState;
  readonly browserZone: string;
}

/** URL, stored preferences and defaults in their established precedence. */
export function createStartup(search: string, storage: StorageLike | null, offline = offlineFixture): StartupSnapshot {
  const read = (key: string): string | null => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const write = (key: string, value: string): void => { try { storage?.setItem(key, value); } catch { /* ignore */ } };
  const preferences: Preferences = {
    units() { const value = read('preview-units'); return value === 'imperial' ? 'imperial' : value === 'metric' ? 'metric' : null; },
    opacity() { const raw = read('preview-lift-opacity'), value = raw?.trim() ? Number(raw) : Number.NaN; return value >= 0 && value <= 1 ? value : null; },
    theme() { const value = read('preview-theme'); return parseMapTheme(value); },
    dockView() { const value = read('preview-dock-view'); return isDockViewId(value) ? value : null; },
    pointViewMode() { const value = read('preview-point-view'); return value === '3d' ? '3d' : value === '1d' ? '1d' : null; },
    wind() { return parseWindPreferences(read(WIND_STORAGE_KEY)); },
    setUnits(units) { write('preview-units', units); },
    setOpacity(opacity) { write('preview-lift-opacity', String(opacity)); },
    setTheme(theme) { write('preview-theme', theme); },
    setDockView(dockView) { write('preview-dock-view', dockView); },
    setPointViewMode(mode) { write('preview-point-view', mode); },
    setWind(state, fixedHeight) { write(WIND_STORAGE_KEY, serializeWindPreferences(state, fixedHeight)); }
  };
  const query = previewQuery(search, offline), storedWind = preferences.wind(), display = resolveDisplay(query, preferences);
  const initialModel = query.model ?? (offline ? fixtureModel : AUTO_MODEL_ID);
  const initialPointViewMode: PointViewMode = preferences.pointViewMode() ?? '3d';
  const initialFixedHeight = typeof display.windHeight === 'number' ? display.windHeight : storedWind?.fixedHeight ?? WIND_STOPS[0];
  const browserZone = browserTimeZone();
  const initial: PreviewInitialState = {
    intent: {
      model: initialModel, reference: query.reference, customLayer: visibleCustomLayer(query.layer), ...display, peeking: false,
      windVisibleOverride: query.windVisible, windPaused: false, fixedWindHeight: initialFixedHeight,
      pointHorizon: initialPointViewMode === '3d' ? 'forecast' : 'day', pointViewMode: initialPointViewMode, requestedTime: query.validTime
    },
    forecast: {
      build: null, selectedFrame: null, pendingModel: null, resolving: false, expired: false, mapReady: false, mapFailed: false, layers: [],
      timeZone: browserZone, mapCenter: query.camera ? { lat: query.camera.center[1], lng: query.camera.center[0] } : null, playing: false
    },
    overlay: emptyOverlay,
    wind: { status: 'unavailable', overview: false, displayed: false, supported: false },
    point: { open: false, location: '', horizonSelectable: false, horizonLabel: '24 hours', busy: false, status: '', wind: '' },
    location: { message: '', detail: '', busy: false },
    notices: { error: '', tileError: '', horizon: '', freshness: 'Loading latest immutable build…', runAge: '', frameStatus: 'Loading forecast…', skyStatus: '', overviewReady: 0, overviewTotal: 0, overviewFailed: 0, detailReady: 0, preparationLimited: false, scaleWidth: 1, scaleText: '' }
  };
  return { query, preferences, initial, browserZone };
}

export function safeStorage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}
