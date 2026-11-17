import { publishesNativeProfiles, weatherFieldDefinition, type LayerId, type WeatherLayerId } from '@av/contracts';
import { AUX_LEVEL_IDS, AUX_SURFACE_IDS, type AuxLevelId, type AuxSurfaceId } from './inputs.js';

const DIRECT_SURFACE = {
  'pbl-height-agl': 'pblHeightM',
  'cape-jkg': 'capeJkg',
  'cloud-cover-total': 'cloudTotalPct',
  'cloud-cover-low': 'cloudLowPct',
  'mslp-hpa': 'mslpPa',
  'wind-10m-u': 'u10mMps',
  'wind-10m-v': 'v10mMps',
  'wind-gust-10m': 'gust10mMps'
} as const satisfies Partial<Record<LayerId, AuxSurfaceId>>;

const PBL_CONSUMERS = ['thermal-velocity', 'thermal-top-msl', 'bl-mean-wind-u', 'bl-mean-wind-v'] as const;
const PROFILE_LEVELS = ['rhPercent', 'spfhKgKg', 'uWindMps', 'vWindMps', 'omegaPaS'] as const satisfies readonly AuxLevelId[];
const SCALAR_AUX: Partial<Record<AuxSurfaceId, WeatherLayerId>> = {
  capeJkg: 'cape-jkg', cloudTotalPct: 'cloud-cover-total', cloudLowPct: 'cloud-cover-low'
};

export function directSurfaceBinding(layer: LayerId): { source: AuxSurfaceId; scale: number } | undefined {
  const source = DIRECT_SURFACE[layer as keyof typeof DIRECT_SURFACE];
  if (!source) return undefined;
  return { source, scale: source === 'mslpPa' ? 0.01 : 1 };
}

export function requiredAuxiliaryFields(layers: readonly LayerId[]): { surface: AuxSurfaceId[]; levels: AuxLevelId[] } {
  const surface = new Set<AuxSurfaceId>();
  const levels = new Set<AuxLevelId>();
  for (const layer of layers) {
    const source = DIRECT_SURFACE[layer as keyof typeof DIRECT_SURFACE];
    if (source) surface.add(source);
  }
  if (layers.some(layer => (PBL_CONSUMERS as readonly string[]).includes(layer))) surface.add('pblHeightM');
  if (layers.includes('bl-mean-wind-u') || layers.includes('bl-mean-wind-v')) {
    levels.add('uWindMps'); levels.add('vWindMps');
  }
  if (publishesNativeProfiles(layers)) for (const id of PROFILE_LEVELS) levels.add(id);
  if (surface.has('u10mMps') || surface.has('v10mMps')) { surface.add('u10mMps'); surface.add('v10mMps'); }
  if (levels.has('uWindMps') || levels.has('vWindMps')) { levels.add('uWindMps'); levels.add('vWindMps'); }
  return { surface: AUX_SURFACE_IDS.filter(id => surface.has(id)), levels: AUX_LEVEL_IDS.filter(id => levels.has(id)) };
}

export function selectConfiguredFields<T>(configured: Readonly<Record<string, T>> | undefined, ids: readonly string[]): Record<string, T> | undefined {
  if (!configured) return undefined;
  const selected = Object.fromEntries(Object.entries(configured).filter(([id]) => ids.includes(id)));
  return Object.keys(selected).length ? selected : undefined;
}

export function assertIndexedWeatherBindings(modelId: string, upstream: {
  fields: { precipitation: readonly [string, string] };
  auxSurface?: Partial<Record<string, { variable: string; level: string }>>;
}): void {
  const precipitation = weatherFieldDefinition(modelId, 'precip-rate');
  if (precipitation?.kind === 'precipitation-rate') {
    const [variable, level] = upstream.fields.precipitation;
    if (precipitation.sourceParameter !== variable || (precipitation.sourceLevel !== undefined && precipitation.sourceLevel !== level)) {
      throw new Error(`Indexed GRIB precipitation does not match ${precipitation.id}`);
    }
  }
  for (const [id, spec] of Object.entries(upstream.auxSurface ?? {})) {
    const layer = SCALAR_AUX[id as AuxSurfaceId];
    if (!layer || !spec) continue;
    const definition = weatherFieldDefinition(modelId, layer);
    if (!definition || definition.kind === 'precipitation-rate') continue;
    if (definition.sourceParameter !== spec.variable || (definition.sourceLevel !== undefined && definition.sourceLevel !== spec.level)) {
      throw new Error(`Indexed GRIB ${id} does not match ${definition.id}`);
    }
  }
}

export function assertSplitWeatherBindings(modelId: string, upstream: {
  fields: { precipitation?: { field: string } };
  auxSurface?: Partial<Record<string, { field: string }>>;
}): void {
  const precipitation = weatherFieldDefinition(modelId, 'precip-rate');
  if (precipitation?.kind === 'precipitation-rate' && upstream.fields.precipitation
    && precipitation.sourceParameter !== upstream.fields.precipitation.field) {
    throw new Error(`Split GRIB precipitation does not match ${precipitation.id}`);
  }
  for (const [id, spec] of Object.entries(upstream.auxSurface ?? {})) {
    const layer = SCALAR_AUX[id as AuxSurfaceId];
    if (!layer || !spec) continue;
    const definition = weatherFieldDefinition(modelId, layer);
    if (!definition || definition.kind === 'precipitation-rate') continue;
    if (definition.sourceParameter !== spec.field) throw new Error(`Split GRIB ${id} does not match ${definition.id}`);
  }
}

export function assertWrfWeatherDefinitions(modelId: string, published: {
  capeParcelDefinition: string;
  lowCloudDefinition: string;
  precipitationField: string;
  totalCloudField: string;
  lowCloudField: string;
  capeField: string;
}): void {
  const cape = weatherFieldDefinition(modelId, 'cape-jkg');
  if (!cape) return;
  const low = weatherFieldDefinition(modelId, 'cloud-cover-low');
  const total = weatherFieldDefinition(modelId, 'cloud-cover-total');
  const precipitation = weatherFieldDefinition(modelId, 'precip-rate');
  if (cape.kind !== 'cape' || cape.producerDefinition !== published.capeParcelDefinition || cape.sourceParameter !== published.capeField) {
    throw new Error('WRF CAPE definition does not match the v3 contract');
  }
  if (!low || low.kind !== 'cloud-cover' || low.algorithmId !== published.lowCloudDefinition || low.sourceParameter !== published.lowCloudField) {
    throw new Error('WRF low-cloud definition does not match the v3 contract');
  }
  if (!total || total.kind !== 'cloud-cover' || total.sourceParameter !== published.totalCloudField) throw new Error('WRF total-cloud definition does not match the v3 contract');
  if (!precipitation || precipitation.kind !== 'precipitation-rate' || precipitation.sourceParameter !== published.precipitationField || precipitation.normalization !== 'producer-window-rate') {
    throw new Error('WRF precipitation definition does not match the v3 contract');
  }
}
