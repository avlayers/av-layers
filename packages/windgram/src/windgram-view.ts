// Assemble time, altitude and profile geometry for a Windgram day.

import { longitudeOffsetHours } from '@av/client';
import { timeZoneOffsetMinutesAt } from '@av/client/timezone';
import { windFromComponents } from '@av/soaring';
import type { HourSampling, PublishedForecastHour as ProfileHour, SiteForecast } from './internal-meteo.ts';
import type {
  SkyCoverageCode,
  WindgramCloudLayerSummary,
  WindgramLayout,
  WindgramHour as PublicHour,
  WindgramOptions,
} from './scene-types.ts';
import {
  analyzeHourCloudLayers,
  buildClimbDomeFieldPaths,
  buildInversionAndCloudDeckPaths,
  buildSkyCoverSpans,
  classifyConvectiveCloudRegime,
  DEFAULT_WINDGRAM_FIELD_MODE,
  stabilityPixelNodesForHour,
  type ConvectiveCloudRegime,
  type HourCloudAnalysis,
  type SkyCoverSpan,
  type WindgramFieldMode,
} from './windgram-atmosphere.ts';
import {
  celsiusToFahrenheit,
  finiteScalar,
  roundedElevationLabel,
  gustNoun,
  mpsToKnots,
  type UnitSystem,
} from './windgram-format.ts';
import {
  buildStabilityFieldPaths,
  temperatureContours,
  type TemperatureContour,
} from './windgram-geometry.ts';
import {
  crossings,
  hourSampling,
  linearPath,
  moistLayers,
  sampleHeight,
  type Point,
} from './windgram-sampling.ts';
import {
  buildWindgramVerticalScale,
  heightToY,
  type HeightAnchor,
  type WindgramScale,
} from './windgram-scale.ts';
import { WINDGRAM_STABILITY } from './windgram-stability.ts';
import {
  buildWindgramTimeLayout,
  formatWindgramHourLabel,
  hourX,
  visibleWindgramHourIndices,
  selectWindgramHours,
  type WindgramTimeTick,
} from './windgram-time-axis.ts';
import { resolveWindgramPresentation, type WindgramPresentation } from './windgram-presentation.ts';

export interface WindgramBarb {
  x: number;
  y: number;
  heightM: number;
  hourIndex: number;
  speedKt: number;
  directionDeg: number;
  southernHemisphere: boolean;
  interpolated: boolean;
  surface: boolean;
}
export interface WindgramCloud {
  hourIndex: number;
  x: number;
  y: number;
  baseM: number;
  topM: number;
  kind: 'humidity' | 'potential';
  cumulus?: boolean;
  regime?: ConvectiveCloudRegime;
  capeJkg?: number | null;
  depthM?: number;
  coverageCode?: SkyCoverageCode;
  coverPercent?: number;
  topTempC?: number | null;
  glaciated?: boolean;
  colWidth?: number;
  panelLeft?: number;
  panelRight?: number;
}
interface WindgramSeries {
  key: string;
  label: string;
  color: string;
  dash: string | null;
  path: string;
}
export interface WindgramDayPanel {
  readonly dateKey: string;
  readonly label: string;
  readonly isBestDay: boolean;
  readonly isSelectedDay: boolean;
  readonly left: number;
  readonly width: number;
  readonly columnWidth: number;
  readonly startHourIndex: number;
  readonly endHourIndex: number;
  readonly visibleAxisIndices: readonly number[];
  readonly seamX: number | null;
  readonly seamWidth: number;
  readonly uncoveredSpans: readonly { readonly x: number; readonly width: number }[];
}
export interface WindgramHour extends PublicHour {
  temperatureF: number | null;
  gustKt: number | null;
}
export interface WindgramView extends WindgramLayout {
  model?: string;
  modelHasAnyOmega?: boolean;
  fieldMode: WindgramFieldMode;
  gustLabel: string;
  capeLabel: string;
  precipitationSemantics: 'instantRate' | 'windowMeanRate' | null;
  sourceHours: readonly ProfileHour[];
  offsetMinutes: number;
  presentation: WindgramPresentation;
  anchors: HeightAnchor[];
  hours: WindgramHour[];
  dayPanels?: readonly WindgramDayPanel[];
  /** Daylight axis includes empty columns outside the selected run's coverage. */
  timeAxis: WindgramTimeTick[];
  fields: { className: string; path: string }[];
  cloudDeckFields?: { className: string; path: string }[];
  skyCoverSpans?: readonly SkyCoverSpan[];
  contours: TemperatureContour[];
  barbs: WindgramBarb[];
  clouds: WindgramCloud[];
  cloudBands: { x: number; y: number; width: number; height: number }[];
  freezing: { x: number; y: number; hourIndex: number }[];
  series: WindgramSeries[];
  sampling: readonly HourSampling[];
  cloudLayersByHour?: readonly (readonly WindgramCloudLayerSummary[])[];
  highCloudOnlyByHour?: readonly boolean[];
}

export type WindgramSeriesSpec = readonly [
  key: string,
  label: string,
  color: string,
  dash: string | null,
  heightFn: (hour: ProfileHour, floorM: number) => number | null,
];

export function formatAltitudeAxisLabels(
  hours: readonly ProfileHour[],
  system: UnitSystem,
  compact: boolean,
): string[] {
  const unitSuffix = compact ? '' : system === 'metric' ? ' m' : ' ft';
  return hours
    .flatMap(hour => [
      hour.modelTerrainM,
      hour.fineTerrainM ?? null,
      hour.mapLift.mslM,
      hour.nativeUsableLiftTopM ?? null,
      ...hour.levels.map(level => level.heightM),
    ])
    .filter((height): height is number => typeof height === 'number' && Number.isFinite(height))
    .map(height => `${roundedElevationLabel(height, system)}${unitSuffix}`);
}

export function resolveSceneTimeZoneMeta(
  profile: SiteForecast,
  timeZone: string,
  firstHour: ProfileHour | undefined,
): { isUtcFallback: boolean; offsetMinutes: number } {
  const isUtcFallback = Boolean(profile.site.isUtcFallback) || timeZone === 'UTC' || timeZone === 'Etc/UTC';
  const refInstantMs = firstHour ? Date.parse(firstHour.validAt) : NaN;
  const offsetMinutes = Number.isFinite(refInstantMs)
    ? timeZoneOffsetMinutesAt(refInstantMs, timeZone)
    : isUtcFallback
      ? 0
      : Number.isFinite(profile.site.longitude)
        ? longitudeOffsetHours(profile.site.longitude) * 60
        : 0;
  return { isUtcFallback, offsetMinutes };
}

export function toWindgramHour(
  hour: ProfileHour,
  x: number,
  labelTime: Intl.DateTimeFormat,
): WindgramHour {
  const temp = finiteScalar(hour.surface.temperatureC);
  const gust = finiteScalar(hour.surface.windGustMps);
  return {
    validAt: hour.validAt,
    label: formatWindgramHourLabel(hour.validAt, labelTime),
    x,
    temperatureF: temp === null ? null : celsiusToFahrenheit(temp),
    usableLiftTopM: hour.mapLift.mslM,
    thermalVelocityMps: hour.thermalVelocityMps,
    gustKt: gust === null ? null : mpsToKnots(gust),
  };
}

export function collectMissingFieldMaskPaths(args: {
  stabilityPixelNodes: readonly (readonly { distanceFromBottomPx: number; value: number }[])[];
  sampling: readonly HourSampling[];
  hours: readonly ProfileHour[];
  bounds: readonly { left: number; width: number }[];
  scale: WindgramScale;
  plotHeight: number;
  hybrid?: boolean;
}): string[] {
  const { stabilityPixelNodes, sampling, hours, bounds, scale, plotHeight, hybrid = false } = args;
  const { floorM, top, bottom } = scale;
  const y = (z: number) => heightToY(scale, z);
  const paths: string[] = [];

  stabilityPixelNodes.forEach((nodes, i) => {
    const rawNodes = sampling[i]!.lapseCPer1000Ft;
    const { left: bLeft, width: bWidth } = bounds[i]!;
    if (bWidth <= 0) return;
    const validNodes = nodes.filter(n => Number.isFinite(n.value));
    const highestValidPx = validNodes.at(-1)?.distanceFromBottomPx ?? 0;
    let missingSpan: { baseY: number; topY: number } | null = null;
    for (let k = 0; k + 1 < rawNodes.length; k += 2) {
      const a = rawNodes[k]!, b = rawNodes[k + 1]!;
      if (Number.isFinite(a.value) && Number.isFinite(b.value)) continue;
      const topY = y(b.altitudeM);
      if (bottom - topY > highestValidPx + 0.001) continue;
      const baseY = y(a.altitudeM);
      if (missingSpan && Math.abs(missingSpan.topY - baseY) < 0.05) missingSpan.topY = topY;
      else {
        if (missingSpan && missingSpan.baseY > missingSpan.topY) {
          paths.push(`M${bLeft},${missingSpan.topY}h${bWidth}v${missingSpan.baseY - missingSpan.topY}h-${bWidth}Z`);
        }
        missingSpan = { baseY, topY };
      }
    }
    if (missingSpan && missingSpan.baseY > missingSpan.topY) {
      paths.push(`M${bLeft},${missingSpan.topY}h${bWidth}v${missingSpan.baseY - missingSpan.topY}h-${bWidth}Z`);
    }
    const missingHeight = validNodes.length ? bottom - highestValidPx - top : plotHeight;
    if (missingHeight > 0) {
      paths.push(`M${bLeft},${top}h${bWidth}v${missingHeight}h-${bWidth}Z`);
    }
    const modelTerrainM = hours[i]!.modelTerrainM;
    if (!hybrid && validNodes.length && modelTerrainM !== null && modelTerrainM > floorM) {
      const groundY = y(modelTerrainM);
      paths.push(`M${bLeft},${groundY}h${bWidth}v${bottom - groundY}h-${bWidth}Z`);
    }
  });

  return paths;
}

export function populateHourColumnMarks(args: {
  hours: readonly ProfileHour[];
  sampling: readonly HourSampling[];
  cloudAnalyses: readonly HourCloudAnalysis[];
  viewHours: readonly { x: number }[];
  bounds: readonly { left: number; width: number }[];
  scale: WindgramScale;
  hybrid: boolean;
  southernHemisphere: boolean;
  panelLeft: number;
  panelRight: number;
  defaultColWidth: number;
  startHourIndex?: number;
  includeBarbAt?: (localIndex: number) => boolean;
  barbs: WindgramBarb[];
  freezing: { x: number; y: number; hourIndex: number }[];
  clouds: WindgramCloud[];
  cloudBands: { x: number; y: number; width: number; height: number }[];
}): void {
  const {
    hours,
    sampling,
    cloudAnalyses,
    viewHours,
    bounds,
    scale,
    hybrid,
    southernHemisphere,
    panelLeft,
    panelRight,
    defaultColWidth,
    startHourIndex = 0,
    includeBarbAt,
    barbs,
    freezing,
    clouds,
    cloudBands,
  } = args;
  const { floorM, topM, bottom } = scale;
  const y = (z: number) => heightToY(scale, z);

  hours.forEach((h, i) => {
    const globalIdx = startHourIndex + i;
    const sample = sampling[i]!;
    const x = viewHours[i]!.x;
    if (!includeBarbAt || includeBarbAt(i)) {
      const addBarb = (z: number, interpolated: boolean, surface: boolean) => {
        if (z < floorM || z > topM) return;
        const u = sampleHeight(sample.windU, z), v = sampleHeight(sample.windV, z);
        if (u === null || v === null) return;
        const wind = windFromComponents(u, v);
        if (wind.speedMps === null) return;
        barbs.push({
          x,
          y: surface ? Math.min(bottom - 18, y(z)) : y(z),
          hourIndex: globalIdx,
          heightM: z,
          speedKt: mpsToKnots(wind.speedMps),
          directionDeg: wind.directionDeg ?? 0,
          southernHemisphere,
          interpolated,
          surface,
        });
      };
      for (let j = 0; j < sample.windU.length; j++) {
        const a = sample.windU[j]!, b = sample.windU[j + 1];
        const surface = h.modelTerrainM !== null && a.altitudeM === h.modelTerrainM + 10;
        addBarb(a.altitudeM, false, surface);
        const ay = surface ? Math.min(bottom - 18, y(a.altitudeM)) : y(a.altitudeM);
        if (b && b.altitudeM - a.altitudeM <= 1000 && ay - y(b.altitudeM) >= 66) {
          addBarb((a.altitudeM + b.altitudeM) / 2, true, false);
        }
      }
    }
    const freeze = crossings(sample.temperatureC, 0)[0];
    if (freeze !== undefined && freeze >= floorM && freeze <= topM) {
      freezing.push({ x, y: y(freeze), hourIndex: globalIdx });
    }
    const { left: bLeft, width: bWidth } = bounds[i]!;
    const moistSource = hybrid
      ? (sample.cloudHumidityPercent ?? sample.relativeHumidityPercent)
      : sample.relativeHumidityPercent;
    for (const layer of moistLayers(moistSource)) {
      if (layer.baseM >= topM || layer.topM <= floorM) continue;
      clouds.push({ ...layer, hourIndex: globalIdx, x, y: y(layer.baseM), kind: 'humidity' });
      if (bWidth > 0) {
        cloudBands.push({ x: bLeft, width: bWidth, y: y(layer.topM), height: y(layer.baseM) - y(layer.topM) });
      }
    }
    const regime = classifyConvectiveCloudRegime(h);
    const activeCu = regime !== 'none';
    const convLayer = cloudAnalyses[i]?.convectiveLayer ?? null;
    const cuLimits = [h.effectiveCloudLimitM, h.surfaceLclM].filter((v): v is number => v !== null && Number.isFinite(v));
    const base = activeCu && hybrid
      ? (convLayer?.baseM ?? (cuLimits.length ? Math.min(...cuLimits) : null))
      : h.surfaceLclM;
    if (base !== null && base >= floorM && base <= topM) {
      clouds.push({
        hourIndex: globalIdx,
        x,
        y: y(base),
        baseM: base,
        topM: activeCu && convLayer ? convLayer.topM : base,
        kind: 'potential',
        cumulus: activeCu,
        regime,
        capeJkg: finiteScalar(h.surface.capeJkg),
        colWidth: bWidth > 0 ? bWidth : defaultColWidth,
        panelLeft,
        panelRight,
        ...(activeCu && convLayer
          ? {
              depthM: convLayer.depthM,
              coverageCode: convLayer.coverageCode,
              coverPercent: convLayer.coverPercent,
              topTempC: convLayer.topTempC,
              glaciated: convLayer.glaciated,
            }
          : {}),
      });
    }
  });
}

export function windgramSeriesDefinitions(hybrid: boolean): readonly WindgramSeriesSpec[] {
  const convectiveOnly = (hour: ProfileHour) => !hybrid || (hour.thermalVelocityMps ?? 0) > 0;
  return [
    ['thermalTopM', 'Native thermal top (parcel)', hybrid ? '#fcd34d' : '#a56800', '6 5', (hour: ProfileHour) => (convectiveOnly(hour) ? hour.thermalTopM : null)],
    ['usableLiftTopM', 'Map usable lift', '#134ac4', null, (hour: ProfileHour) => hour.mapLift.mslM],
    ...(hybrid
      ? [
          ['nativeUsableLiftTopM', 'Native usable lift (beyond map horizon)', '#7dd3fc', '5 3', (hour: ProfileHour) =>
            hour.mapLift.mslM === null ? (hour.nativeUsableLiftTopM ?? null) : null] as const,
          ['modelTerrainM', 'Model ground elevation', '#94a3b8', '4 4', (hour: ProfileHour, floorM: number) =>
            hour.modelTerrainM !== null && hour.modelTerrainM > floorM + 5 ? hour.modelTerrainM : null] as const,
        ]
      : []),
    ['terrainM', 'Fine surface elevation', hybrid ? '#cbd5e1' : '#514b62', '3 4', (hour: ProfileHour, floorM: number) => {
      const fineM = hour.fineTerrainM ?? null;
      return fineM !== null && fineM > floorM + 2 ? fineM : null;
    }],
    ['surfaceLclM', 'Native potential cloud base (surface LCL)', hybrid ? '#f9a8d4' : '#426173', '3 4', (hour: ProfileHour) => (convectiveOnly(hour) ? hour.surfaceLclM : null)],
    [
      'effectiveCloudLimitM',
      'Native effective cloud limit',
      hybrid ? '#5eead4' : '#247e73',
      '5 2',
      (hour: ProfileHour) => {
        if (!convectiveOnly(hour)) return null;
        const { surfaceLclM: base, effectiveCloudLimitM: limit } = hour;
        return limit !== null && (base === null || Math.abs(limit - base) >= 1) ? limit : null;
      },
    ],
  ];
}

export function buildWindgramView(profile: SiteForecast, options: WindgramOptions): WindgramView {
  const system: UnitSystem = options.unitSystem;
  const fieldMode: WindgramFieldMode = options.fieldMode ?? DEFAULT_WINDGRAM_FIELD_MODE;
  const selection = selectWindgramHours(profile, options);
  const { hours } = selection;
  const compact = options.compact ?? false;
  const altitudeLabels = formatAltitudeAxisLabels(hours, system, compact);
  const presentation = resolveWindgramPresentation({ compact, widthPx: options.widthPx, heightPx: options.heightPx, altitudeLabels });
  const { left, right, top, columnWidth, plotWidth, xAt, emptyTimes } = buildWindgramTimeLayout(profile, selection, presentation);
  const plotHeight = presentation.plotHeight;
  const bottom = top + plotHeight;
  const { floorM, topM, anchors } = buildWindgramVerticalScale(profile, hours, {
    compact,
    heightRange: options.heightRange,
    top,
    bottom,
    plotHeight,
  });

  const sampling = hours.map(hourSampling);
  const cloudAnalyses = hours.map((h, i) => analyzeHourCloudLayers(h, sampling[i], topM));
  const labelTime = new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone, hour: 'numeric', minute: '2-digit', hour12: true });
  const { isUtcFallback, offsetMinutes } = resolveSceneTimeZoneMeta(profile, options.timeZone, hours[0]);
  const view: WindgramView = {
    unitSystem: system,
    fieldMode,
    presentation,
    model: profile.model,
    modelHasAnyOmega: profile.hours.some(h => h.levels.some(l => l.omegaPaS !== null && Number.isFinite(l.omegaPaS))),
    width: left + plotWidth + right,
    height: presentation.height,
    left,
    top,
    plotWidth,
    plotHeight,
    bottom,
    columnWidth,
    floorM,
    topM,
    gustLabel: gustNoun(profile.semantics.gust),
    capeLabel: profile.semantics.capeLabel ?? 'CAPE',
    precipitationSemantics: profile.semantics.precipitation,
    sourceHours: hours,
    offsetMinutes,
    timeZone: options.timeZone,
    ...(isUtcFallback ? { isUtcFallback: true } : {}),
    anchors,
    sampling,
    cloudLayersByHour: cloudAnalyses.map(a => a.layers),
    highCloudOnlyByHour: cloudAnalyses.map(a => a.highCloudOnly),
    compact,
    timeAxis: [],
    hours: hours.map(h => toWindgramHour(h, xAt(Date.parse(h.validAt)), labelTime)),
    fields: [],
    cloudDeckFields: [],
    skyCoverSpans: [],
    contours: [],
    barbs: [],
    clouds: [],
    cloudBands: [],
    freezing: [],
    series: [],
    selectedHourIndex: 0,
  };

  const emptyTick = (time: number): WindgramTimeTick => ({
    validAt: new Date(time).toISOString(),
    label: formatWindgramHourLabel(time, labelTime),
    x: xAt(time),
    hourIndex: null,
  });
  view.timeAxis = [
    ...emptyTimes.map(emptyTick),
    ...view.hours.map(({ validAt, label, x }, hourIndex) => ({ validAt, label, x, hourIndex })),
  ].filter(tick => tick.x >= left && tick.x <= left + plotWidth).sort((a, b) => a.x - b.x);
  const visibleHours = visibleWindgramHourIndices(view, 0);
  view.selectedHourIndex = visibleHours.reduce((best, index) =>
    (view.hours[index].thermalVelocityMps ?? -1) > (view.hours[best].thermalVelocityMps ?? -1) ? index : best, visibleHours[0] ?? 0);
  if (!hours.length) return view;

  const y = (z: number) => heightToY(view, z);
  const bounds = view.hours.map((_, i) => {
    const bLeft = hourX(view.hours, i - 0.5, columnWidth);
    return { left: bLeft, width: hourX(view.hours, i + 0.5, columnWidth) - bLeft };
  });
  const stabilityPixelNodes = sampling.map(s => stabilityPixelNodesForHour(s, view));
  const hybrid = fieldMode === 'hybrid-climb';

  if (hybrid) {
    const { inversionFields, waveFields, cloudDeckFields } = buildInversionAndCloudDeckPaths({
      sourceHours: hours,
      sampling,
      hours: view.hours,
      scale: view,
      columnWidth,
      leftBound: left,
      rightBound: left + plotWidth,
    });
    const climbFields = buildClimbDomeFieldPaths({
      sourceHours: hours,
      viewHours: view.hours,
      scale: view,
      columnWidth,
      leftBound: left,
      rightBound: left + plotWidth,
    });
    view.fields = [...inversionFields, ...waveFields, ...climbFields];
    view.cloudDeckFields = cloudDeckFields;
    view.skyCoverSpans = buildSkyCoverSpans({
      sourceHours: hours,
      sampling,
      viewHours: view.hours,
      columnWidth,
      leftBound: left,
      rightBound: left + plotWidth,
      topM,
    });
  } else {
    const fields = stabilityPixelNodes.some(nodes => nodes.length) ? buildStabilityFieldPaths({
      nodesByHour: stabilityPixelNodes,
      hours: view.hours,
      columnWidth,
      plotTop: top,
      plotBottom: bottom,
      banding: {
        breakpoints: WINDGRAM_STABILITY.slice(0, -1).map((c) => c.maxLapse),
        classNames: WINDGRAM_STABILITY.map((c) => `meteo-gram-stab-${c.className}`),
      },
    }) : {};
    view.fields = Object.entries(fields).map(([className, path]) => ({ className, path }));
  }

  for (const path of collectMissingFieldMaskPaths({ stabilityPixelNodes, sampling, hours, bounds, scale: view, plotHeight, hybrid })) {
    view.fields.push({ className: 'windgram-missing', path });
  }
  view.contours = temperatureContours(view, system);

  populateHourColumnMarks({
    hours,
    sampling,
    cloudAnalyses,
    viewHours: view.hours,
    bounds,
    scale: view,
    hybrid,
    southernHemisphere: profile.site.latitude < 0,
    panelLeft: left,
    panelRight: left + plotWidth,
    defaultColWidth: columnWidth,
    barbs: view.barbs,
    freezing: view.freezing,
    clouds: view.clouds,
    cloudBands: view.cloudBands,
  });

  for (const [key, label, color, dash, height] of windgramSeriesDefinitions(hybrid)) {
    const points = hours.map((hour, i): Point | null => {
      const z = height(hour, floorM);
      return z === null || z < floorM || z > topM ? null : { x: view.hours[i].x, y: y(z) };
    });
    view.series.push({ key, label, color, dash, path: linearPath(points) });
  }
  return view;
}
