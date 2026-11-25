import { signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { LayerId } from '@av/contracts/layers';
import type { ModelId } from '@av/contracts/publication';
import type { PinnedBuild, PointHorizon, UnitSystem } from '@av/client';
import type { PointViewMode } from '@av/windgram';
import { DEFAULT_DOCK_VIEW, type DockViewId } from '../features/controls/bottom-dock-model';
import type { AltitudeReference } from '../layers/registry';
import { DEFAULT_THEME, type MapTheme } from '../themes/registry';
import type { OverlayState } from '../features/raster/raster-overlay';
import type { WindHeight, WindStatus, WindStyle } from '../features/wind/wind-model';
import type { LayerOption } from '../features/forecast/forecast-model';

export interface PreviewIntent {
  readonly model: ModelId;
  readonly reference: AltitudeReference;
  readonly customLayer: LayerId | null;
  readonly opacity: number;
  readonly units: UnitSystem;
  readonly theme: MapTheme;
  readonly dockView: DockViewId;
  readonly liftVisible: boolean;
  readonly cloudsVisible: boolean;
  readonly rainVisible: boolean;
  readonly isobarsVisible: boolean;
  readonly peeking: boolean;
  readonly windStyle: WindStyle;
  readonly windVisible: boolean;
  readonly windVisibleOverride: boolean | null;
  readonly windPaused: boolean;
  readonly windHeight: WindHeight;
  readonly fixedWindHeight: number;
  readonly pointHorizon: PointHorizon;
  readonly pointViewMode: PointViewMode;
  readonly requestedTime: string | null;
}

type CompositeIntentDefaults = Pick<PreviewIntent, 'theme' | 'dockView' | 'liftVisible' | 'cloudsVisible' | 'rainVisible' | 'isobarsVisible' | 'peeking' | 'pointViewMode'>;
type PreviewInitialIntent = Omit<PreviewIntent, keyof CompositeIntentDefaults> & Partial<CompositeIntentDefaults>;

interface ForecastView {
  readonly build: PinnedBuild | null;
  readonly selectedFrame: string | null;
  readonly pendingModel: ModelId | null;
  readonly expired: boolean;
  readonly mapReady: boolean;
  readonly mapFailed: boolean;
  readonly layers: readonly LayerOption[];
  readonly offsetMinutes: number;
  readonly mapCenter: { readonly lat: number; readonly lng: number } | null;
  readonly playing: boolean;
}

interface WindView {
  readonly status: WindStatus;
  readonly overview: boolean;
  readonly displayed: boolean;
  readonly supported: boolean;
}

interface PointView {
  readonly open: boolean;
  readonly location: string;
  readonly detailLocation?: string;
  readonly horizonSelectable: boolean;
  readonly horizonLabel: string;
  readonly busy: boolean;
  readonly status: string;
  readonly wind: string;
}

interface LocationView {
  readonly message: string;
  readonly detail: string;
  readonly busy: boolean;
}

interface NoticeView {
  readonly error: string;
  readonly tileError: string;
  readonly horizon: string;
  readonly freshness: string;
  readonly frameStatus: string;
  /** Sky channels not drawing the selected hour; empty when every visible one is. */
  readonly skyStatus: string;
  readonly overviewReady: number;
  readonly overviewTotal: number;
  readonly overviewFailed: number;
  readonly detailReady: number;
  readonly preparationLimited: boolean;
  readonly scaleWidth: number;
  readonly scaleText: string;
}

export interface PreviewStore {
  readonly view: {
    readonly intent: ReadonlySignal<PreviewIntent>;
    readonly forecast: ReadonlySignal<ForecastView>;
    readonly overlay: ReadonlySignal<OverlayState>;
    readonly wind: ReadonlySignal<WindView>;
    readonly point: ReadonlySignal<PointView>;
    readonly location: ReadonlySignal<LocationView>;
    readonly notices: ReadonlySignal<NoticeView>;
  };
  readonly writer: PreviewWriter;
}

export interface PreviewWriter {
  intent(update: Partial<PreviewIntent>): void;
  forecast(update: Partial<ForecastView>): void;
  overlay(update: OverlayState): void;
  wind(update: Partial<WindView>): void;
  point(update: Partial<PointView>): void;
  location(update: Partial<LocationView>): void;
  notices(update: Partial<NoticeView>): void;
}

export function preparedAxisReadiness(
  frames: readonly { id: string }[], previews: ReadonlySet<string>, details: ReadonlySet<string>, wind: ReadonlySet<string> | null
): Pick<NoticeView, 'overviewReady' | 'overviewTotal' | 'detailReady'> {
  let overviewReady = 0, detailReady = 0;
  for (const { id } of frames) {
    const native = details.has(id);
    if (native) detailReady++;
    if ((native || previews.has(id)) && (wind === null || wind.has(id))) overviewReady++;
  }
  return { overviewReady, overviewTotal: frames.length, detailReady };
}

export interface PreviewInitialState {
  readonly intent: PreviewInitialIntent;
  readonly forecast: ForecastView;
  readonly overlay: OverlayState;
  readonly wind: WindView;
  readonly point: PointView;
  readonly location: LocationView;
  readonly notices: NoticeView;
}

export const emptyOverlay: OverlayState = {
  displayed: null, requested: null, quality: null, viewLoading: false,
  overviewReady: 0, overviewTotal: 0, overviewFailed: 0, incomplete: false, replacementFailed: false
};

function signalOf<T>(initial: T): [Signal<T>, ReadonlySignal<T>] {
  const source = signal(initial);
  return [source, source as ReadonlySignal<T>];
}

function applyPatch<T extends object>(target: Signal<T>, update: Partial<T>): void {
  const current = target.value;
  let changed = false;
  for (const key of Object.keys(update) as Array<keyof T>) {
    if (!Object.is(current[key], update[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  target.value = Object.freeze({ ...current, ...update });
}

/**
 * The preview's only application UI state boundary. Importing this module has
 * no browser side effects; `createPreviewStore` returns an independent instance.
 */
export function createPreviewStore(initial: PreviewInitialState): PreviewStore {
  const normalizedIntent: PreviewIntent = Object.freeze({
    theme: DEFAULT_THEME,
    dockView: DEFAULT_DOCK_VIEW,
    liftVisible: true,
    cloudsVisible: true,
    rainVisible: true,
    isobarsVisible: false,
    peeking: false,
    pointViewMode: '3d',
    ...initial.intent
  });
  const [intent, intentView] = signalOf(normalizedIntent);
  const [forecast, forecastView] = signalOf(initial.forecast);
  const [overlay, overlayView] = signalOf(initial.overlay);
  const [wind, windView] = signalOf(initial.wind);
  const [point, pointView] = signalOf(initial.point);
  const [location, locationView] = signalOf(initial.location);
  const [notices, noticesView] = signalOf(initial.notices);

  const writer: PreviewWriter = {
    intent(update) { applyPatch(intent, update); },
    forecast(update) { applyPatch(forecast, update); },
    overlay(update) { if (overlay.value !== update) overlay.value = update; },
    wind(update) { applyPatch(wind, update); },
    point(update) { applyPatch(point, update); },
    location(update) { applyPatch(location, update); },
    notices(update) { applyPatch(notices, update); }
  };

  return {
    view: { intent: intentView, forecast: forecastView, overlay: overlayView, wind: windView, point: pointView, location: locationView, notices: noticesView },
    writer
  };
}
