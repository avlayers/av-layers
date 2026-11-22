// Multi-day Stitched Daylight Windgram scene builder.
// Crops each day in a 2–3 day window to its solar daylight interval, shares a single
// vertical altitude scale across all panels, and computes climb domes, inversions,
// wave ascent, isotherms, cloud decks, wind barbs, and lift curves independently
// per day panel so nothing bleeds across midnight.

import { longitudeOffsetHours } from '@av/client';
import { windFromComponents } from '@av/soaring';
import type { HourSampling, PublishedForecastHour as ProfileHour, SiteForecast } from './internal-meteo.ts';
import { formatShortDayLabel } from './point-view-mode.ts';
import type { WindgramCloudLayerSummary, WindgramOptions } from './scene-types.ts';
import { timeZoneOffsetMinutesAt } from './time-zone.ts';
import {
  analyzeHourCloudLayers,
  buildClimbDomeFieldPaths,
  buildInversionAndCloudDeckPaths,
  buildSkyCoverSpans,
  classifyConvectiveCloudRegime,
  DEFAULT_WINDGRAM_FIELD_MODE,
  type SkyCoverSpan,
  type WindgramFieldMode,
} from './windgram-atmosphere.ts';
import {
  celsiusToFahrenheit,
  finiteScalar,
  gustNoun,
  mpsToKnots,
  roundedElevationLabel,
  type UnitSystem,
} from './windgram-format.ts';
import { buildStabilityFieldPaths, temperatureContours } from './windgram-geometry.ts';
import { resolveWindgramPresentation } from './windgram-presentation.ts';
import {
  crossings,
  hourSampling,
  linearPath,
  moistLayers,
  sampleHeight,
  stabilityDisplayNodes,
  type Point,
} from './windgram-sampling.ts';
import { buildWindgramVerticalScale, heightToY } from './windgram-scale.ts';
import { WINDGRAM_STABILITY } from './windgram-stability.ts';
import {
  buildWindgramTimeLayout,
  formatWindgramHourLabel,
  hourX,
  selectWindgramHours,
  visibleWindgramHourIndices,
  type WindgramTimeTick,
} from './windgram-time-axis.ts';
import type { WindgramDayPanel, WindgramHour, WindgramView } from './windgram-view.ts';

export interface StitchedWindgramOptions extends WindgramOptions {
  readonly dateKeys: readonly string[];
  readonly selectedDateKey?: string | null;
  readonly bestDateKey?: string | null;
}

export function buildStitchedWindgramView(
  profile: SiteForecast,
  options: StitchedWindgramOptions,
): WindgramView {
  const system: UnitSystem = options.unitSystem;
  const fieldMode: WindgramFieldMode = options.fieldMode ?? DEFAULT_WINDGRAM_FIELD_MODE;
  const hybrid = fieldMode === 'hybrid-climb';
  const compact = options.compact ?? true;
  const timeZone = options.timeZone;
  const dateKeys = options.dateKeys.slice(0, 4);

  const slices = dateKeys.map((dateKey) => {
    const daySelection = selectWindgramHours(profile, {
      timeZone,
      hours: { timeZone, dateKey },
    });
    const effective = daySelection.hours.length === 0 && daySelection.daySource && daySelection.daySource.length > 0 && !daySelection.daylight
      ? { ...daySelection, hours: daySelection.daySource }
      : daySelection;
    return { dateKey, selection: effective };
  });

  const allHours: ProfileHour[] = slices.flatMap((s) => s.selection.hours);
  const altitudeSource = allHours.length ? allHours : profile.hours;
  const altitudeLabels = altitudeSource
    .flatMap((hour) => [
      hour.modelTerrainM,
      hour.fineTerrainM ?? hour.mapLift.terrainM,
      hour.mapLift.mslM,
      hour.nativeUsableLiftTopM ?? null,
      ...hour.levels.map((level) => level.heightM),
    ])
    .filter((height): height is number => typeof height === 'number' && Number.isFinite(height))
    .map((height) => `${roundedElevationLabel(height, system)}${compact ? '' : system === 'metric' ? ' m' : ' ft'}`);

  const presentation = resolveWindgramPresentation({
    compact,
    widthPx: options.widthPx,
    heightPx: options.heightPx,
    altitudeLabels,
  });
  const { left, top, plotWidth, plotHeight } = presentation;
  const bottom = top + plotHeight;
  const { floorM, topM, anchors } = buildWindgramVerticalScale(profile, altitudeSource, {
    compact,
    heightRange: options.heightRange,
    top,
    bottom,
    plotHeight,
  });

  const panelCount = Math.max(1, slices.length);
  const seamWidth = panelCount > 1 ? (plotWidth < 380 ? 6 : 8) : 0;
  const totalSeamsWidth = (panelCount - 1) * seamWidth;
  const panelWidth = Math.max(24, (plotWidth - totalSeamsWidth) / panelCount);

  const labelTime = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const viewHours: WindgramHour[] = [];
  const sourceHours: ProfileHour[] = [];
  const sampling: HourSampling[] = [];
  const cloudLayersByHour: (readonly WindgramCloudLayerSummary[])[] = [];
  const highCloudOnlyByHour: boolean[] = [];
  const timeAxis: WindgramTimeTick[] = [];
  const dayPanels: WindgramDayPanel[] = [];
  const orderedFieldOrder: string[] = [];
  const fieldsByClass = new Map<string, string[]>();
  const pushField = (className: string, path: string) => {
    if (!path) return;
    const list = fieldsByClass.get(className);
    if (list) list.push(path);
    else {
      orderedFieldOrder.push(className);
      fieldsByClass.set(className, [path]);
    }
  };
  const cloudDeckOrder: string[] = [];
  const cloudDeckByClass = new Map<string, string[]>();
  const pushCloudDeck = (className: string, path: string) => {
    if (!path) return;
    const list = cloudDeckByClass.get(className);
    if (list) list.push(path);
    else {
      cloudDeckOrder.push(className);
      cloudDeckByClass.set(className, [path]);
    }
  };
  const skyCoverSpans: SkyCoverSpan[] = [];

  const scale = { anchors, top, bottom, floorM, topM };
  const y = (z: number) => heightToY(scale, z);

  const convectiveOnly = (hour: ProfileHour) => !hybrid || (hour.thermalVelocityMps ?? 0) > 0;
  const seriesDefs = [
    ['thermalTopM', 'Native thermal top (parcel)', hybrid ? '#fcd34d' : '#a56800', '6 5', (hour: ProfileHour) => (convectiveOnly(hour) ? hour.thermalTopM : null)],
    ['usableLiftTopM', 'Map usable lift', '#134ac4', null, (hour: ProfileHour) => hour.mapLift.mslM],
    ...(hybrid
      ? [['nativeUsableLiftTopM', 'Native usable lift (beyond map horizon)', '#7dd3fc', '5 3', (hour: ProfileHour) =>
          hour.mapLift.mslM === null ? (hour.nativeUsableLiftTopM ?? null) : null] as const]
      : []),
    ['terrainM', 'Fine surface elevation', hybrid ? '#cbd5e1' : '#514b62', '3 4', (hour: ProfileHour) => hour.fineTerrainM ?? hour.mapLift.terrainM],
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
  ] as const;
  const seriesPaths = new Map<string, string[]>();

  const barbs: WindgramView['barbs'] = [];
  const clouds: WindgramView['clouds'] = [];
  const cloudBands: WindgramView['cloudBands'] = [];
  const freezing: WindgramView['freezing'] = [];
  const contours: WindgramView['contours'] = [];

  let sumColumnWidths = 0;
  let columnWidthCount = 0;
  const deferredMissingMasks: string[] = [];

  slices.forEach((slice, panelIdx) => {
    const panelLeft = left + panelIdx * (panelWidth + seamWidth);
    const panelRight = panelLeft + panelWidth;
    const subPresentation = {
      ...presentation,
      left: panelLeft,
      right: 0,
      plotWidth: panelWidth,
      width: panelLeft + panelWidth,
    };
    const subTime = buildWindgramTimeLayout(profile, slice.selection, subPresentation);
    const colW = subTime.columnWidth;
    if (Number.isFinite(colW) && colW > 0) {
      sumColumnWidths += colW;
      columnWidthCount += 1;
    }

    const startHourIndex = viewHours.length;
    const panelHours = slice.selection.hours;
    const panelSampling = panelHours.map(hourSampling);
    const panelCloudAnalyses = panelHours.map((h, idx) => analyzeHourCloudLayers(h, panelSampling[idx], topM));
    const localViewHours: WindgramHour[] = panelHours.map((h) => {
      const temp = finiteScalar(h.surface.temperatureC);
      const gust = finiteScalar(h.surface.windGustMps);
      return {
        validAt: h.validAt,
        label: formatWindgramHourLabel(h.validAt, labelTime),
        x: Math.min(panelRight - 4, Math.max(panelLeft + 4, subTime.xAt(Date.parse(h.validAt)))),
        temperatureF: temp === null ? null : celsiusToFahrenheit(temp),
        usableLiftTopM: h.mapLift.mslM,
        thermalVelocityMps: h.thermalVelocityMps,
        gustKt: gust === null ? null : mpsToKnots(gust),
      };
    });

    for (const h of panelHours) sourceHours.push(h);
    for (const s of panelSampling) sampling.push(s);
    for (const ca of panelCloudAnalyses) {
      cloudLayersByHour.push(ca.layers);
      highCloudOnlyByHour.push(ca.highCloudOnly);
    }
    for (const vh of localViewHours) viewHours.push(vh);
    const endHourIndex = viewHours.length - 1;

    const panelTicks: WindgramTimeTick[] = [
      ...subTime.emptyTimes.map((t): WindgramTimeTick => ({
        validAt: new Date(t).toISOString(),
        label: formatWindgramHourLabel(t, labelTime),
        x: subTime.xAt(t),
        hourIndex: null,
      })),
      ...localViewHours.map(({ validAt, label, x }, localIdx): WindgramTimeTick => ({
        validAt,
        label,
        x,
        hourIndex: startHourIndex + localIdx,
      })),
    ]
      .filter((tick) => tick.x >= panelLeft && tick.x <= panelRight)
      .sort((a, b) => a.x - b.x);

    const firstAxisIdx = timeAxis.length;
    for (const tick of panelTicks) timeAxis.push(tick);
    const localVisibleTickIndices = (() => {
      if (panelTicks.length <= 2) return panelTicks.map((_, idx) => firstAxisIdx + idx);
      if (panelWidth < 135) {
        const targets = panelWidth < 82
          ? [panelLeft + panelWidth * 0.28, panelLeft + panelWidth * 0.72]
          : [panelLeft + panelWidth * 0.18, panelLeft + panelWidth * 0.5, panelLeft + panelWidth * 0.82];
        const picked: number[] = [];
        for (const tx of targets) {
          let bestIdx = 0;
          let bestDist = Infinity;
          panelTicks.forEach((t, idx) => {
            const d = Math.abs(t.x - tx);
            if (d < bestDist) { bestDist = d; bestIdx = idx; }
          });
          if (!picked.includes(bestIdx) && (picked.length === 0 || panelTicks[bestIdx]!.x - panelTicks[picked.at(-1)!]!.x >= 21)) {
            picked.push(bestIdx);
          }
        }
        return picked.map((idx) => firstAxisIdx + idx);
      }
      return visibleWindgramHourIndices(
        {
          hours: panelTicks.map((t) => ({ x: Math.max(panelLeft + 10, Math.min(panelRight - 10, t.x)) })),
          compact: true,
        },
        38,
      ).map((idx) => firstAxisIdx + idx);
    })();

    const firstData = localViewHours[0];
    const lastData = localViewHours.at(-1);
    const uncoveredSpans =
      firstData && lastData
        ? [
            { x: panelLeft, width: Math.max(0, firstData.x - colW / 2 - panelLeft) },
            { x: Math.min(panelRight, lastData.x + colW / 2), width: Math.max(0, panelRight - (lastData.x + colW / 2)) },
          ].filter((span) => span.width > 0.5)
        : panelTicks.length
          ? [{ x: panelLeft, width: panelWidth }]
          : [];

    dayPanels.push({
      dateKey: slice.dateKey,
      label: formatShortDayLabel(slice.dateKey),
      isBestDay: options.bestDateKey === slice.dateKey,
      isSelectedDay: options.selectedDateKey === slice.dateKey,
      left: panelLeft,
      width: panelWidth,
      columnWidth: colW,
      startHourIndex,
      endHourIndex: panelHours.length ? endHourIndex : -1,
      visibleAxisIndices: localVisibleTickIndices,
      seamX: panelIdx < panelCount - 1 ? panelRight + seamWidth / 2 : null,
      seamWidth: panelIdx < panelCount - 1 ? seamWidth : 0,
      uncoveredSpans,
    });

    if (!panelHours.length) return;

    const bounds = localViewHours.map((_, i) => {
      const bLeft = Math.max(panelLeft, hourX(localViewHours, i - 0.5, colW));
      const bRight = Math.min(panelRight, hourX(localViewHours, i + 0.5, colW));
      return { left: bLeft, width: Math.max(0, bRight - bLeft) };
    });

    const stabilityPixelNodes = panelSampling.map((s) => {
      if (!s.lapseCPer1000Ft.some((n) => Number.isFinite(n.value))) return [];
      const displayNodes = stabilityDisplayNodes(s.lapseCPer1000Ft);
      const nodes = displayNodes.filter((n) => n.altitudeM >= floorM && n.altitudeM <= topM);
      if (displayNodes[0]!.altitudeM < floorM && displayNodes.at(-1)!.altitudeM >= floorM && nodes[0]?.altitudeM !== floorM) {
        nodes.unshift({ altitudeM: floorM, value: sampleHeight(displayNodes, floorM) ?? NaN });
      }
      if (nodes.length && nodes.at(-1)!.altitudeM < topM && displayNodes.at(-1)!.altitudeM > topM) {
        nodes.push({ altitudeM: topM, value: sampleHeight(displayNodes, topM) ?? NaN });
      }
      return nodes.map((n) => ({ distanceFromBottomPx: bottom - y(n.altitudeM), value: n.value }));
    });

    if (hybrid) {
      const { inversionFields, waveFields, cloudDeckFields } = buildInversionAndCloudDeckPaths({
        sourceHours: panelHours,
        sampling: panelSampling,
        hours: localViewHours,
        scale,
        columnWidth: colW,
        leftBound: panelLeft,
        rightBound: panelRight,
      });
      for (const f of inversionFields) pushField(f.className, f.path);
      for (const f of waveFields) pushField(f.className, f.path);
      for (const f of cloudDeckFields) pushCloudDeck(f.className, f.path);
      const climbFields = buildClimbDomeFieldPaths({
        sourceHours: panelHours,
        viewHours: localViewHours,
        scale,
        columnWidth: colW,
        leftBound: panelLeft,
        rightBound: panelRight,
      });
      for (const f of climbFields) pushField(f.className, f.path);
      skyCoverSpans.push(
        ...buildSkyCoverSpans({
          sourceHours: panelHours,
          sampling: panelSampling,
          viewHours: localViewHours,
          columnWidth: colW,
          leftBound: panelLeft,
          rightBound: panelRight,
          topM,
        }),
      );
    } else if (stabilityPixelNodes.some((nodes) => nodes.length)) {
      const panelFields = buildStabilityFieldPaths({
        nodesByHour: stabilityPixelNodes,
        hours: localViewHours,
        columnWidth: colW,
        plotTop: top,
        plotBottom: bottom,
        banding: {
          breakpoints: WINDGRAM_STABILITY.slice(0, -1).map((c) => c.maxLapse),
          classNames: WINDGRAM_STABILITY.map((c) => `meteo-gram-stab-${c.className}`),
        },
      });
      for (const [cls, path] of Object.entries(panelFields)) pushField(cls, path);
    }

    stabilityPixelNodes.forEach((nodes, i) => {
      const rawNodes = panelSampling[i]!.lapseCPer1000Ft;
      const { left: bLeft, width: bWidth } = bounds[i]!;
      if (bWidth <= 0) return;
      const validNodes = nodes.filter((n) => Number.isFinite(n.value));
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
            deferredMissingMasks.push(`M${bLeft},${missingSpan.topY}h${bWidth}v${missingSpan.baseY - missingSpan.topY}h-${bWidth}Z`);
          }
          missingSpan = { baseY, topY };
        }
      }
      if (missingSpan && missingSpan.baseY > missingSpan.topY) {
        deferredMissingMasks.push(`M${bLeft},${missingSpan.topY}h${bWidth}v${missingSpan.baseY - missingSpan.topY}h-${bWidth}Z`);
      }
      const missingHeight = validNodes.length ? bottom - highestValidPx - top : plotHeight;
      if (missingHeight > 0) {
        deferredMissingMasks.push(`M${bLeft},${top}h${bWidth}v${missingHeight}h-${bWidth}Z`);
      }
      const modelTerrainM = panelHours[i]!.modelTerrainM;
      if (validNodes.length && modelTerrainM !== null && modelTerrainM > floorM) {
        const groundY = y(modelTerrainM);
        deferredMissingMasks.push(`M${bLeft},${groundY}h${bWidth}v${bottom - groundY}h-${widthOrZero(bWidth)}Z`);
      }
    });

    const panelContours = temperatureContours(
      {
        ...scale,
        plotHeight,
        columnWidth: colW,
        hours: localViewHours,
        sampling: panelSampling,
      },
      system,
    );
    contours.push(...panelContours);

    const barbInset = Math.min(8, panelWidth * 0.1);
    const barbHourIndices = new Set(
      visibleWindgramHourIndices(
        { hours: localViewHours, compact: true, left: panelLeft + barbInset, plotWidth: Math.max(12, panelWidth - barbInset * 2) },
        panelWidth < 140 ? 29 : 25,
      ),
    );

    panelHours.forEach((h, i) => {
      const globalIdx = startHourIndex + i;
      const sample = panelSampling[i]!;
      const x = localViewHours[i]!.x;
      if (barbHourIndices.has(i)) {
        const addBarb = (z: number, interpolated: boolean, surface: boolean) => {
          if (z < floorM || z > topM) return;
          const u = sampleHeight(sample.windU, z);
          const v = sampleHeight(sample.windV, z);
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
            southernHemisphere: profile.site.latitude < 0,
            interpolated,
            surface,
          });
        };
        for (let j = 0; j < sample.windU.length; j++) {
          const a = sample.windU[j]!;
          const b = sample.windU[j + 1];
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
      const convLayer = panelCloudAnalyses[i]?.convectiveLayer ?? null;
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
          colWidth: bWidth > 0 ? bWidth : colW,
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

    for (const [key, , , , heightFn] of seriesDefs) {
      const pts = panelHours.map((hour, i): Point | null => {
        const z = heightFn(hour);
        return z === null || z < floorM || z > topM ? null : { x: localViewHours[i]!.x, y: y(z) };
      });
      const subPath = linearPath(pts);
      if (subPath) {
        const list = seriesPaths.get(key);
        if (list) list.push(subPath);
        else seriesPaths.set(key, [subPath]);
      }
    }
  });

  // Ensure inversions -> wave lift -> thermal climb domes -> missing masks layer cleanly.
  const sortedClasses = [...orderedFieldOrder].sort((a, b) => {
    const rank = (cls: string) =>
      cls.startsWith('wg-inversion-') ? 0 : cls.startsWith('wg-wave-') ? 1 : cls.startsWith('wg-climb-') ? 2 : 3;
    return rank(a) - rank(b);
  });
  const finalFields = sortedClasses.map(className => ({
    className,
    path: fieldsByClass.get(className)!.join(''),
  }));
  if (deferredMissingMasks.length) {
    finalFields.push({ className: 'windgram-missing', path: deferredMissingMasks.join('') });
  }

  const avgColumnWidth = columnWidthCount > 0 ? sumColumnWidths / columnWidthCount : plotWidth / Math.max(1, viewHours.length);
  const visibleHours = visibleWindgramHourIndices({ hours: viewHours, compact, left, plotWidth }, 0);
  const selectedHourIndex = visibleHours.reduce(
    (best, index) =>
      (viewHours[index]!.thermalVelocityMps ?? -1) > (viewHours[best]!.thermalVelocityMps ?? -1) ? index : best,
    visibleHours[0] ?? 0,
  );
  const refInstantMs = sourceHours[0] ? Date.parse(sourceHours[0].validAt) : NaN;
  const offsetMinutes = Number.isFinite(refInstantMs)
    ? timeZoneOffsetMinutesAt(refInstantMs, timeZone)
    : Number.isFinite(profile.site.longitude)
      ? longitudeOffsetHours(profile.site.longitude) * 60
      : 0;

  return {
    unitSystem: system,
    fieldMode,
    presentation,
    width: presentation.width,
    height: presentation.height,
    left,
    top,
    plotWidth,
    plotHeight,
    bottom,
    columnWidth: avgColumnWidth,
    floorM,
    topM,
    gustLabel: gustNoun(profile.semantics.gust),
    capeLabel: profile.semantics.capeLabel ?? 'CAPE',
    precipitationSemantics: profile.semantics.precipitation,
    sourceHours,
    offsetMinutes,
    timeZone,
    anchors,
    sampling,
    cloudLayersByHour,
    highCloudOnlyByHour,
    compact,
    timeAxis,
    hours: viewHours,
    dayPanels,
    fields: finalFields,
    cloudDeckFields: cloudDeckOrder.map(className => ({ className, path: cloudDeckByClass.get(className)!.join('') })),
    skyCoverSpans,
    contours,
    barbs,
    clouds,
    cloudBands,
    freezing,
    series: seriesDefs.map(([key, label, color, dash]) => ({
      key,
      label,
      color,
      dash,
      path: (seriesPaths.get(key) ?? []).join(' '),
    })),
    selectedHourIndex,
  };
}

function widthOrZero(w: number): number {
  return w > 0 ? w : 0;
}
