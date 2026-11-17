import { describe, expect, it } from 'vitest';
import { getProduct, PRODUCTS } from '@av/contracts/models';
import { LAYERS, createHistoricalWholeDomainDescriptors, createWholeDomainDescriptors, descriptorSchema, manifestV5Schema, matchesHistoricalDescriptors,
  projectClientManifest, sameJsonValue, weatherFieldDefinition, weatherFieldDefinitionSchema, WEATHER_LAYER_IDS, acceptDirectScalar, DIRECT_SCALAR_BOUNDARY } from './index.js';
import { fixtureManifestV5 } from '../../../tests/forecast-fixture.js';
import contract from '../schemas/wrf-zarr-v3.schema.json' with { type: 'json' };

describe('weather field definitions', () => {
  it('publishes version 1 definitions for the four fields on every configured model', () => {
    for (const product of PRODUCTS) {
      const descriptors = createWholeDomainDescriptors(product);
      for (const layer of WEATHER_LAYER_IDS) {
        const definition = weatherFieldDefinition(product.modelId, layer);
        expect(definition?.version).toBe(1);
        expect(weatherFieldDefinitionSchema.parse(definition)).toEqual(definition);
        expect(descriptors.layers[layer].definition).toEqual(definition);
        expect(descriptorSchema.parse(descriptors).layers[layer].definition).toEqual(definition);
      }
    }
    expect(weatherFieldDefinition('gfs', 'cape-jkg')).toMatchObject({ id: 'noaa-gfs-surface-cape-v1', parcel: 'surface-based', sourceParameter: 'CAPE', sourceLevel: 'surface' });
    expect(weatherFieldDefinition('icon-eu', 'cape-jkg')).toMatchObject({ parcel: 'mixed-layer', sourceParameter: 'CAPE_ML' });
    expect(weatherFieldDefinition('rrfs', 'cloud-cover-total')).toMatchObject({ sourceLevel: 'entire atmosphere (considered as a single layer)' });
    const wrfCape = weatherFieldDefinition('av-wrf', 'cape-jkg');
    const wrfLow = weatherFieldDefinition('av-wrf', 'cloud-cover-low');
    expect(wrfCape?.kind === 'cape' ? wrfCape.producerDefinition : undefined).toBe(contract.capeParcelDefinition);
    expect(wrfLow?.kind === 'cloud-cover' ? wrfLow.algorithmId : undefined).toBe(contract.lowCloudDefinition);
    expect(weatherFieldDefinition('wrf-armenia-pilot-dwd-1km', 'precip-rate')).toEqual(weatherFieldDefinition('av-wrf', 'precip-rate'));
  });

  it('keeps historical descriptors stable when the live registry changes', () => {
    const product = getProduct('gfs')!;
    const historical = createHistoricalWholeDomainDescriptors(product);
    const live = createWholeDomainDescriptors(product);
    expect(historical).toBeDefined();
    expect(historical!.layers['cape-jkg'].definition).toBeUndefined();
    expect(matchesHistoricalDescriptors(product, { layers: product.layers, descriptors: historical! })).toBe(true);
    expect(matchesHistoricalDescriptors(product, { layers: product.layers, descriptors: live })).toBe(false);
    const stripped = structuredClone(live);
    for (const layer of Object.values(stripped.layers)) delete layer.definition;
    expect(sameJsonValue(stripped, historical)).toBe(true);
    const precipitation = LAYERS['precip-rate'];
    const units = precipitation.units;
    precipitation.units = 'cm/h';
    try {
      expect(createHistoricalWholeDomainDescriptors(product)).toEqual(historical);
      expect(createWholeDomainDescriptors(product).layers['precip-rate'].units).toBe('cm/h');
    } finally {
      precipitation.units = units;
    }
    expect(createHistoricalWholeDomainDescriptors({ ...product, id: 'missing-product' })).toBeUndefined();
  });

  it('accepts cloud and CAPE at the physical bounds and rejects values beyond the tolerance', () => {
    expect(acceptDirectScalar('cloud-cover-total', 0)).toEqual({ value: 0, invalid: false });
    expect(acceptDirectScalar('cloud-cover-low', 100)).toEqual({ value: 100, invalid: false });
    expect(acceptDirectScalar('cloud-cover-total', 100 + DIRECT_SCALAR_BOUNDARY).invalid).toBe(false);
    expect(acceptDirectScalar('cloud-cover-total', -DIRECT_SCALAR_BOUNDARY).value).toBe(-DIRECT_SCALAR_BOUNDARY);
    expect(acceptDirectScalar('cloud-cover-total', 100.1)).toEqual({ value: null, invalid: true });
    expect(acceptDirectScalar('cloud-cover-low', -1)).toEqual({ value: null, invalid: true });
    expect(acceptDirectScalar('cloud-cover-total', null)).toEqual({ value: null, invalid: false });
    expect(acceptDirectScalar('cloud-cover-total', Number.NaN).invalid).toBe(false);
    expect(acceptDirectScalar('cape-jkg', 0)).toEqual({ value: 0, invalid: false });
    expect(acceptDirectScalar('cape-jkg', 1e7).invalid).toBe(false);
    expect(acceptDirectScalar('cape-jkg', -DIRECT_SCALAR_BOUNDARY).invalid).toBe(false);
    expect(acceptDirectScalar('cape-jkg', -1)).toEqual({ value: null, invalid: true });
    expect(acceptDirectScalar('mslp-hpa', 1013).invalid).toBe(false);
  });
});

describe('client manifest projection', () => {
  function withExtra(place: 'suffix' | 'prefix') {
    const manifest = structuredClone(fixtureManifestV5({ layers: ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] })) as unknown as {
      layers: string[];
      descriptors: { layers: Record<string, Record<string, unknown>>; methods: Record<string, { outputs: string[] }> };
      surfaces: Array<{ id: string; kind: string; layers: string[] }>;
    };
    const id = 'cloud-cover-mid';
    const methodId = 'native-middle-cloud-v1';
    const precip = manifest.descriptors.layers['precip-rate']!;
    manifest.descriptors.methods[methodId] = { outputs: [id] };
    manifest.descriptors.layers[id] = {
      ...precip, id, label: 'Middle cloud', quantity: 'cloud-cover-middle', units: '%', methodId, delivery: 'samples-only', palette: undefined,
      definition: { version: 1, id: 'sample-middle-cloud-v1', kind: 'cloud-cover' }
    };
    const native = manifest.surfaces.find(surface => surface.kind === 'native')!;
    if (place === 'suffix') {
      manifest.layers.push(id);
      native.layers.push(id);
    } else {
      manifest.layers.unshift(id);
      native.layers.unshift(id);
    }
    return { manifest, id, methodId, native };
  }

  it('keeps an appended sample-only scalar and still parses the known fields', () => {
    const { manifest, id, methodId } = withExtra('suffix');
    expect(manifestV5Schema.safeParse(manifest).success).toBe(false);
    const projected = projectClientManifest(manifest);
    expect(projected.manifest.layers).toEqual(['usable-lift-msl', 'usable-lift-agl', 'precip-rate']);
    expect(projected.manifest.descriptors.layers[id]).toBeUndefined();
    expect(projected.manifest.descriptors.methods[methodId]).toBeUndefined();
    expect(projected.extraScalars).toMatchObject([{ id, descriptor: { definition: { version: 1, id: 'sample-middle-cloud-v1' } }, method: { outputs: [id] } }]);
    expect(projected.manifest.surfaces.find(surface => surface.kind === 'native')!.layers).toEqual(['precip-rate']);
  });

  it('rejects an extra scalar inserted ahead of a known layer and an unknown sample codec', () => {
    expect(() => projectClientManifest(withExtra('prefix').manifest)).toThrow('Unsupported scalar layout');
    const { manifest } = withExtra('suffix');
    const native = manifest.surfaces.find(surface => surface.kind === 'native')!;
    (native as unknown as { samples: { format: string } }).samples.format = 'future-pack';
    expect(() => projectClientManifest(manifest)).toThrow('Unsupported contract');
  });
});
