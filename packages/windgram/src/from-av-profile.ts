import { locateSampleCell, prepareGridGeometry } from '@av/contracts/geometry';
import type { LayerId } from '@av/contracts/layers';
import {
  pointMapLift,
  type GeoPoint,
  type PinnedBuild,
  type PointFrame,
  type PointTerrain,
} from '@av/client';
import { resolveSiteTimeZone } from '@av/client/timezone';
import {
  LENSCHOW_F_MAX,
  LENSCHOW_PEAK_ZETA,
  lenschowNormalizedUpdraft,
  resolveUpperAirMoistureReference,
  SINK_RATE_MPS,
  type UpperAirMoistureReference,
  usableLiftDepthM,
  windFromComponents,
} from '@av/soaring';
import type { PublishedForecastHour, SiteForecast } from './internal-meteo.ts';

/**
 * Native-column usable lift ceiling (MSL) from model ground, thermal top, w* and the effective
 * cloud cap, using the 1.2 m/s Lenschow sink solver. Computed for every hour; fine map lift is a
 * separate result.
 */
function resolveNativeLiftTopM(args: {
  groundTerrainM: number | null;
  thermalTopM: number | null;
  thermalVelocityMps: number | null;
  effectiveCloudLimitM: number | null;
  derivedV2TopM: number | null;
}): number | null {
  const { groundTerrainM, thermalTopM, thermalVelocityMps, effectiveCloudLimitM, derivedV2TopM } = args;
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

/**
 * Computes the maximum vector wind difference from 10 m surface wind across resolved levels
 * inside the convective or boundary layer, keeping public endpoint shear untouched.
 */
function computeMaxDepartureFromSurfaceMps(args: {
  modelTerrainM: number | null;
  windU10: number | null;
  windV10: number | null;
  thermalTopM: number | null;
  thermalVelocityMps: number | null;
  pblHeightM: number | null;
  levels: PublishedForecastHour['levels'];
}): number | null {
  const { modelTerrainM, windU10, windV10, thermalTopM, thermalVelocityMps, pblHeightM, levels } = args;
  if (
    modelTerrainM === null ||
    windU10 === null ||
    windV10 === null ||
    !Number.isFinite(modelTerrainM) ||
    !Number.isFinite(windU10) ||
    !Number.isFinite(windV10)
  ) {
    return null;
  }
  const hasConvectiveTop =
    thermalTopM !== null &&
    Number.isFinite(thermalTopM) &&
    (thermalTopM > modelTerrainM || (thermalTopM === modelTerrainM && (thermalVelocityMps ?? 0) > 0));
  const layerTopM = hasConvectiveTop
    ? thermalTopM
    : pblHeightM !== null && Number.isFinite(pblHeightM) && pblHeightM >= 0
      ? modelTerrainM + pblHeightM
      : thermalTopM === modelTerrainM
        ? modelTerrainM
        : null;
  if (layerTopM === null || layerTopM < modelTerrainM) return null;
  if (layerTopM === modelTerrainM) return 0;

  const surfaceAnchorM = Math.min(layerTopM, modelTerrainM + 10);
  if (layerTopM <= surfaceAnchorM) return 0;

  let z = surfaceAnchorM;
  let u = windU10;
  let v = windV10;
  let maxDeparture = 0;
  for (const level of levels) {
    if (level.heightM !== null && Number.isFinite(level.heightM) && level.heightM <= surfaceAnchorM) {
      continue;
    }
    const upperZ = level.heightM;
    const upperU = level.uWindMps;
    const upperV = level.vWindMps;
    if (
      upperZ === null ||
      !Number.isFinite(upperZ) ||
      upperZ <= z ||
      upperU === null ||
      upperV === null ||
      !Number.isFinite(upperU) ||
      !Number.isFinite(upperV)
    ) {
      return null;
    }
    const nextZ = Math.min(layerTopM, upperZ);
    const fraction = (nextZ - z) / (upperZ - z);
    const nextU = u + fraction * (upperU - u);
    const nextV = v + fraction * (upperV - v);
    maxDeparture = Math.max(maxDeparture, Math.hypot(nextU - windU10, nextV - windV10));
    if (upperZ >= layerTopM) return maxDeparture;
    z = nextZ;
    u = nextU;
    v = nextV;
  }
  return null;
}

function chartHour(
  validAt: string,
  frame: PointFrame | undefined,
  build: PinnedBuild,
  fineTerrainM: number | null,
  finePointInterpolated: boolean,
  upperAirDewpointReference: UpperAirMoistureReference,
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
  const thermalTopM = read('thermal-top-msl');
  const thermalVelocityMps = read('thermal-velocity');
  const pblHeightM = read('pbl-height-agl');
  const effectiveCloudLimitM = diagnostics?.effectiveCloudLimitM ?? null;
  const levels = profile?.status === 'valid' ? profile.levels : [];
  const nativeUsableLiftTopM = resolveNativeLiftTopM({
    groundTerrainM: modelTerrainM,
    thermalTopM,
    thermalVelocityMps,
    effectiveCloudLimitM,
    derivedV2TopM: diagnostics?.usableLiftTopV2M ?? null,
  });
  const maxDepartureFromSurfaceMps = diagnostics
    ? computeMaxDepartureFromSurfaceMps({
        modelTerrainM,
        windU10: u10,
        windV10: v10,
        thermalTopM,
        thermalVelocityMps,
        pblHeightM,
        levels,
      })
    : null;

  return {
    validAt,
    modelTerrainM,
    fineTerrainM,
    finePointInterpolated,
    upperAirDewpointReference,
    mapLift,
    surface: {
      temperatureC: read('sfc-temp-c'),
      dewPointC: read('sfc-dewpoint-c'),
      windSpeedMps: diagnostics?.wind10mSpeedMps ?? wind.speedMps,
      windDirectionDeg: diagnostics?.wind10mDirDeg ?? wind.directionDeg,
      windU: u10,
      windV: v10,
      windGustMps: read('wind-gust-10m'),
      precipitationMmHr: read('precip-rate'),
      capeJkg: read('cape-jkg'),
      pblHeightM,
      cloudCoverTotalPercent: read('cloud-cover-total'),
      cloudCoverLowPercent: read('cloud-cover-low'),
    },
    levels,
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
    layerWind: diagnostics
      ? {
          meanSpeedMps: diagnostics.blMeanWindSpeedMps,
          meanDirectionDeg: diagnostics.blMeanWindDirDeg,
          topSpeedMps: diagnostics.blTopWindSpeedMps,
          topDirectionDeg: diagnostics.blTopWindDirDeg,
          surfaceToTopShearMps: diagnostics.blWindShearMps,
          maxDepartureFromSurfaceMps,
        }
      : null,
  };
}

type ScheduledFrame = { readonly id: string; readonly validTime: string };

export interface CreatePointForecastOptions {
  readonly timeZone?: string;
  readonly siteTerrain?: PointTerrain | null;
}

/** Keep chart hours and resolved fine-surface elevation for the lifetime of one pinned point. */
export function createPointForecast(build: PinnedBuild, point: GeoPoint, options?: CreatePointForecastOptions) {
  const layers = build.manifest.descriptors.layers;
  const gust = layers['wind-gust-10m'], precipitation = layers['precip-rate'];
  const { lat, lon } = point;
  const siteTz = options?.timeZone
    ? {
        timeZone: options.timeZone,
        isUtcFallback: options.timeZone === 'UTC' || options.timeZone === 'Etc/UTC',
      }
    : resolveSiteTimeZone(lat, lon);
  const upperAirDewpointReference = resolveUpperAirMoistureReference();
  const fineSurface = build.manifest.surfaces.find(surface => surface.kind === 'fine');
  const fineLocated = fineSurface
    ? locateSampleCell(fineSurface.grid, lat, lon, prepareGridGeometry(fineSurface.grid))
    : null;
  const finePointInterpolated = Boolean(
    fineLocated && (fineLocated.fractionX !== 0 || fineLocated.fractionY !== 0),
  );
  const metadata: Omit<SiteForecast, 'hours'> = {
    model: build.manifest.model,
    site: {
      latitude: lat,
      longitude: lon,
      timeZone: siteTz.timeZone,
      ...(siteTz.isUtcFallback ? { isUtcFallback: true } : {}),
    },
    semantics: {
      capeLabel: layers['cape-jkg']?.label,
      gust: gust ? gust.timeSupport === 'interval-maximum' ? 'hourMax' : 'instant' : null,
      precipitation: precipitation ? precipitation.timeSupport === 'valid-time' ? 'instantRate' : 'windowMeanRate' : null,
    },
  };
  let pinnedSiteTerrain: PointTerrain | null | undefined = options?.siteTerrain;
  const cache = new Map<string, { frame: PointFrame | undefined; fineTerrainM: number | null; hour: PublishedForecastHour }>();
  return (
    frames: readonly ScheduledFrame[],
    loaded: ReadonlyMap<string, PointFrame>,
    siteTerrain?: PointTerrain | null,
  ): SiteForecast => {
    if (siteTerrain !== undefined) pinnedSiteTerrain = siteTerrain;
    const staticSiteElevationM =
      pinnedSiteTerrain?.status === 'valid' &&
      pinnedSiteTerrain.elevationM !== null &&
      Number.isFinite(pinnedSiteTerrain.elevationM)
        ? pinnedSiteTerrain.elevationM
        : null;
    return {
      ...metadata,
      hours: frames.map(({ id, validTime }) => {
        const frame = loaded.get(id);
        const outsideDomain =
          pinnedSiteTerrain?.status === 'outside-domain' ||
          frame?.layers['usable-lift-msl']?.status === 'outside-domain';
        const effectiveFineTerrainM = frame && !outsideDomain ? staticSiteElevationM : null;
        const cached = cache.get(id);
        if (
          cached &&
          cached.frame === frame &&
          cached.fineTerrainM === effectiveFineTerrainM &&
          cached.hour.validAt === validTime
        ) {
          return cached.hour;
        }
        if (cached && cached.frame === frame && cached.hour.validAt === validTime) {
          const hour = { ...cached.hour, fineTerrainM: effectiveFineTerrainM };
          cache.set(id, { frame, fineTerrainM: effectiveFineTerrainM, hour });
          return hour;
        }
        const hour = chartHour(
          validTime,
          frame,
          build,
          effectiveFineTerrainM,
          finePointInterpolated,
          upperAirDewpointReference,
        );
        cache.set(id, { frame, fineTerrainM: effectiveFineTerrainM, hour });
        return hour;
      }),
    };
  };
}
