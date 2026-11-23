// Multi-day Stitched Daylight Windgram scene builder.
// Crops each day in a 2–3 day window to its solar daylight interval, shares a single
// vertical altitude scale across all panels, and computes climb domes, inversions,
// wave ascent, isotherms, cloud decks, wind barbs, and lift curves per day panel.

import type { HourSampling, PublishedForecastHour as ProfileHour, SiteForecast } from './internal-meteo.ts';
import { formatShortDayLabel } from './point-view-mode.ts';
import type { WindgramCloudLayerSummary, WindgramOptions } from './scene-types.ts';
import {
  analyzeHourCloudLayers,
  buildClimbDomeFieldPaths,
  buildInversionAndCloudDeckPaths,
  buildSkyCoverSpans,
  DEFAULT_WINDGRAM_FIELD_MODE,
  stabilityPixelNodesForHour,
  type SkyCoverSpan,
  type WindgramFieldMode,
} from './windgram-atmosphere.ts';
import {
  gustNoun,
  type UnitSystem,
} from './windgram-format.ts';
import { buildStabilityFieldPaths, temperatureContours } from './windgram-geometry.ts';
import { resolveWindgramPresentation } from './windgram-presentation.ts';
import {
  hourSampling,
  linearPath,
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
import {
  collectMissingFieldMaskPaths,
  formatAltitudeAxisLabels,
  populateHourColumnMarks,
  resolveSceneTimeZoneMeta,
  toWindgramHour,
  windgramSeriesDefinitions,
  type WindgramDayPanel,
  type WindgramHour,
  type WindgramView,
} from './windgram-view.ts';

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
  const altitudeLabels = formatAltitudeAxisLabels(altitudeSource, system, compact);

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

  const seriesDefs = windgramSeriesDefinitions(hybrid);
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
    const localViewHours: WindgramHour[] = panelHours.map((h) =>
      toWindgramHour(h, Math.min(panelRight - 4, Math.max(panelLeft + 4, subTime.xAt(Date.parse(h.validAt)))), labelTime),
    );

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

    const stabilityPixelNodes = panelSampling.map((s) => stabilityPixelNodesForHour(s, scale));

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

    deferredMissingMasks.push(
      ...collectMissingFieldMaskPaths({
        stabilityPixelNodes,
        sampling: panelSampling,
        hours: panelHours,
        bounds,
        scale,
        plotHeight,
      }),
    );

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

    populateHourColumnMarks({
      hours: panelHours,
      sampling: panelSampling,
      cloudAnalyses: panelCloudAnalyses,
      viewHours: localViewHours,
      bounds,
      scale,
      hybrid,
      southernHemisphere: profile.site.latitude < 0,
      panelLeft,
      panelRight,
      defaultColWidth: colW,
      startHourIndex,
      includeBarbAt: (i) => barbHourIndices.has(i),
      barbs,
      freezing,
      clouds,
      cloudBands,
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

  // Layer inversions -> wave lift -> thermal climb domes -> missing masks cleanly.
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
  const { isUtcFallback, offsetMinutes } = resolveSceneTimeZoneMeta(profile, timeZone, sourceHours[0]);

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
    ...(isUtcFallback ? { isUtcFallback: true } : {}),
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
