import { AUTO_MODEL_ID, longitudeOffsetHours, type UnitSystem } from '@av/client';
import type { PointViewMode } from '@av/windgram';
import type { ModelId } from '@av/contracts/publication';
import { DEFAULT_DOCK_VIEW, isDockViewId, type DockViewId } from '../features/controls/bottom-dock-model';
import { isCloudStyleId, isRainStyleId, type CloudStyleChoice, type RainStyleChoice } from '../features/map/channel-styles';
import { isMapTheme, type MapTheme } from '../features/map/visual-theme';
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
import { emptyOverlay, type PreviewInitialState } from '../stores/app-store';

export const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
export const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
export const fixtureModel = (import.meta.env.VITE_MODEL ?? 'gfs') as ModelId;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Preferences {
  units(): UnitSystem | null;
  opacity(): number | null;
  theme(): MapTheme | null;
  dockView(): DockViewId | null;
  pointViewMode(): PointViewMode | null;
  cloudStyle(): CloudStyleChoice | null;
  rainStyle(): RainStyleChoice | null;
  wind(): StoredWindPreferences | null;
  setUnits(units: UnitSystem): void;
  setOpacity(opacity: number): void;
  setTheme(theme: MapTheme): void;
  setDockView(dockView: DockViewId): void;
  setPointViewMode(mode: PointViewMode): void;
  setCloudStyle(style: CloudStyleChoice): void;
  setRainStyle(style: RainStyleChoice): void;
  setWind(state: WindControlState, fixedHeight: number): void;
}

export interface StartupSnapshot {
  readonly query: ReturnType<typeof previewQuery>;
  readonly preferences: Preferences;
  readonly initial: PreviewInitialState;
  readonly initialOffset: number;
  readonly browserOffsetMinutes: number;
}

/** URL, stored preferences and defaults in their established precedence. */
export function createStartup(search: string, storage: StorageLike | null, offline = offlineFixture): StartupSnapshot {
  const read = (key: string): string | null => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const write = (key: string, value: string): void => { try { storage?.setItem(key, value); } catch { /* ignore */ } };
  const preferences: Preferences = {
    units() { const value = read('preview-units'); return value === 'imperial' ? 'imperial' : value === 'metric' ? 'metric' : null; },
    opacity() { const raw = read('preview-lift-opacity'), value = raw?.trim() ? Number(raw) : Number.NaN; return value >= 0 && value <= 1 ? value : null; },
    theme() { const value = read('preview-theme'); return isMapTheme(value) ? value : null; },
    dockView() { const value = read('preview-dock-view'); return isDockViewId(value) ? value : null; },
    pointViewMode() { const value = read('preview-point-view'); return value === '3d' ? '3d' : value === '1d' ? '1d' : null; },
    cloudStyle() { const value = read('preview-cloud-style'); return value === 'auto' || isCloudStyleId(value) ? value : null; },
    rainStyle() { const value = read('preview-rain-style'); return value === 'auto' || isRainStyleId(value) ? value : null; },
    wind() { return parseWindPreferences(read(WIND_STORAGE_KEY)); },
    setUnits(units) { write('preview-units', units); },
    setOpacity(opacity) { write('preview-lift-opacity', String(opacity)); },
    setTheme(theme) { write('preview-theme', theme); },
    setDockView(dockView) { write('preview-dock-view', dockView); },
    setPointViewMode(mode) { write('preview-point-view', mode); },
    setCloudStyle(style) { write('preview-cloud-style', style); },
    setRainStyle(style) { write('preview-rain-style', style); },
    setWind(state, fixedHeight) { write(WIND_STORAGE_KEY, serializeWindPreferences(state, fixedHeight)); }
  };
  const query = previewQuery(search, offline), storedWind = preferences.wind();
  const initialModel = query.model ?? (offline ? fixtureModel : AUTO_MODEL_ID);
  const initialOpacity = query.opacity ?? preferences.opacity() ?? 0.72;
  const initialUnits: UnitSystem = query.units ?? preferences.units() ?? 'metric';
  const initialTheme: MapTheme = query.theme ?? preferences.theme() ?? 'stone';
  const initialDockView: DockViewId = query.dockView ?? preferences.dockView() ?? DEFAULT_DOCK_VIEW;
  const initialPointViewMode: PointViewMode = preferences.pointViewMode() ?? '3d';
  const initialCloudStyle: CloudStyleChoice = query.cloudStyle ?? preferences.cloudStyle() ?? 'auto';
  const initialRainStyle: RainStyleChoice = query.rainStyle ?? preferences.rainStyle() ?? 'auto';
  const initialWindHeight = query.windHeight ?? storedWind?.height ?? 'surface';
  const initialFixedHeight = typeof initialWindHeight === 'number' ? initialWindHeight : storedWind?.fixedHeight ?? WIND_STOPS[0];
  const browserOffsetMinutes = -new Date().getTimezoneOffset();
  const initialOffset = query.camera && Number.isFinite(query.camera.center[1]) ? longitudeOffsetHours(query.camera.center[0]) * 60 : browserOffsetMinutes;
  const initial: PreviewInitialState = {
    intent: {
      model: initialModel, reference: query.reference, customLayer: visibleCustomLayer(query.layer), opacity: initialOpacity, units: initialUnits,
      theme: initialTheme, dockView: initialDockView, cloudStyle: initialCloudStyle, rainStyle: initialRainStyle,
      liftVisible: query.liftVisible ?? true, cloudsVisible: query.cloudsVisible ?? true, rainVisible: query.rainVisible ?? true, isobarsVisible: query.isobarsVisible ?? false, peeking: false,
      windStyle: query.windStyle ?? storedWind?.style ?? 'trails', windVisible: query.windVisible ?? storedWind?.visible ?? true,
      windVisibleOverride: query.windVisible, windPaused: false, windHeight: initialWindHeight, fixedWindHeight: initialFixedHeight,
      pointHorizon: initialPointViewMode === '3d' ? 'forecast' : 'day', pointViewMode: initialPointViewMode, requestedTime: query.validTime
    },
    forecast: {
      build: null, selectedFrame: null, pendingModel: null, expired: false, mapReady: false, mapFailed: false, layers: [],
      offsetMinutes: initialOffset, mapCenter: query.camera ? { lat: query.camera.center[1], lng: query.camera.center[0] } : null, playing: false
    },
    overlay: emptyOverlay,
    wind: { status: 'unavailable', overview: false, displayed: false, supported: false },
    point: { open: false, location: '', horizonSelectable: false, horizonLabel: '24 hours', busy: false, status: '', wind: '' },
    location: { message: '', detail: '', busy: false },
    notices: { error: '', tileError: '', horizon: '', freshness: 'Loading latest immutable build…', frameStatus: 'Loading forecast…', overviewReady: 0, overviewTotal: 0, overviewFailed: 0, detailReady: 0, preparationLimited: false, scaleWidth: 1, scaleText: '' }
  };
  return { query, preferences, initial, initialOffset, browserOffsetMinutes };
}

export function safeStorage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}
