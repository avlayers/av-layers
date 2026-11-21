// Assemble time, altitude and profile geometry for a Windgram day.

import { longitudeOffsetHours } from '@av/client';
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
  type ConvectiveCloudRegime,
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
  stabilityDisplayNodes,
  type Point,
} from './windgram-sampling.ts';
import {
  buildWindgramVerticalScale,
  heightToY,
  type HeightAnchor,
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

export function buildWindgramView(profile: SiteForecast, options: WindgramOptions): WindgramView {
  const system: UnitSystem = options.unitSystem;
  const fieldMode: WindgramFieldMode = options.fieldMode ?? DEFAULT_WINDGRAM_FIELD_MODE;
  const selection = selectWindgramHours(profile, options);
  const { hours } = selection;
  const compact = options.compact ?? false;
  const altitudeLabels = hours.flatMap(hour => [hour.modelTerrainM, hour.mapLift.terrainM, hour.mapLift.mslM, hour.nativeUsableLiftTopM ?? null,
    ...hour.levels.map(level => level.heightM),
  ]).filter((height): height is number => typeof height === 'number' && Number.isFinite(height))
    .map(height => `${roundedElevationLabel(height, system)}${compact ? '' : system === 'metric' ? ' m' : ' ft'}`);
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
  const view: WindgramView = {
    unitSystem: system,
    fieldMode,
    presentation,
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
    offsetMinutes: Number.isFinite(profile.site.longitude) ? longitudeOffsetHours(profile.site.longitude) * 60 : 0,
    timeZone: options.timeZone,
    anchors,
    sampling,
    cloudLayersByHour: cloudAnalyses.map(a => a.layers),
    highCloudOnlyByHour: cloudAnalyses.map(a => a.highCloudOnly),
    compact,
    timeAxis: [],
    hours: hours.map(h => {
      const temp = finiteScalar(h.surface.temperatureC);
      const gust = finiteScalar(h.surface.windGustMps);
      return {
        validAt: h.validAt,
        label: formatWindgramHourLabel(h.validAt, labelTime),
        x: xAt(Date.parse(h.validAt)),
        temperatureF: temp === null ? null : celsiusToFahrenheit(temp),
        usableLiftTopM: h.mapLift.mslM,
        thermalVelocityMps: h.thermalVelocityMps,
        gustKt: gust === null ? null : mpsToKnots(gust),
      };
    }),
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
  const stabilityPixelNodes = sampling.map((s) => {
    if (!s.lapseCPer1000Ft.some((n) => Number.isFinite(n.value))) return [];
    const displayNodes = stabilityDisplayNodes(s.lapseCPer1000Ft);
    const nodes = displayNodes.filter(n => n.altitudeM >= floorM && n.altitudeM <= topM);
    if (displayNodes[0].altitudeM < floorM && displayNodes.at(-1)!.altitudeM >= floorM && nodes[0]?.altitudeM !== floorM) {
      nodes.unshift({ altitudeM: floorM, value: sampleHeight(displayNodes, floorM) ?? NaN });
    }
    if (nodes.length && nodes.at(-1)!.altitudeM < topM && displayNodes.at(-1)!.altitudeM > topM) {
      nodes.push({ altitudeM: topM, value: sampleHeight(displayNodes, topM) ?? NaN });
    }
    return nodes.map((n) => ({ distanceFromBottomPx: bottom - y(n.altitudeM), value: n.value }));
  });

  if (fieldMode === 'hybrid-climb') {
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

  stabilityPixelNodes.forEach((nodes, i) => {
    const rawNodes = sampling[i].lapseCPer1000Ft;
    const { left: bLeft, width } = bounds[i];
    const validNodes = nodes.filter((n) => Number.isFinite(n.value));
    const highestValidPx = validNodes.at(-1)?.distanceFromBottomPx ?? 0;
    let missingSpan: { baseY: number; topY: number } | null = null;
    for (let k = 0; k + 1 < rawNodes.length; k += 2) {
      const a = rawNodes[k], b = rawNodes[k + 1];
      if (Number.isFinite(a.value) && Number.isFinite(b.value)) continue;
      const topY = y(b.altitudeM);
      if (bottom - topY > highestValidPx + 0.001) continue;
      const baseY = y(a.altitudeM);
      if (missingSpan && Math.abs(missingSpan.topY - baseY) < 0.05) missingSpan.topY = topY;
      else {
        if (missingSpan && missingSpan.baseY > missingSpan.topY) {
          view.fields.push({
            className: 'windgram-missing',
            path: `M${bLeft},${missingSpan.topY}h${width}v${missingSpan.baseY - missingSpan.topY}h-${width}Z`,
          });
        }
        missingSpan = { baseY, topY };
      }
    }
    if (missingSpan && missingSpan.baseY > missingSpan.topY) {
      view.fields.push({
        className: 'windgram-missing',
        path: `M${bLeft},${missingSpan.topY}h${width}v${missingSpan.baseY - missingSpan.topY}h-${width}Z`,
      });
    }
    const missingHeight = validNodes.length ? bottom - highestValidPx - top : plotHeight;
    if (missingHeight > 0) {
      view.fields.push({
        className: 'windgram-missing',
        path: `M${bLeft},${top}h${width}v${missingHeight}h-${width}Z`,
      });
    }
    const modelTerrainM = hours[i].modelTerrainM;
    if (validNodes.length && modelTerrainM !== null && modelTerrainM > floorM) {
      const groundY = y(modelTerrainM);
      view.fields.push({ className: 'windgram-missing', path: `M${bLeft},${groundY}h${width}v${bottom - groundY}h-${width}Z` });
    }
  });
  view.contours = temperatureContours(view, system);

  hours.forEach((h, i) => {
    const sample = sampling[i], x = view.hours[i].x;
    const addBarb = (z: number, interpolated: boolean, surface: boolean) => {
      if (z < floorM || z > topM) return;
      const u = sampleHeight(sample.windU, z), v = sampleHeight(sample.windV, z);
      if (u === null || v === null) return;
      const wind = windFromComponents(u, v);
      if (wind.speedMps === null) return;
      view.barbs.push({
        x,
        y: surface ? Math.min(bottom - 18, y(z)) : y(z),
        hourIndex: i,
        heightM: z,
        speedKt: mpsToKnots(wind.speedMps),
        directionDeg: wind.directionDeg ?? 0,
        southernHemisphere: profile.site.latitude < 0,
        interpolated,
        surface,
      });
    };
    for (let j = 0; j < sample.windU.length; j++) {
      const a = sample.windU[j], b = sample.windU[j + 1];
      const surface = h.modelTerrainM !== null && a.altitudeM === h.modelTerrainM + 10;
      addBarb(a.altitudeM, false, surface);
      const ay = surface ? Math.min(bottom - 18, y(a.altitudeM)) : y(a.altitudeM);
      if (b && b.altitudeM - a.altitudeM <= 1000 && ay - y(b.altitudeM) >= 66) addBarb((a.altitudeM + b.altitudeM) / 2, true, false);
    }
    const freezing = crossings(sample.temperatureC, 0)[0];
    if (freezing !== undefined && freezing >= floorM && freezing <= topM) view.freezing.push({ x, y: y(freezing), hourIndex: i });
    const { left: bLeft, width } = bounds[i];
    for (const layer of moistLayers(sample.relativeHumidityPercent)) {
      if (layer.baseM >= topM || layer.topM <= floorM) continue;
      view.clouds.push({ ...layer, hourIndex: i, x, y: y(layer.baseM), kind: 'humidity' });
      view.cloudBands.push({ x: bLeft, width, y: y(layer.topM), height: y(layer.baseM) - y(layer.topM) });
    }
    const regime = classifyConvectiveCloudRegime(h);
    const activeCu = regime !== 'none';
    const convLayer = cloudAnalyses[i]?.convectiveLayer ?? null;
    const cuLimits = [h.effectiveCloudLimitM, h.surfaceLclM].filter((v): v is number => v !== null && Number.isFinite(v));
    const base = activeCu && fieldMode === 'hybrid-climb'
      ? (convLayer?.baseM ?? (cuLimits.length ? Math.min(...cuLimits) : null))
      : h.surfaceLclM;
    if (base !== null && base >= floorM && base <= topM) {
      view.clouds.push({
        hourIndex: i,
        x,
        y: y(base),
        baseM: base,
        topM: activeCu && convLayer ? convLayer.topM : base,
        kind: 'potential',
        cumulus: activeCu,
        regime,
        capeJkg: finiteScalar(h.surface.capeJkg),
        colWidth: width,
        panelLeft: left,
        panelRight: left + plotWidth,
        ...(activeCu && convLayer
          ? { depthM: convLayer.depthM, coverageCode: convLayer.coverageCode, coverPercent: convLayer.coverPercent }
          : {}),
      });
    }
  });
  const hybrid = fieldMode === 'hybrid-climb';
  const convectiveOnly = (hour: ProfileHour) => !hybrid || (hour.thermalVelocityMps ?? 0) > 0;
  const seriesSpecs = [
    ['thermalTopM', 'Native thermal top (parcel)', hybrid ? '#fcd34d' : '#a56800', '6 5', (hour: ProfileHour) => (convectiveOnly(hour) ? hour.thermalTopM : null)],
    ['usableLiftTopM', 'Map usable lift', '#134ac4', null, (hour: ProfileHour) => hour.mapLift.mslM],
    ...(hybrid
      ? [['nativeUsableLiftTopM', 'Native usable lift (beyond map horizon)', '#7dd3fc', '5 3', (hour: ProfileHour) =>
          hour.mapLift.mslM === null ? (hour.nativeUsableLiftTopM ?? null) : null] as const]
      : []),
    ['terrainM', 'Fine surface elevation', hybrid ? '#cbd5e1' : '#514b62', '3 4', (hour: ProfileHour) => hour.mapLift.terrainM],
    ['surfaceLclM', 'Native potential cloud base (surface LCL)', hybrid ? '#f9a8d4' : '#426173', '3 4', (hour: ProfileHour) => (convectiveOnly(hour) ? hour.surfaceLclM : null)],
    ['effectiveCloudLimitM', 'Native effective cloud limit', hybrid ? '#5eead4' : '#247e73', '5 2', (hour: ProfileHour) => {
      if (!convectiveOnly(hour)) return null;
      const { surfaceLclM: base, effectiveCloudLimitM: limit } = hour;
      return limit !== null && (base === null || Math.abs(limit - base) >= 1) ? limit : null;
    }],
  ] as const;
  for (const [key, label, color, dash, height] of seriesSpecs) {
    const points = hours.map((hour, i): Point | null => {
      const z = height(hour);
      return z === null || z < floorM || z > topM ? null : { x: view.hours[i].x, y: y(z) };
    });
    view.series.push({ key, label, color, dash, path: linearPath(points) });
  }
  return view;
}
