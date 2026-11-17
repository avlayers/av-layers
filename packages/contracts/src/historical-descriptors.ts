import registryJson from './historical-registry.json' with { type: 'json' };
import type { ProductDefinition } from './product.js';
import { descriptorSchema } from './publication.js';
import { sameJsonValue } from './json.js';

interface FrozenLayer {
  id: string;
  methodId: string;
  surface: 'native' | 'fine';
  methodGroup?: 'soaring' | 'cloud' | 'surface' | 'wind';
  palette?: string;
  delivery?: 'samples-only';
  label: string;
  timeSupport: string;
  verticalReference: string;
}
interface FrozenMethod {
  id: string;
  inputs: Record<string, { timeSupport: string } & Record<string, unknown>>;
}
interface FrozenProduct {
  modelId: string;
  verticalCoordinate: 'isobaric' | 'model-levels';
  intervalMaximumGust: boolean;
}
interface FrozenRegistry {
  version: 1;
  maxSampleValues: number;
  renderedLayerIds: readonly string[];
  layers: Record<string, FrozenLayer>;
  methods: Record<string, FrozenMethod>;
  palettes: Record<string, { id: string }>;
  products: Record<string, FrozenProduct>;
}

const registry = registryJson as FrozenRegistry;
const LEGACY_PRECIPITATION_METHOD_ID = 'trailing-precipitation-rate-v1';
const CURRENT_PRECIPITATION_METHOD_ID = 'trailing-precipitation-rate-v2';

function nativeMethodId(group: NonNullable<FrozenLayer['methodGroup']>, coordinate: FrozenProduct['verticalCoordinate']): string {
  return `native-${group}${coordinate === 'model-levels' ? '-model-levels' : ''}-v1`;
}

function terrainMethodId(coordinate: FrozenProduct['verticalCoordinate'], cloud: boolean): string {
  const suffix = coordinate === 'model-levels' ? '-model-levels' : '';
  return `supported-terrain-column-1p2${suffix}-${cloud ? 'v2' : 'v1'}`;
}

function methodForLayer(layer: FrozenLayer, coordinate: FrozenProduct['verticalCoordinate']): FrozenMethod {
  if (layer.methodGroup) return registry.methods[nativeMethodId(layer.methodGroup, coordinate)]!;
  if (layer.methodId === 'dry-lenschow-1p2-v2') return registry.methods[coordinate === 'model-levels' ? 'dry-lenschow-1p2-model-levels-v2' : layer.methodId]!;
  return registry.methods[layer.methodId]!;
}

/** Descriptor revision published before scientific field definitions. */
export function createHistoricalWholeDomainDescriptors(product: ProductDefinition, layers: readonly string[] = product.layers) {
  const frozen = registry.products[product.id];
  if (!frozen || layers.some(id => registry.layers[id] === undefined)) return undefined;
  const coordinate = frozen.verticalCoordinate;
  const specs = layers.map(id => {
    const { surface: _surface, methodGroup: _group, ...spec } = registry.layers[id]!;
    return { ...spec, methodId: methodForLayer(registry.layers[id]!, coordinate).id };
  });
  const methods: Record<string, FrozenMethod> = Object.fromEntries(specs.map(layer => [layer.methodId, registry.methods[layer.methodId]!]));
  const gust = specs.find(layer => layer.id === 'wind-gust-10m');
  if (frozen.intervalMaximumGust && gust) {
    gust.timeSupport = 'interval-maximum';
    const method = methods[gust.methodId]!;
    methods[gust.methodId] = { ...method, inputs: { ...method.inputs, gust10mMps: { ...method.inputs.gust10mMps!, timeSupport: 'interval-maximum' } } };
  }
  const base = {
    layers: Object.fromEntries(specs.map(layer => [layer.id, layer])),
    methods,
    palettes: [...new Set(registry.renderedLayerIds.filter(id => layers.includes(id)).map(id => registry.layers[id]!.palette!))].map(id => registry.palettes[id]!),
    attribution: product.attribution,
    coverageDescription: product.coverageDescription,
    bounds: [...product.bounds],
    maxSampleValues: registry.maxSampleValues
  };
  const terrain = registry.methods[terrainMethodId(coordinate, layers.includes('thermal-velocity'))]!;
  const msl = base.layers['usable-lift-msl'], agl = base.layers['usable-lift-agl'];
  if (!msl || !agl) throw new Error('Terrain refinement requires native MSL and AGL layers');
  const lift = {
    [msl.id]: { ...msl, verticalReference: 'MSL', methodId: terrain.id },
    [agl.id]: { ...agl, label: 'Usable lift depth (terrain AGL)', verticalReference: 'terrain-AGL', methodId: terrain.id }
  };
  const selected = layers.map(id => lift[id] ?? base.layers[id]);
  return descriptorSchema.parse({ ...base,
    layers: Object.fromEntries(selected.map(layer => [layer.id, layer])),
    methods: Object.fromEntries(selected.map(layer => [layer.methodId, layer.methodId === terrain.id ? terrain : base.methods[layer.methodId]]))
  });
}

export function matchesHistoricalDescriptors(product: ProductDefinition, published: {
  layers: readonly string[];
  descriptors: { layers: Record<string, { label: string; methodId: string }>; [key: string]: unknown };
}): boolean {
  try {
    const expected = createHistoricalWholeDomainDescriptors(product, published.layers);
    if (!expected) return false;
    for (const layer of published.layers) {
      const slot = expected.layers[layer], source = published.descriptors.layers[layer];
      if (!slot || !source) return false;
      slot.label = source.label;
    }
    if (published.descriptors.layers['precip-rate']?.methodId === LEGACY_PRECIPITATION_METHOD_ID) {
      const legacy = registry.methods[LEGACY_PRECIPITATION_METHOD_ID]!;
      expected.layers['precip-rate']!.methodId = legacy.id;
      expected.methods = Object.fromEntries(Object.entries(expected.methods).map(([id, method]) => id === CURRENT_PRECIPITATION_METHOD_ID ? [legacy.id, legacy] : [id, method])) as typeof expected.methods;
    }
    return sameJsonValue(published.descriptors, expected);
  } catch { return false; }
}
