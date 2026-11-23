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
  type HourCloudAnalysis,
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
  median,
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
  type WindgramBarb,
  type WindgramCloud,
  type WindgramDayPanel,
  type WindgramHour,
  type WindgramView,
} from './windgram-view.ts';

export interface StitchedWindgramOptions extends WindgramOptions {
  readonly dateKeys: readonly string[];
  readonly selectedDateKey?: string | null;
  readonly bestDateKey?: string | null;
}

interface CachedStitchedPanel {
  readonly hours: readonly ProfileHour[];
  readonly colW: number;
  readonly sampling: readonly HourSampling[];
  readonly cloudAnalyses: readonly HourCloudAnalysis[];
  readonly localViewHours: readonly WindgramHour[];
  readonly rawTicks: readonly { validAt: string; label: string; x: number; localHourIndex: number | null }[];
  readonly localVisibleTickOffsets: readonly number[];
  readonly uncoveredSpans: readonly { readonly x: number; readonly width: number }[];
  readonly fields: readonly { className: string; path: string }[];
  readonly cloudDeckFields: readonly { className: string; path: string }[];
  readonly skyCoverSpans: readonly SkyCoverSpan[];
  readonly missingMasks: readonly string[];
  readonly contours: WindgramView['contours'];
  readonly localBarbs: readonly WindgramBarb[];
  readonly localClouds: readonly WindgramCloud[];
  readonly cloudBands: WindgramView['cloudBands'];
  readonly localFreezing: readonly { x: number; y: number; hourIndex: number }[];
  readonly seriesSubPaths: ReadonlyMap<string, string>;
}

const MAX_STITCHED_PANEL_CACHE = 16;
const stitchedPanelCache = new Map<string, CachedStitchedPanel>();

function clipPolylineToBounds(points: readonly (Point | null)[], left: number, right: number): string {
  const clipped: (Point | null)[] = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i]!;
    if (!cur) {
      clipped.push(null);
      continue;
    }
    const prev = i > 0 ? points[i - 1]! : null;
    if (prev) {
      let ax = prev.x, ay = prev.y, bx = cur.x, by = cur.y;
      if (Math.max(ax, bx) < left || Math.min(ax, bx) > right) {
        clipped.push(null);
        continue;
      }
      const dx = bx - ax;
      if (dx !== 0) {
        if (ax < left) { ay += ((left - ax) / dx) * (by - ay); ax = left; }
        else if (ax > right) { ay += ((right - ax) / dx) * (by - ay); ax = right; }
        const dx2 = bx - ax;
        if (dx2 !== 0) {
          if (bx < left) { by = ay + ((left - ax) / dx2) * (by - ay); bx = left; }
          else if (bx > right) { by = ay + ((right - ax) / dx2) * (by - ay); bx = right; }
        }
      }
      const last = clipped.at(-1);
      if (!last || Math.abs(last.x - ax) > 0.01 || Math.abs(last.y - ay) > 0.01) {
        if (last) clipped.push(null);
        clipped.push({ x: ax, y: ay });
      }
      clipped.push({ x: bx, y: by });
    } else if (cur.x >= left && cur.x <= right) {
      clipped.push(cur);
    }
  }
  return linearPath(clipped);
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
  const anchorSig = anchors.map(a => `${a.heightM.toFixed(1)}:${a.y.toFixed(1)}`).join(',');

  slices.forEach((slice, panelIdx) => {
    const panelLeft = left + panelIdx * (panelWidth + seamWidth);
    const panelRight = panelLeft + panelWidth;
    const panelHours = slice.selection.hours;
    const stepSource = panelHours.length > 1
      ? panelHours
      : slice.selection.daySource && slice.selection.daySource.length > 1
        ? slice.selection.daySource
        : profile.hours;
    const steps = stepSource
      .slice(1)
      .map((h, i) => Date.parse(h.validAt) - Date.parse(stepSource[i]!.validAt))
      .filter(s => s > 0);
    const effCadence = steps.length ? median(steps) : 3_600_000;
    const rawAlign = Date.parse(profile.hours[0]?.validAt ?? '');
    const effAlign = Number.isFinite(rawAlign) ? ((rawAlign % effCadence) + effCadence) % effCadence : -1;
    const moistureRef = profile.hours[0]?.upperAirDewpointReference ?? '';
    const panelKey = `${profile.model}|${profile.site.latitude}|${profile.site.longitude}|${timeZone}|${slice.dateKey}|${system}|${fieldMode}|${panelLeft}|${panelWidth}|${top}|${bottom}|${anchorSig}|${effCadence}|${effAlign}|${moistureRef}`;

    let built = stitchedPanelCache.get(panelKey);
    if (!built || built.hours.length !== panelHours.length || built.hours.some((h, i) => h !== panelHours[i])) {
      const subPresentation = {
        ...presentation,
        left: panelLeft,
        right: 0,
        plotWidth: panelWidth,
        width: panelLeft + panelWidth,
      };
      const subTime = buildWindgramTimeLayout(profile, slice.selection, subPresentation);
      const colW = subTime.columnWidth;
      const panelSampling = panelHours.map(hourSampling);
      const panelCloudAnalyses = panelHours.map((h, idx) => analyzeHourCloudLayers(h, panelSampling[idx], topM));
      const localViewHours: WindgramHour[] = panelHours.map((h) =>
        toWindgramHour(h, subTime.xAt(Date.parse(h.validAt)), labelTime),
      );

      const rawTicks = [
        ...subTime.emptyTimes.map((t) => ({
          validAt: new Date(t).toISOString(),
          label: formatWindgramHourLabel(t, labelTime),
          x: subTime.xAt(t),
          localHourIndex: null as number | null,
        })),
        ...localViewHours.map(({ validAt, label, x }, localIdx) => ({
          validAt,
          label,
          x,
          localHourIndex: localIdx as number | null,
        })),
      ]
        .filter((tick) => tick.x >= panelLeft && tick.x <= panelRight)
        .sort((a, b) => a.x - b.x);

      const localVisibleTickOffsets = (() => {
        if (rawTicks.length <= 2) return rawTicks.map((_, idx) => idx);
        if (panelWidth < 135) {
          const targets = panelWidth < 82
            ? [panelLeft + panelWidth * 0.28, panelLeft + panelWidth * 0.72]
            : [panelLeft + panelWidth * 0.18, panelLeft + panelWidth * 0.5, panelLeft + panelWidth * 0.82];
          const picked: number[] = [];
          for (const tx of targets) {
            let bestIdx = 0;
            let bestDist = Infinity;
            rawTicks.forEach((t, idx) => {
              const d = Math.abs(t.x - tx);
              if (d < bestDist) { bestDist = d; bestIdx = idx; }
            });
            if (!picked.includes(bestIdx) && (picked.length === 0 || rawTicks[bestIdx]!.x - rawTicks[picked.at(-1)!]!.x >= 21)) {
              picked.push(bestIdx);
            }
          }
          return picked;
        }
        return visibleWindgramHourIndices(
          {
            hours: rawTicks.map((t) => ({ x: Math.max(panelLeft + 10, Math.min(panelRight - 10, t.x)) })),
            compact: true,
          },
          38,
        );
      })();

      const firstData = localViewHours[0];
      const lastData = localViewHours.at(-1);
      const covLeft = firstData ? Math.max(panelLeft, Math.min(panelRight, firstData.x - colW / 2)) : panelRight;
      const covRight = lastData ? Math.max(panelLeft, Math.min(panelRight, lastData.x + colW / 2)) : panelLeft;
      const uncoveredSpans =
        firstData && lastData && covRight > covLeft
          ? [
              { x: panelLeft, width: Math.max(0, covLeft - panelLeft) },
              { x: covRight, width: Math.max(0, panelRight - covRight) },
            ].filter((span) => span.width > 0.5)
          : rawTicks.length
            ? [{ x: panelLeft, width: panelWidth }]
            : [];

      const panelFields: { className: string; path: string }[] = [];
      let panelCloudDecks: { className: string; path: string }[] = [];
      let panelSkySpans: SkyCoverSpan[] = [];
      let missingMasks: string[] = [];
      let panelContours: WindgramView['contours'] = [];
      const localBarbs: WindgramBarb[] = [];
      const localClouds: WindgramCloud[] = [];
      const localCloudBands: WindgramView['cloudBands'] = [];
      const localFreezing: { x: number; y: number; hourIndex: number }[] = [];
      const seriesSubPaths = new Map<string, string>();

      if (panelHours.length) {
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
          panelFields.push(...inversionFields, ...waveFields);
          panelCloudDecks = cloudDeckFields;
          panelFields.push(
            ...buildClimbDomeFieldPaths({
              sourceHours: panelHours,
              viewHours: localViewHours,
              scale,
              columnWidth: colW,
              leftBound: panelLeft,
              rightBound: panelRight,
            }),
          );
          panelSkySpans = buildSkyCoverSpans({
            sourceHours: panelHours,
            sampling: panelSampling,
            viewHours: localViewHours,
            columnWidth: colW,
            leftBound: panelLeft,
            rightBound: panelRight,
            topM,
          });
        } else if (stabilityPixelNodes.some((nodes) => nodes.length)) {
          const stabMap = buildStabilityFieldPaths({
            nodesByHour: stabilityPixelNodes,
            hours: localViewHours,
            columnWidth: colW,
            plotTop: top,
            plotBottom: bottom,
            leftBound: panelLeft,
            rightBound: panelRight,
            banding: {
              breakpoints: WINDGRAM_STABILITY.slice(0, -1).map((c) => c.maxLapse),
              classNames: WINDGRAM_STABILITY.map((c) => `meteo-gram-stab-${c.className}`),
            },
          });
          for (const [className, path] of Object.entries(stabMap)) panelFields.push({ className, path });
        }

        missingMasks = collectMissingFieldMaskPaths({
          stabilityPixelNodes,
          sampling: panelSampling,
          hours: panelHours,
          bounds,
          scale,
          plotHeight,
        });

        panelContours = temperatureContours(
          {
            ...scale,
            plotHeight,
            columnWidth: colW,
            hours: localViewHours,
            sampling: panelSampling,
            leftBound: panelLeft,
            rightBound: panelRight,
          },
          system,
        );

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
          startHourIndex: 0,
          includeBarbAt: (i) => barbHourIndices.has(i),
          barbs: localBarbs,
          freezing: localFreezing,
          clouds: localClouds,
          cloudBands: localCloudBands,
        });

        for (const [key, , , , heightFn] of seriesDefs) {
          const pts = panelHours.map((hour, i): Point | null => {
            const z = heightFn(hour);
            return z === null || z < floorM || z > topM ? null : { x: localViewHours[i]!.x, y: y(z) };
          });
          const subPath = clipPolylineToBounds(pts, panelLeft, panelRight);
          if (subPath) seriesSubPaths.set(key, subPath);
        }
      }

      built = {
        hours: panelHours,
        colW,
        sampling: panelSampling,
        cloudAnalyses: panelCloudAnalyses,
        localViewHours,
        rawTicks,
        localVisibleTickOffsets,
        uncoveredSpans,
        fields: panelFields,
        cloudDeckFields: panelCloudDecks,
        skyCoverSpans: panelSkySpans,
        missingMasks,
        contours: panelContours,
        localBarbs,
        localClouds,
        cloudBands: localCloudBands,
        localFreezing,
        seriesSubPaths,
      };
      if (!stitchedPanelCache.has(panelKey) && stitchedPanelCache.size >= MAX_STITCHED_PANEL_CACHE) {
        const oldest = stitchedPanelCache.keys().next().value;
        if (oldest !== undefined) stitchedPanelCache.delete(oldest);
      }
      stitchedPanelCache.delete(panelKey);
      stitchedPanelCache.set(panelKey, built);
    }

    if (Number.isFinite(built.colW) && built.colW > 0) {
      sumColumnWidths += built.colW;
      columnWidthCount += 1;
    }

    const startHourIndex = viewHours.length;
    for (const h of panelHours) sourceHours.push(h);
    for (const s of built.sampling) sampling.push(s);
    for (const ca of built.cloudAnalyses) {
      cloudLayersByHour.push(ca.layers);
      highCloudOnlyByHour.push(ca.highCloudOnly);
    }
    for (const vh of built.localViewHours) viewHours.push(vh);
    const endHourIndex = viewHours.length - 1;

    const firstAxisIdx = timeAxis.length;
    for (const t of built.rawTicks) {
      timeAxis.push({
        validAt: t.validAt,
        label: t.label,
        x: t.x,
        hourIndex: t.localHourIndex === null ? null : startHourIndex + t.localHourIndex,
      });
    }

    dayPanels.push({
      dateKey: slice.dateKey,
      label: formatShortDayLabel(slice.dateKey),
      isBestDay: options.bestDateKey === slice.dateKey,
      isSelectedDay: options.selectedDateKey === slice.dateKey,
      left: panelLeft,
      width: panelWidth,
      columnWidth: built.colW,
      startHourIndex,
      endHourIndex: panelHours.length ? endHourIndex : -1,
      visibleAxisIndices: built.localVisibleTickOffsets.map((offset) => firstAxisIdx + offset),
      seamX: panelIdx < panelCount - 1 ? panelRight + seamWidth / 2 : null,
      seamWidth: panelIdx < panelCount - 1 ? seamWidth : 0,
      uncoveredSpans: built.uncoveredSpans,
    });

    if (!panelHours.length) return;

    for (const f of built.fields) pushField(f.className, f.path);
    for (const f of built.cloudDeckFields) pushCloudDeck(f.className, f.path);
    skyCoverSpans.push(...built.skyCoverSpans);
    deferredMissingMasks.push(...built.missingMasks);
    contours.push(...built.contours);
    for (const b of built.localBarbs) barbs.push(startHourIndex === 0 ? b : { ...b, hourIndex: startHourIndex + b.hourIndex });
    for (const f of built.localFreezing) freezing.push(startHourIndex === 0 ? f : { ...f, hourIndex: startHourIndex + f.hourIndex });
    for (const c of built.localClouds) clouds.push(startHourIndex === 0 ? c : { ...c, hourIndex: startHourIndex + c.hourIndex });
    cloudBands.push(...built.cloudBands);
    for (const [key, subPath] of built.seriesSubPaths) {
      const list = seriesPaths.get(key);
      if (list) list.push(subPath);
      else seriesPaths.set(key, [subPath]);
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
  const visibleHours = dayPanels.flatMap(panel => {
    if (panel.endHourIndex < panel.startHourIndex) return [];
    const inPanel: number[] = [];
    for (let idx = panel.startHourIndex; idx <= panel.endHourIndex; idx++) {
      const hx = viewHours[idx]!.x;
      if (hx >= panel.left - 0.5 && hx <= panel.left + panel.width + 0.5) inPanel.push(idx);
    }
    return inPanel;
  });
  const selectedHourIndex = visibleHours.reduce(
    (best, index) =>
      (viewHours[index]!.thermalVelocityMps ?? -1) > (viewHours[best]!.thermalVelocityMps ?? -1) ? index : best,
    visibleHours[0] ?? 0,
  );
  const { isUtcFallback, offsetMinutes } = resolveSceneTimeZoneMeta(profile, timeZone, sourceHours[0]);

  return {
    model: profile.model,
    modelHasAnyOmega: profile.hours.some(h => h.levels.some(l => l.omegaPaS !== null && Number.isFinite(l.omegaPaS))),
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
