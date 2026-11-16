import type { LayerId } from '@av/contracts/layers';
import { renderedLayers } from '@av/contracts/layers';
import type { PinnedBuild } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import type { AltitudeReference } from '../navigation/url-state';
import { frameIndexFor } from '../timeline/timeline-model';

export const LIFT_LAYERS: readonly LayerId[] = ['usable-lift-agl', 'usable-lift-msl'];
export const HIDDEN_PREVIEW_LAYERS: ReadonlySet<LayerId> = new Set(['precip-rate']);

export interface LayerOption { readonly id: 'lift' | LayerId; readonly label: string }

export const isLiftLayer = (layer: LayerId): boolean => layer === 'usable-lift-agl' || layer === 'usable-lift-msl';

export const visibleCustomLayer = (layer: LayerId | null): LayerId | null =>
  layer && !HIDDEN_PREVIEW_LAYERS.has(layer) ? layer : null;

export const shortLayerName = (layer: LayerId, descriptor?: { label: string }): string =>
  layer.startsWith('cloud') ? 'Cloud' : (descriptor?.label ?? layer).replace(/\s*\(.*\)$/, '');

export const liftLayers = (build: PinnedBuild): LayerId[] => LIFT_LAYERS.filter(layer => build.templates[layer]);

export const nonLiftLayers = (build: PinnedBuild): LayerId[] =>
  renderedLayers(build.manifest.layers, build.manifest.descriptors.layers)
    .filter(layer => build.templates[layer] && !isLiftLayer(layer) && !HIDDEN_PREVIEW_LAYERS.has(layer));

export function layerOptions(build: PinnedBuild | null): readonly LayerOption[] {
  if (!build) return [];
  return [
    ...(liftLayers(build).length ? [{ id: 'lift' as const, label: 'Lift' }] : []),
    ...nonLiftLayers(build).map(id => ({ id, label: shortLayerName(id, build.manifest.descriptors.layers[id]) }))
  ];
}

export function activeLayer(build: PinnedBuild | null, reference: AltitudeReference, customLayer: LayerId | null): LayerId | null {
  if (!build) return null;
  if (customLayer && build.templates[customLayer]) return customLayer;
  const preferred: LayerId = reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl';
  return build.templates[preferred] ? preferred : liftLayers(build)[0] ?? nonLiftLayers(build)[0] ?? null;
}

export function selectedFrameFor(build: PinnedBuild, requestedTime: string | null, now: number): string | null {
  const frames = renderedFrames(build.manifest);
  return frames[frameIndexFor(frames, requestedTime, now)]?.id ?? null;
}
