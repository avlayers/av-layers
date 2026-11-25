// Multi-day Stitched Daylight Windgram scene builder.
// Crops each day in a 2–3 day window to its solar daylight interval, shares a single
// vertical altitude scale across all panels, and computes climb domes, inversions,
// wave ascent, isotherms, cloud decks, wind barbs, and lift curves per day panel.

import type { HourSampling, PublishedForecastHour as ProfileHour, SiteForecast } from './internal-meteo.ts';
import { formatShortDayLabel } from './point-view-mode.ts';
import type { WindgramCloudLayerSummary, WindgramOptions } from './scene-types.ts';
import { DEFAULT_WINDGRAM_FIELD_MODE, type WindgramFieldMode } from './windgram-atmosphere.ts';
import type { SkyCoverSpan } from './windgram-clouds.ts';
import { gustNoun, type UnitSystem } from './windgram-format.ts';
import { visiblePanelHourIndices } from './windgram-panels.ts';
import { resolveWindgramPresentation } from './windgram-presentation.ts';
import { buildWindgramVerticalScale } from './windgram-scale.ts';
import { stitchedPanel } from './windgram-stitched-panel.ts';
import { selectWindgramHours, type WindgramTimeTick } from './windgram-time-axis.ts';
import {
  formatAltitudeAxisLabels,
  resolveSceneTimeZoneMeta,
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
    const built = stitchedPanel({
      profile,
      dateKey: slice.dateKey,
      selection: slice.selection,
      timeZone,
      system,
      fieldMode,
      hybrid,
      presentation,
      panelLeft,
      panelWidth,
      scale,
      plotHeight,
      anchorSig,
      labelTime,
      seriesDefs,
    });

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
  const visibleHours = visiblePanelHourIndices(dayPanels, viewHours);
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
