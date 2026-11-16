import type { LayerId } from '@av/contracts/layers';
import type { ModelId } from '@av/contracts/publication';
import type { PointHorizon, UnitSystem } from '@av/client';
import type { AltitudeReference } from '../features/navigation/url-state';
import type { WindHeight, WindStyle } from '../features/wind/wind-model';

export interface PreviewCommands {
  selectModel(model: ModelId): void;
  selectReference(reference: AltitudeReference): void;
  selectLayer(layer: 'lift' | LayerId): void;
  prepareLayer(layer: 'lift' | LayerId): void;
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
