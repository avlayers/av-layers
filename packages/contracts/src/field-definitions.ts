import z from 'zod';

const definitionId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)+-v[1-9][0-9]*$/);
const parameter = z.string().min(1).max(64);
const level = z.string().min(1).max(128);

const precipitationRateDefinition = z.object({
  version: z.literal(1),
  id: definitionId,
  kind: z.literal('precipitation-rate'),
  waterEquivalent: z.literal('liquid'),
  statistic: z.literal('interval-mean'),
  sourceQuantity: z.enum(['accumulated-amount', 'window-rate']),
  normalization: z.enum(['trailing-window-recovery', 'producer-window-rate']),
  sourceParameter: parameter,
  sourceLevel: level.optional()
}).strict();

const cloudCoverDefinition = z.object({
  version: z.literal(1),
  id: definitionId,
  kind: z.literal('cloud-cover'),
  layer: z.enum(['total-column', 'low']),
  sourceParameter: parameter,
  sourceLevel: level.optional(),
  instantaneous: z.literal(true),
  verticalExtent: z.string().min(1).max(80).optional(),
  overlap: z.string().min(1).max(80).optional(),
  algorithmId: z.string().min(1).max(80).optional()
}).strict();

const capeDefinition = z.object({
  version: z.literal(1),
  id: definitionId,
  kind: z.literal('cape'),
  parcel: z.enum(['surface-based', 'mixed-layer', 'most-unstable']),
  sourceParameter: parameter,
  sourceLevel: level.optional(),
  instantaneous: z.literal(true),
  producerDefinition: z.string().min(1).max(80).optional()
}).strict();

export const weatherFieldDefinitionSchema = z.discriminatedUnion('kind', [precipitationRateDefinition, cloudCoverDefinition, capeDefinition]);
export type WeatherFieldDefinition = z.infer<typeof weatherFieldDefinitionSchema>;

export const WEATHER_LAYER_IDS = ['precip-rate', 'cloud-cover-total', 'cloud-cover-low', 'cape-jkg'] as const;
export type WeatherLayerId = (typeof WEATHER_LAYER_IDS)[number];

function define(definition: WeatherFieldDefinition): WeatherFieldDefinition {
  return Object.freeze(weatherFieldDefinitionSchema.parse(definition));
}

const gfs = {
  'precip-rate': define({
    version: 1, id: 'noaa-gfs-apcp-interval-mean-v1', kind: 'precipitation-rate', waterEquivalent: 'liquid',
    statistic: 'interval-mean', sourceQuantity: 'accumulated-amount', normalization: 'trailing-window-recovery',
    sourceParameter: 'APCP', sourceLevel: 'surface'
  }),
  'cloud-cover-total': define({
    version: 1, id: 'noaa-gfs-tcdc-total-v1', kind: 'cloud-cover', layer: 'total-column',
    sourceParameter: 'TCDC', sourceLevel: 'entire atmosphere', instantaneous: true
  }),
  'cloud-cover-low': define({
    version: 1, id: 'noaa-gfs-lcdc-low-v1', kind: 'cloud-cover', layer: 'low',
    sourceParameter: 'LCDC', sourceLevel: 'low cloud layer', instantaneous: true
  }),
  'cape-jkg': define({
    version: 1, id: 'noaa-gfs-surface-cape-v1', kind: 'cape', parcel: 'surface-based',
    sourceParameter: 'CAPE', sourceLevel: 'surface', instantaneous: true
  })
} as const satisfies Record<WeatherLayerId, WeatherFieldDefinition>;

const rrfs = {
  'precip-rate': define({
    version: 1, id: 'noaa-rrfs-apcp-preceding-hour-v1', kind: 'precipitation-rate', waterEquivalent: 'liquid',
    statistic: 'interval-mean', sourceQuantity: 'accumulated-amount', normalization: 'trailing-window-recovery',
    sourceParameter: 'APCP', sourceLevel: 'surface'
  }),
  'cloud-cover-total': define({
    version: 1, id: 'noaa-rrfs-tcdc-total-v1', kind: 'cloud-cover', layer: 'total-column',
    sourceParameter: 'TCDC', sourceLevel: 'entire atmosphere (considered as a single layer)', instantaneous: true
  }),
  'cloud-cover-low': define({
    version: 1, id: 'noaa-rrfs-lcdc-low-v1', kind: 'cloud-cover', layer: 'low',
    sourceParameter: 'LCDC', sourceLevel: 'low cloud layer', instantaneous: true
  }),
  'cape-jkg': define({
    version: 1, id: 'noaa-rrfs-surface-cape-v1', kind: 'cape', parcel: 'surface-based',
    sourceParameter: 'CAPE', sourceLevel: 'surface', instantaneous: true
  })
} as const satisfies Record<WeatherLayerId, WeatherFieldDefinition>;

const icon = {
  'precip-rate': define({
    version: 1, id: 'dwd-icon-eu-tot-prec-interval-mean-v1', kind: 'precipitation-rate', waterEquivalent: 'liquid',
    statistic: 'interval-mean', sourceQuantity: 'accumulated-amount', normalization: 'trailing-window-recovery',
    sourceParameter: 'TOT_PREC', sourceLevel: 'surface'
  }),
  'cloud-cover-total': define({
    version: 1, id: 'dwd-icon-eu-clct-v1', kind: 'cloud-cover', layer: 'total-column',
    sourceParameter: 'CLCT', sourceLevel: 'surface', instantaneous: true
  }),
  'cloud-cover-low': define({
    version: 1, id: 'dwd-icon-eu-clcl-v1', kind: 'cloud-cover', layer: 'low',
    sourceParameter: 'CLCL', sourceLevel: '800hPa-surface', instantaneous: true, verticalExtent: '800 hPa to surface'
  }),
  'cape-jkg': define({
    version: 1, id: 'dwd-icon-eu-cape-ml-v1', kind: 'cape', parcel: 'mixed-layer',
    sourceParameter: 'CAPE_ML', sourceLevel: 'mixed-layer', instantaneous: true
  })
} as const satisfies Record<WeatherLayerId, WeatherFieldDefinition>;

const wrf = {
  'precip-rate': define({
    version: 1, id: 'av-wrf-precip-mm-hr-window-rate-v1', kind: 'precipitation-rate', waterEquivalent: 'liquid',
    statistic: 'interval-mean', sourceQuantity: 'window-rate', normalization: 'producer-window-rate',
    sourceParameter: 'precip_mm_hr'
  }),
  'cloud-cover-total': define({
    version: 1, id: 'av-wrf-cloud-total-pct-v1', kind: 'cloud-cover', layer: 'total-column',
    sourceParameter: 'cloud_total_pct', instantaneous: true
  }),
  'cloud-cover-low': define({
    version: 1, id: 'av-wrf-ecmwf-sigma-ge-0p8-max-random-overlap-v1', kind: 'cloud-cover', layer: 'low',
    sourceParameter: 'cloud_low_pct', instantaneous: true,
    algorithmId: 'ecmwf-sigma-ge-0p8-max-random-overlap', overlap: 'ecmwf-sigma-ge-0p8-max-random-overlap'
  }),
  'cape-jkg': define({
    version: 1, id: 'av-wrf-afwa-mucape-max-theta-e-pressure-gt-500hpa-v1', kind: 'cape', parcel: 'most-unstable',
    sourceParameter: 'cape_jkg', instantaneous: true, producerDefinition: 'afwa-mucape-max-theta-e-pressure-gt-500hpa'
  })
} as const satisfies Record<WeatherLayerId, WeatherFieldDefinition>;

const definitions: Record<string, Record<WeatherLayerId, WeatherFieldDefinition>> = {
  gfs, rrfs, 'icon-eu': icon, 'av-wrf': wrf, 'wrf-va-1km': wrf
};

export function weatherFieldDefinition(modelId: string, layerId: string): WeatherFieldDefinition | undefined {
  if (!WEATHER_LAYER_IDS.includes(layerId as WeatherLayerId)) return undefined;
  return definitions[modelId]?.[layerId as WeatherLayerId];
}
