import type { LayerId } from '@av/contracts/layers';
import { longitudeOffsetHours, pointMapLift, type GeoPoint, type PinnedBuild, type PointFrame } from '@av/client';
import {
  LENSCHOW_F_MAX,
  LENSCHOW_PEAK_ZETA,
  lenschowNormalizedUpdraft,
  SINK_RATE_MPS,
  usableLiftDepthM,
  windFromComponents,
} from '@av/soaring';
import type { PublishedForecastHour, SiteForecast } from './internal-meteo.ts';

function timeZoneForLongitude(lon: number): string {
  const offsetHours = longitudeOffsetHours(lon);
  if (offsetHours === 0) return 'Etc/UTC';
  const sign = offsetHours > 0 ? '-' : '+';
  return `Etc/GMT${sign}${Math.abs(offsetHours)}`;
}

/**
 * Computes native-column usable lift ceiling (MSL) for forecast hours beyond `mapFrameCount`
 * where fine-grid `usable-lift-msl` is `'unavailable'`, using the identical 1.2 m/s Lenschow
 * sink solver and effective cloud cap as the fine map surface.
 * Never overrides an explicit `'no-usable-lift'` or `'outside-domain'` fine-surface status.
 */
function resolveNativeFallbackLiftTopM(args: {
  mapLiftStatus: string | undefined;
  modelTerrainM: number | null;
  thermalTopM: number | null;
  thermalVelocityMps: number | null;
  effectiveCloudLimitM: number | null;
  derivedV2TopM: number | null;
}): number | null {
  const { mapLiftStatus, modelTerrainM, thermalTopM, thermalVelocityMps, effectiveCloudLimitM, derivedV2TopM } = args;
  if (mapLiftStatus && mapLiftStatus !== 'unavailable') return null;
  if (
    modelTerrainM === null ||
    thermalTopM === null ||
    thermalVelocityMps === null ||
    thermalTopM <= modelTerrainM ||
    thermalVelocityMps * LENSCHOW_F_MAX < SINK_RATE_MPS
  ) {
    return null;
  }
  const depth = thermalTopM - modelTerrainM;
  const usableDepth = usableLiftDepthM(depth, thermalVelocityMps, { sinkRateMps: SINK_RATE_MPS });
  if (usableDepth === null) return derivedV2TopM;
  const cap = effectiveCloudLimitM !== null && Number.isFinite(effectiveCloudLimitM)
    ? Math.min(thermalTopM, effectiveCloudLimitM)
    : thermalTopM;
  const zeta = (cap - modelTerrainM) / depth;
  if (zeta <= 0 || (zeta <= LENSCHOW_PEAK_ZETA && thermalVelocityMps * lenschowNormalizedUpdraft(zeta) < SINK_RATE_MPS)) {
    return null;
  }
  return Math.min(modelTerrainM + usableDepth, cap);
}

function chartHour(validAt: string, frame: PointFrame | undefined, build: PinnedBuild): PublishedForecastHour {
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
  const thermalTopM = read('thermal-top-msl');
  const thermalVelocityMps = read('thermal-velocity');
  const effectiveCloudLimitM = diagnostics?.effectiveCloudLimitM ?? null;
  const nativeUsableLiftTopM = mapLift.mslM !== null
    ? null
    : resolveNativeFallbackLiftTopM({
        mapLiftStatus: mapLift.msl?.status,
        modelTerrainM,
        thermalTopM,
        thermalVelocityMps,
        effectiveCloudLimitM,
        derivedV2TopM: diagnostics?.usableLiftTopV2M ?? null,
      });

  return {
    validAt,
    modelTerrainM,
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

/** Keep chart hours for the lifetime of one pinned point. */
export function createPointForecast(build: PinnedBuild, point: GeoPoint) {
  const layers = build.manifest.descriptors.layers;
  const gust = layers['wind-gust-10m'], precipitation = layers['precip-rate'];
  const { lat, lon } = point;
  const metadata: Omit<SiteForecast, 'hours'> = {
    model: build.manifest.model,
    site: { latitude: lat, longitude: lon, timeZone: timeZoneForLongitude(lon) },
    semantics: {
      capeLabel: layers['cape-jkg']?.label,
      gust: gust ? gust.timeSupport === 'interval-maximum' ? 'hourMax' : 'instant' : null,
      precipitation: precipitation ? precipitation.timeSupport === 'valid-time' ? 'instantRate' : 'windowMeanRate' : null
    }
  };
  const cache = new Map<string, { frame: PointFrame | undefined; hour: PublishedForecastHour }>();
  return (frames: readonly ScheduledFrame[], loaded: ReadonlyMap<string, PointFrame>): SiteForecast => ({
    ...metadata,
    hours: frames.map(({ id, validTime }) => {
      const frame = loaded.get(id);
      const cached = cache.get(id);
      if (cached && cached.frame === frame && cached.hour.validAt === validTime) return cached.hour;
      const hour = chartHour(validTime, frame, build);
      cache.set(id, { frame, hour });
      return hour;
    })
  });
}
