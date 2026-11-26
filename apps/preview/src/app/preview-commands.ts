import type { LayerId } from '@av/contracts/layers';
import type { ModelId } from '@av/contracts/publication';
import type { PointHorizon, UnitSystem } from '@av/client';
import type { PointViewMode } from '@av/windgram';
import type { DockViewId } from '../features/controls/bottom-dock-model';
import type { WeatherChannelKey } from '../layers/channels';
import type { MapTheme } from '../themes/registry';
import type { AltitudeReference } from '../layers/registry';
import type { WindHeight, WindStyle } from '../features/wind/wind-model';

type WeatherChannel = WeatherChannelKey;

export interface PreviewCommands {
  selectModel(model: ModelId): void;
  /** Adopts the newer run the catalog advertises. */
  updateRun(): void;
  /** Opens the point forecast at the map center (the keyboard route to a point) and focuses it. */
  forecastAtCenter(): void;
  selectReference(reference: AltitudeReference): void;
  selectLayer(layer: 'lift' | LayerId): void;
  prepareLayer(layer: 'lift' | LayerId): void;
  prepareWeatherChannel(channel: WeatherChannel): void;
  setTheme(theme: MapTheme): void;
  setDockView(dockView: DockViewId): void;
  toggleWeatherLayer(channel: WeatherChannel): void;
  setPeeking(peeking: boolean): void;
  setOpacity(value: number): void;
  beginOpacityGesture(): void;
  resetOpacityGesture(): void;
  setUnits(units: UnitSystem): void;
  setWind(state: { style: WindStyle; visible: boolean; paused: boolean; height: WindHeight }): void;
  setPointHorizon(horizon: PointHorizon): void;
  setPointViewMode?(mode: PointViewMode): void;
  selectFrame(index: number, history: 'none' | 'push' | 'replace'): void;
  locate(): void;
  closePoint(): void;
  refreshPointDiagnostics(): void;
}
