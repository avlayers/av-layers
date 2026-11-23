import type { UnitSystem } from './windgram-format.ts';

export const windgramScene = Symbol('WindgramView');
export interface WindgramHour {
  readonly validAt: string;
  readonly label: string;
  readonly x: number;
  /** Published lift ceiling, metres MSL. */
  readonly usableLiftTopM: number | null;
  readonly thermalVelocityMps: number | null;
}
/** Create with buildWindgramView; retain the returned object for rendering and inspection. */
export interface WindgramLayout {
  readonly unitSystem: UnitSystem;
  readonly timeZone: string;
  readonly isUtcFallback?: boolean;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly bottom: number;
  readonly columnWidth: number;
  readonly floorM: number;
  readonly topM: number;
  readonly compact: boolean;
  /** Selected hour from which keyboard inspection begins. */
  selectedHourIndex: number;
}
export interface WindgramView extends WindgramLayout {
  readonly [windgramScene]: true;
  readonly hours: readonly WindgramHour[];
}
export interface WindgramHourFilterOptions {
  timeZone: string;
  hours?: readonly { validAt: string }[] | { timeZone: string; dateKey: string };
}
export interface WindgramOptions extends WindgramHourFilterOptions {
  unitSystem: UnitSystem;
  widthPx?: number;
  /** Maximum rendered chart height, including the axes. */
  heightPx?: number;
  compact?: boolean;
  /** Vertical extent; single-day charts retain sunrise through sunset. */
  heightRange?: 'soaring' | 'full';
  /** Pluggable background field mode ('hybrid-climb' default, 'lapse' classic environmental lapse rate). */
  fieldMode?: import('./windgram-atmosphere.ts').WindgramFieldMode;
}
export type SkyCoverageCode = 'CLR' | 'FEW' | 'SCT' | 'BKN' | 'OVC';

export interface WindgramCloudLayerSummary {
  readonly kind: 'stratiform' | 'cumulus' | 'overdeveloped';
  readonly altitudeBand: 'low' | 'mid' | 'high';
  readonly baseM: number;
  readonly topM: number;
  readonly depthM: number;
  readonly coverageCode: SkyCoverageCode;
  readonly coverPercent: number;
  readonly maxRhPercent: number | null;
  readonly saturated: boolean;
  readonly topTempC?: number | null;
  readonly glaciated?: boolean;
}

export interface WindgramReading {
  hourIndex: number;
  validAt: string;
  heightM: number;
  heightAglM: number | null;
  heightAglReference: 'terrain' | 'model' | null;
  temperatureF: number | null;
  speedKt: number | null;
  directionDeg: number | null;
  gustKt: number | null;
  cloud: 'humidity' | 'potential' | null;
  /** Moisture and omega at the inspected height; omega < 0 is ascent. */
  dewPointC: number | null;
  relativeHumidityPercent: number | null;
  cloudHumidityPercent?: number | null;
  verticalVelocityPaS: number | null;
  windSource: 'surface-10m' | 'model-level' | 'interpolated' | null;
  /** Vector wind change between surrounding native nodes. Bounds: metres MSL;
   * gradient: m/s per km. Missing or duplicate nodes yield null. */
  windShear: { lowerM: number; upperM: number; vectorChangeMps: number; perKmMps: number } | null;
  verticalVelocitySource: 'model-level' | 'interpolated' | null;
  verticalVelocityUnavailableReason: string | null;
  /** Surface weather is available independently of lift. */
  surfaceWindSpeedMps: number | null;
  surfaceWindDirectionDeg: number | null;
  precipitationMmHr: number | null;
  capeJkg: number | null;
  cloudCoverTotalPercent: number | null;
  cloudCoverLowPercent: number | null;
  estimatedClimbMps: number | null;
  peakClimbMps: number | null;
  /** Local environmental temperature gradient (°C per 1,000 ft; > 0 indicates a temperature inversion). */
  lapseCPer1000Ft?: number | null;
  /** Hydrostatic vertical air velocity w (m/s, positive upward) converted from omegaPaS. */
  waveVelocityMps?: number | null;
  /** True when a resolved above-freezing layer (>+0.5 °C) sits above sub-freezing air in this column. */
  warmLayerAloft?: boolean;
  /** Rapid 1-hour surface vector wind jump + >=45° directional shift (convective outflow / frontal gust line). */
  surfaceWindShift?: { readonly deltaKt: number; readonly shiftDeg: number } | null;
  /** Dimensionless w* / BL vector wind shear ratio from @av/soaring (RASP B/S = 10x this value). */
  buoyancyShearRatio?: number | null;
  /** Discrete vertical cloud layers resolved in this column (ordered lowest to highest). */
  cloudLayers?: readonly WindgramCloudLayerSummary[];
  /** Cloud layer physically containing `heightM` (if cursor sits inside a stratiform deck or Cu tower). */
  activeCloudLayer?: WindgramCloudLayerSummary | null;
  /** Lowest cloud base strictly above `heightM` (metres MSL), if any. */
  nearestCloudBaseAboveM?: number | null;
  /** Highest cloud top strictly below `heightM` (metres MSL), if any. */
  nearestCloudTopBelowM?: number | null;
  /** True when sky cover >= 50% comes solely from high cirrus above the soaring chart domain. */
  highCloudOnly?: boolean;
  cloudBaseM: number | null;
  effectiveCloudLimitM: number | null;
  overdeveloped?: boolean | null;
  cloudCapped?: boolean | null;
  modelTerrainM: number | null;
  fineTerrainM?: number | null;
  terrainDeltaM?: number | null;
  nativeThermalTopM: number | null;
  modelPblTopM: number | null;
  /** Published V2 layer diagnostics, independent of inspected height.
   * Speeds and surface-to-layer-top vector shear are m/s; bearings are wind-from
   * degrees clockwise from true north. */
  publishedLayerWind: {
    meanSpeedMps: number | null; meanDirectionDeg: number | null;
    topSpeedMps: number | null; topDirectionDeg: number | null;
    surfaceToTopShearMps: number | null;
    maxDepartureFromSurfaceMps?: number | null;
  } | null;
}
export interface WindgramSvgOptions {
  idPrefix?: string;
  calloutVariant?: import('./windgram-callout.ts').WindgramCalloutVariant;
}
