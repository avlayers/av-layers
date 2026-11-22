import type { LayerId } from '@av/contracts/layers';
import { pointMapLift, type GeoPoint, type PinnedBuild, type PointFrame } from '@av/client';
import {
  LENSCHOW_F_MAX,
  LENSCHOW_PEAK_ZETA,
  lenschowNormalizedUpdraft,
  SINK_RATE_MPS,
  usableLiftDepthM,
  windFromComponents,
} from '@av/soaring';
import type { PublishedForecastHour, SiteForecast } from './internal-meteo.ts';
import { timeZoneForLongitude } from './time-zone.ts';

/**
 * Computes native-column usable lift ceiling (MSL) for forecast hours beyond `mapFrameCount`
 * where fine-grid `usable-lift-msl` is `'unavailable'`, using the identical 1.2 m/s Lenschow
 * sink solver and effective cloud cap as the fine map surface.
 * Preserves explicit `'no-usable-lift'` and `'outside-domain'` fine-surface statuses.
 */
function resolveNativeFallbackLiftTopM(args: {
  mapLiftStatus: string | undefined;
  groundTerrainM: number | null;
  thermalTopM: number | null;
  thermalVelocityMps: number | null;
  effectiveCloudLimitM: number | null;
  derivedV2TopM: number | null;
}): number | null {
  const { mapLiftStatus, groundTerrainM, thermalTopM, thermalVelocityMps, effectiveCloudLimitM, derivedV2TopM } = args;
  if (mapLiftStatus && mapLiftStatus !== 'unavailable') return null;
  if (
    groundTerrainM === null ||
    thermalTopM === null ||
    thermalVelocityMps === null ||
    thermalTopM <= groundTerrainM ||
    thermalVelocityMps * LENSCHOW_F_MAX < SINK_RATE_MPS
  ) {
    return null;
  }
  const depth = thermalTopM - groundTerrainM;
  const usableDepth = usableLiftDepthM(depth, thermalVelocityMps, { sinkRateMps: SINK_RATE_MPS });
  if (usableDepth === null) return derivedV2TopM;
  const cap = effectiveCloudLimitM !== null && Number.isFinite(effectiveCloudLimitM)
    ? Math.min(thermalTopM, effectiveCloudLimitM)
    : thermalTopM;
  const zeta = (cap - groundTerrainM) / depth;
  if (zeta <= 0 || (zeta <= LENSCHOW_PEAK_ZETA && thermalVelocityMps * lenschowNormalizedUpdraft(zeta) < SINK_RATE_MPS)) {
    return null;
  }
  return Math.min(groundTerrainM + usableDepth, cap);
}

function chartHour(
  validAt: string,
  frame: PointFrame | undefined,
  build: PinnedBuild,
  fineTerrainM: number | null,
): PublishedForecastHour {
  const read = (layer: LayerId) => {
    const cell = frame?.layers[layer];
    return cell?.status === 'valid' ? cell.value : null;
  };
  const profile = frame?.profile;
  const diagnostics = frame?.derived;
  const u10 = read('wind-10m-u'), v10 = read('wind-10m-v');
  const wind = windFromComponents(u10, v10);
  const modelTerrainM = profile?.modelTerrainM ?? null;
  const mapLift = pointMapLift(frame, build);
  const resolvedFineTerrainM = mapLift.terrainM ?? fineTerrainM;
  const thermalTopM = read('thermal-top-msl');
  const thermalVelocityMps = read('thermal-velocity');
  const effectiveCloudLimitM = diagnostics?.effectiveCloudLimitM ?? null;
  const nativeUsableLiftTopM = mapLift.mslM !== null
    ? null
    : resolveNativeFallbackLiftTopM({
        mapLiftStatus: mapLift.msl?.status,
        groundTerrainM: resolvedFineTerrainM ?? modelTerrainM,
        thermalTopM,
        thermalVelocityMps,
        effectiveCloudLimitM,
        derivedV2TopM: diagnostics?.usableLiftTopV2M ?? null,
      });

  return {
    validAt,
    modelTerrainM,
    fineTerrainM: resolvedFineTerrainM,
    mapLift,
    surface: {
      temperatureC: read('sfc-temp-c'), dewPointC: read('sfc-dewpoint-c'),
      windSpeedMps: diagnostics?.wind10mSpeedMps ?? wind.speedMps,
      windDirectionDeg: diagnostics?.wind10mDirDeg ?? wind.directionDeg,
      windU: u10, windV: v10,
      windGustMps: read('wind-gust-10m'), precipitationMmHr: read('precip-rate'),
      capeJkg: read('cape-jkg'), pblHeightM: read('pbl-height-agl'),
      cloudCoverTotalPercent: read('cloud-cover-total'),
      cloudCoverLowPercent: read('cloud-cover-low')
    },
    levels: profile?.status === 'valid' ? profile.levels : [],
    thermalTopM,
    nativeUsableLiftTopM,
    thermalVelocityMps,
    surfaceLclM: read('surface-lcl-msl'),
    mixedLayerLclM: diagnostics?.mixedLayerLclM ?? null,
    effectiveCloudLimitM,
    cuPotentialM: diagnostics?.cuPotentialM ?? null,
    odPotentialM: diagnostics?.odPotentialM ?? null,
    buoyancyShearRatio: diagnostics?.buoyancyShearRatio ?? null,
    overdeveloped: diagnostics?.overdeveloped ?? null,
    cloudCapped: diagnostics?.cloudCapped ?? null,
    layerWind: diagnostics ? {
      meanSpeedMps: diagnostics.blMeanWindSpeedMps, meanDirectionDeg: diagnostics.blMeanWindDirDeg,
      topSpeedMps: diagnostics.blTopWindSpeedMps, topDirectionDeg: diagnostics.blTopWindDirDeg,
      surfaceToTopShearMps: diagnostics.blWindShearMps
    } : null
  };
}

type ScheduledFrame = { readonly id: string; readonly validTime: string };

export interface CreatePointForecastOptions {
  readonly timeZone?: string;
}

/** Keep chart hours and resolved fine-surface elevation for the lifetime of one pinned point. */
export function createPointForecast(build: PinnedBuild, point: GeoPoint, options?: CreatePointForecastOptions) {
  const layers = build.manifest.descriptors.layers;
  const gust = layers['wind-gust-10m'], precipitation = layers['precip-rate'];
  const { lat, lon } = point;
  const metadata: Omit<SiteForecast, 'hours'> = {
    model: build.manifest.model,
    site: { latitude: lat, longitude: lon, timeZone: options?.timeZone ?? timeZoneForLongitude(lon) },
    semantics: {
      capeLabel: layers['cape-jkg']?.label,
      gust: gust ? gust.timeSupport === 'interval-maximum' ? 'hourMax' : 'instant' : null,
      precipitation: precipitation ? precipitation.timeSupport === 'valid-time' ? 'instantRate' : 'windowMeanRate' : null
    }
  };
  let siteFineTerrainM: number | null = null;
  const cache = new Map<string, { frame: PointFrame | undefined; fineTerrainM: number | null; hour: PublishedForecastHour }>();
  return (frames: readonly ScheduledFrame[], loaded: ReadonlyMap<string, PointFrame>): SiteForecast => {
    if (siteFineTerrainM === null) {
      for (const candidate of loaded.values()) {
        const candidateTerrainM = pointMapLift(candidate, build).terrainM;
        if (candidateTerrainM !== null && Number.isFinite(candidateTerrainM)) {
          siteFineTerrainM = candidateTerrainM;
          break;
        }
      }
    }
    return {
      ...metadata,
      hours: frames.map(({ id, validTime }) => {
        const frame = loaded.get(id);
        const outsideDomain = frame?.layers['usable-lift-msl']?.status === 'outside-domain';
        const effectiveFineTerrainM = frame && !outsideDomain ? siteFineTerrainM : null;
        const cached = cache.get(id);
        if (
          cached &&
          cached.frame === frame &&
          cached.fineTerrainM === effectiveFineTerrainM &&
          cached.hour.validAt === validTime
        ) {
          return cached.hour;
        }
        const hour = chartHour(validTime, frame, build, effectiveFineTerrainM);
        cache.set(id, { frame, fineTerrainM: effectiveFineTerrainM, hour });
        return hour;
      })
    };
  };
}
