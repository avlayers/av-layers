import type { LayerId } from '@av/contracts/layers';
import { renderedLayers } from '@av/contracts/layers';
import type { PinnedBuild } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import type { ModelId } from '@av/contracts/publication';
import type { AltitudeReference } from '../navigation/url-state';
import { frameIndexFor } from '../timeline/timeline-model';
import { isLiftLayer, layerRecord, liftLayerFor } from '../../layers/registry';

export const LIFT_LAYERS: readonly LayerId[] = [liftLayerFor('agl'), liftLayerFor('msl')];

export interface LayerOption { readonly id: 'lift' | LayerId; readonly label: string }

export const visibleCustomLayer = (layer: LayerId | null): LayerId | null =>
  layer && !layerRecord(layer).hidden ? layer : null;

export const restoredCustomLayer = (build: PinnedBuild | null, requested: LayerId | null, changingModel: boolean): LayerId | null =>
  changingModel ? requested : validatedCustomLayer(build, requested);

export const resumeModelFor = (pending: ModelId | null, requested: ModelId): ModelId | null =>
  pending ?? (requested === 'auto' ? requested : null);

export const validatedCustomLayer = (build: PinnedBuild | null, requested: LayerId | null): LayerId | null =>
  requested && build && !build.templates[requested] ? null : requested;

export const shortLayerName = (layer: LayerId, descriptor?: { label: string }): string =>
  layerRecord(layer).shortName ?? (descriptor?.label ?? layer).replace(/\s*\(.*\)$/, '');

const liftLayers = (build: PinnedBuild): LayerId[] => LIFT_LAYERS.filter(layer => build.templates[layer]);

const nonLiftLayers = (build: PinnedBuild): LayerId[] =>
  renderedLayers(build.manifest.layers, build.manifest.descriptors.layers)
    .filter(layer => build.templates[layer] && !isLiftLayer(layer) && !layerRecord(layer).hidden);

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
  const preferred = liftLayerFor(reference);
  return build.templates[preferred] ? preferred : liftLayers(build)[0] ?? nonLiftLayers(build)[0] ?? null;
}

export function committedFrame(build: PinnedBuild, requestedTime: string | null, now: number): { id: string | null; validTime: string | null } {
  const frames = renderedFrames(build.manifest), frame = frames[frameIndexFor(frames, requestedTime, now)];
  return { id: frame?.id ?? null, validTime: frame?.validTime ?? null };
}
