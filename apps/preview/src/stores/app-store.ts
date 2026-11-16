import { signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { LayerId } from '@av/contracts/layers';
import type { ModelId } from '@av/contracts/publication';
import type { PinnedBuild, PointHorizon, UnitSystem } from '@av/client';
import type { AltitudeReference } from '../features/navigation/url-state';
import type { OverlayState } from '../features/raster/raster-overlay';
import type { WindHeight, WindStatus, WindStyle } from '../features/wind/wind-model';
import type { LayerOption } from '../features/forecast/forecast-model';

export interface PreviewIntent {
  readonly model: ModelId;
  readonly reference: AltitudeReference;
  readonly customLayer: LayerId | null;
  readonly opacity: number;
  readonly units: UnitSystem;
  readonly windStyle: WindStyle;
  readonly windVisible: boolean;
  readonly windVisibleOverride: boolean | null;
  readonly windPaused: boolean;
  readonly windHeight: WindHeight;
  readonly fixedWindHeight: number;
  readonly pointHorizon: PointHorizon;
  readonly requestedTime: string | null;
}

export interface ForecastView {
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

export interface WindView {
  readonly status: WindStatus;
  readonly overview: boolean;
  readonly displayed: boolean;
  readonly supported: boolean;
}

export interface PointView {
  readonly open: boolean;
  readonly location: string;
  readonly horizonSelectable: boolean;
  readonly horizonLabel: string;
  readonly busy: boolean;
  readonly status: string;
  readonly wind: string;
}

export interface LocationView {
  readonly message: string;
  readonly detail: string;
  readonly busy: boolean;
}

export interface NoticeView {
  readonly error: string;
  readonly tileError: string;
  readonly horizon: string;
  readonly freshness: string;
  readonly frameStatus: string;
  readonly overviewReady: number;
  readonly overviewTotal: number;
  readonly overviewFailed: number;
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

export interface PreviewInitialState {
  readonly intent: PreviewIntent;
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

/**
 * The preview's only application UI state boundary. Importing this module has
 * no browser side effects; `createPreviewStore` returns an independent instance.
 */
export function createPreviewStore(initial: PreviewInitialState): PreviewStore {
  const [intent, intentView] = signalOf(initial.intent);
  const [forecast, forecastView] = signalOf(initial.forecast);
  const [overlay, overlayView] = signalOf(initial.overlay);
  const [wind, windView] = signalOf(initial.wind);
  const [point, pointView] = signalOf(initial.point);
  const [location, locationView] = signalOf(initial.location);
  const [notices, noticesView] = signalOf(initial.notices);

  const writer: PreviewWriter = {
    intent(update) { intent.value = Object.freeze({ ...intent.value, ...update }); },
    forecast(update) { forecast.value = Object.freeze({ ...forecast.value, ...update }); },
    overlay(update) { overlay.value = update; },
    wind(update) { wind.value = Object.freeze({ ...wind.value, ...update }); },
    point(update) { point.value = Object.freeze({ ...point.value, ...update }); },
    location(update) { location.value = Object.freeze({ ...location.value, ...update }); },
    notices(update) { notices.value = Object.freeze({ ...notices.value, ...update }); }
  };

  return {
    view: { intent: intentView, forecast: forecastView, overlay: overlayView, wind: windView, point: pointView, location: locationView, notices: noticesView },
    writer
  };
}
