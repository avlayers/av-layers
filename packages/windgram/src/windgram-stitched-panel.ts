// One cached day panel of a stitched windgram: time ticks, fields, marks, and series clipped to the panel.

import type { HourSampling, PublishedForecastHour as ProfileHour, SiteForecast } from './internal-meteo.ts';
import { buildInversionAndCloudDeckPaths, stabilityPixelNodesForHour, type WindgramFieldMode } from './windgram-atmosphere.ts';
import { buildClimbDomeFieldPaths } from './windgram-climb.ts';
import { analyzeHourCloudLayers, buildSkyCoverSpans, type HourCloudAnalysis, type SkyCoverSpan } from './windgram-clouds.ts';
import type { UnitSystem } from './windgram-format.ts';
import { buildStabilityFieldPaths, temperatureContours } from './windgram-geometry.ts';
import type { WindgramPresentation } from './windgram-presentation.ts';
import { hourSampling, linearPath, type Point } from './windgram-sampling.ts';
import { heightToY, type WindgramScale } from './windgram-vertical.ts';
import { WINDGRAM_STABILITY } from './windgram-stability.ts';
import {
  buildWindgramTimeLayout,
  formatWindgramHourLabel,
  hourX,
  median,
  visibleWindgramHourIndices,
  type selectWindgramHours,
} from './windgram-time-axis.ts';
import {
  collectMissingFieldMaskPaths,
  populateHourColumnMarks,
  toWindgramHour,
  type windgramSeriesDefinitions,
  type WindgramBarb,
  type WindgramCloud,
  type WindgramHour,
  type WindgramView,
} from './windgram-view.ts';

/** Everything a panel depends on; the cache key covers each input that changes its output. */
interface StitchedPanelInput {
  readonly profile: SiteForecast;
  readonly dateKey: string;
  readonly selection: ReturnType<typeof selectWindgramHours>;
  readonly timeZone: string;
  readonly system: UnitSystem;
  readonly fieldMode: WindgramFieldMode;
  readonly hybrid: boolean;
  readonly presentation: WindgramPresentation;
  readonly panelLeft: number;
  readonly panelWidth: number;
  readonly scale: WindgramScale;
  readonly plotHeight: number;
  /** Rounded scale anchors, shared by every panel of one view. */
  readonly anchorSig: string;
  readonly labelTime: Intl.DateTimeFormat;
  readonly seriesDefs: ReturnType<typeof windgramSeriesDefinitions>;
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

/** Returns the cached panel for unchanged inputs and hours, building it otherwise. */
export function stitchedPanel(input: StitchedPanelInput): CachedStitchedPanel {
  const { profile, dateKey, selection, timeZone, system, fieldMode, panelLeft, panelWidth, scale, anchorSig } = input;
  const { top, bottom } = scale;
  const panelHours = selection.hours;
  const stepSource = panelHours.length > 1
    ? panelHours
    : selection.daySource && selection.daySource.length > 1
      ? selection.daySource
      : profile.hours;
  const steps = stepSource
    .slice(1)
    .map((h, i) => Date.parse(h.validAt) - Date.parse(stepSource[i]!.validAt))
    .filter(s => s > 0);
  const effCadence = steps.length ? median(steps) : 3_600_000;
  const rawAlign = Date.parse(profile.hours[0]?.validAt ?? '');
  const effAlign = Number.isFinite(rawAlign) ? ((rawAlign % effCadence) + effCadence) % effCadence : -1;
  const moistureRef = profile.hours[0]?.upperAirDewpointReference ?? '';
  const panelKey = `${profile.model}|${profile.site.latitude}|${profile.site.longitude}|${timeZone}|${dateKey}|${system}|${fieldMode}|${panelLeft}|${panelWidth}|${top}|${bottom}|${anchorSig}|${effCadence}|${effAlign}|${moistureRef}`;

  const cached = stitchedPanelCache.get(panelKey);
  if (cached && cached.hours.length === panelHours.length && cached.hours.every((h, i) => h === panelHours[i])) return cached;
  const built = buildStitchedPanel(input);
  if (!stitchedPanelCache.has(panelKey) && stitchedPanelCache.size >= MAX_STITCHED_PANEL_CACHE) {
    const oldest = stitchedPanelCache.keys().next().value;
    if (oldest !== undefined) stitchedPanelCache.delete(oldest);
  }
  stitchedPanelCache.delete(panelKey);
  stitchedPanelCache.set(panelKey, built);
  return built;
}

function buildStitchedPanel(input: StitchedPanelInput): CachedStitchedPanel {
  const { profile, selection, system, hybrid, presentation, panelLeft, panelWidth, scale, plotHeight, labelTime, seriesDefs } = input;
  const { top, bottom, floorM, topM } = scale;
  const panelRight = panelLeft + panelWidth;
  const panelHours = selection.hours;
  const y = (z: number) => heightToY(scale, z);
  const subPresentation = {
    ...presentation,
    left: panelLeft,
    right: 0,
    plotWidth: panelWidth,
    width: panelLeft + panelWidth,
  };
  const subTime = buildWindgramTimeLayout(profile, selection, subPresentation);
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
      hybrid,
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
        const z = heightFn(hour, floorM);
        return z === null || z < floorM || z > topM ? null : { x: localViewHours[i]!.x, y: y(z) };
      });
      const subPath = clipPolylineToBounds(pts, panelLeft, panelRight);
      if (subPath) seriesSubPaths.set(key, subPath);
    }
  }

  return {
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
}
