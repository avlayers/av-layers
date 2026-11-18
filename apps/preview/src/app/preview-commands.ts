import type { LayerId } from '@av/contracts/layers';
import type { ModelId } from '@av/contracts/publication';
import type { PointHorizon, UnitSystem } from '@av/client';
import type { CloudStyleChoice, RainStyleChoice } from '../features/map/channel-styles';
import type { MapTheme } from '../features/map/visual-theme';
import type { AltitudeReference } from '../features/navigation/url-state';
import type { WindHeight, WindStyle } from '../features/wind/wind-model';

export type WeatherChannel = 'lift' | 'clouds' | 'rain' | 'isobars';

export interface PreviewCommands {
  selectModel(model: ModelId): void;
  selectReference(reference: AltitudeReference): void;
  selectLayer(layer: 'lift' | LayerId): void;
  prepareLayer(layer: 'lift' | LayerId): void;
  prepareWeatherChannel(channel: WeatherChannel): void;
  setTheme(theme: MapTheme): void;
  setCloudStyle(style: CloudStyleChoice): void;
  setRainStyle(style: RainStyleChoice): void;
  toggleWeatherLayer(channel: WeatherChannel): void;
  setPeeking(peeking: boolean): void;
  setOpacity(value: number): void;
  beginOpacityGesture(): void;
  resetOpacityGesture(): void;
  setUnits(units: UnitSystem): void;
  setWind(state: { style: WindStyle; visible: boolean; paused: boolean; height: WindHeight }): void;
  setPointHorizon(horizon: PointHorizon): void;
  selectFrame(index: number, history: 'none' | 'push' | 'replace'): void;
  setPlaying(playing: boolean): void;
  locate(): void;
  closePoint(): void;
  refreshPointDiagnostics(): void;
}
