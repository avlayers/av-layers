import {
  DEFAULT_WINDGRAM_FIELD_MODE,
  WINDGRAM_HYBRID_SKY_COLOR,
  type WindgramFieldMode,
} from './windgram-atmosphere.ts';
import { cloudGlyph, skyCoverSpanSvg, thinDisplayedClouds } from './windgram-cloud-svg.ts';
import { CLOUD_BKN_RH_PERCENT, CLOUD_SCT_RH_PERCENT } from './windgram-clouds.ts';
import {
  compassDegrees,
  convertQuantity,
  fahrenheitToCelsius,
  formatQuantity,
  knotsToMps,
  elevationTickMeters,
  roundedElevationLabel,
  svgNumber as fmt,
  unitLabel,
  type UnitSystem,
} from './windgram-format.ts';
import { CALM_RADIUS, SNOWFLAKE_PATH, windBarbGlyph, windgramCloudScale } from './windgram-glyphs.ts';
import { displayedBarbSpeed } from './wind-barb.ts';
import { displayedBarbs, layoutWindgramMarks, type PlacedTemperatureLabel } from './windgram-label-layout.ts';
import { escapeMarkup as escape, SVG_NS, svgText as text } from './windgram-markup.ts';
import { panelContainingHour, panelShowsX } from './windgram-panels.ts';
import { WINDGRAM_STABLE_COLOR } from './windgram-stability.ts';
import { visibleHeightAnchors } from './windgram-scale.ts';
import { heightToY } from './windgram-vertical.ts';
import { getWindgramCalloutRenderer, type WindgramCalloutVariant } from './windgram-callout.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import { visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramView } from './windgram-view.ts';
import { windBarbTierClass } from './windgram-wind-tiers.ts';

const identifier = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');
const temperature = (f: number, system: UnitSystem) => convertQuantity(fahrenheitToCelsius(f), 'temperature', system)!;
const barbSpeed = (knots: number, system: UnitSystem) => `${displayedBarbSpeed(knotsToMps(knots), system)} ${unitLabel('wind', system)}`;
const styleTag = (stylesheet?: string) => stylesheet ? `<style>${stylesheet}</style>` : '';

function renderTemperatureLabelsSvg(labels: readonly PlacedTemperatureLabel[]): string {
  return labels
    .map(
      ({ temperatureF, valueText, box, textX, textY, freezing }) =>
        `<g class="wg-temperature-label" data-temperature-f="${temperatureF}"><rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${box.width}" height="${box.height}" rx="2" class="wg-temperature-back"/>${text(textX, textY, valueText, `text-anchor="middle" class="wg-temperature${freezing ? ' wg-temperature-freezing' : ''}"`)}</g>`,
    )
    .join('');
}

function heightAxisHeader(view: WindgramView, system: UnitSystem) {
  const x = view.left - 8;
  return text(x, 15, `${unitLabel('elevation', system)} MSL`, 'text-anchor="end" class="wg-axis-unit"') +
    `<text x="${fmt(x)}" y="29.5" text-anchor="end" class="wg-lift">Lift w*<title>Deardorff convective velocity scale w* (mean thermal strength before glider sink)</title></text>` +
    text(x, 41.5, unitLabel('lift', system), 'text-anchor="end" class="wg-axis-unit"');
}

function elevationTicks(view: WindgramView, system: UnitSystem): { y: number; label: string }[] {
  return elevationTickMeters(view.floorM, view.topM, system, view.plotHeight)
    .map(heightM => ({ y: heightToY(view, heightM), label: roundedElevationLabel(heightM, system) }))
    .filter(tick => tick.label !== '' && tick.y > view.top + 18 && tick.y < view.bottom - 6);
}

function heightAxisLabels(view: WindgramView, system: UnitSystem) {
  const altitudes = elevationTicks(view, system).map(tick => {
    const mark = `<path d="M${view.left - 5} ${fmt(tick.y)}h5" stroke="#fff" stroke-width="1"/>`;
    const label = view.compact ? tick.label : `${tick.label} ${unitLabel('elevation', system)}`;
    return mark + text(view.left - (view.compact ? 9 : 10), tick.y + (view.compact ? 4 : 12), label, `text-anchor="end" class="${view.compact ? 'wg-axis-feet' : 'wg-axis'}"`);
  }).join('');
  if (view.compact) return altitudes;
  const pressures = visibleHeightAnchors(view).map(anchor => {
    const mark = `<path d="M${view.left - 5} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>`;
    return mark + text(view.left - 10, anchor.y - 3, anchor.pressureHpa === null ? '' : formatQuantity(anchor.pressureHpa, 'pressure', undefined, system), 'text-anchor="end" class="wg-axis"');
  }).join('');
  return pressures + altitudes;
}

export function renderWindgramSvg(
  view: WindgramView,
  options: { idPrefix?: string; stylesheet?: string; calloutVariant?: WindgramCalloutVariant } = {},
): string {
  const system = view.unitSystem;
  const fieldMode: WindgramFieldMode = view.fieldMode ?? DEFAULT_WINDGRAM_FIELD_MODE;
  const hybrid = fieldMode === 'hybrid-climb';
  const backdropColor = hybrid ? WINDGRAM_HYBRID_SKY_COLOR : WINDGRAM_STABLE_COLOR;
  const calloutRenderer = getWindgramCalloutRenderer(options.calloutVariant);
  const id = identifier(options.idPrefix ?? 'windgram');
  const right = view.left + view.plotWidth;
  const dayPanels = view.dayPanels;
  const stitched = Boolean(dayPanels && dayPanels.length > 0);
  const labelX = (x: number, panelLeft = view.left, panelRight = right) =>
    Math.max(panelLeft + 10, Math.min(panelRight - 10, x));
  const visibleHours = stitched
    ? new Set(dayPanels!.flatMap(panel => panel.visibleAxisIndices))
    : new Set(visibleWindgramHourIndices({
        hours: view.timeAxis.map(tick => ({ x: labelX(tick.x) })), compact: view.compact,
      }));
  const panelForX = (x: number) => dayPanels?.find(p => panelShowsX(p, x)) ?? null;

  const cloudScale = windgramCloudScale(view);
  const rawClouds = hybrid
    ? view.clouds.filter(cloud => cloud.kind === 'potential' && cloud.cumulus)
    : view.clouds.filter(cloud => cloud.kind === 'potential');
  const clouds = hybrid ? thinDisplayedClouds(rawClouds, cloudScale, dayPanels, view.hours) : rawClouds;
  const laidOut = layoutWindgramMarks(view, cloudScale, clouds,
    displayedBarbs(view, new Set(view.hours.map((_, i) => i))));
  const barbs = laidOut.barbs;
  const labels = stitched
    ? laidOut.labels.filter(({ box }) => !dayPanels!.some(p =>
        p.seamX !== null && box.x < p.seamX + p.seamWidth / 2 + 2 && box.x + box.width > p.seamX - p.seamWidth / 2 - 2))
    : laidOut.labels;
  const parts: string[] = [
    styleTag(options.stylesheet),
    `<defs>` +
      `<clipPath id="${id}-plot"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}"/></clipPath>` +
      `<pattern id="${id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a7a4c0"/><path d="M0 0L8 8M-2 6L2 10M6-2L10 2" stroke="#77758f" stroke-width="1"/></pattern>` +
      `<pattern id="${id}-humidity" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M0 8L8 0" fill="none" stroke="#fff" stroke-width=".8" opacity=".75"/></pattern>` +
      `<pattern id="${id}-cloud-sct" width="16" height="8" patternUnits="userSpaceOnUse"><rect x="1" y="1.4" width="6.2" height="2" rx="1" fill="#e2e8f0" fill-opacity=".38"/><rect x="9.2" y="5.1" width="5.4" height="2" rx="1" fill="#e2e8f0" fill-opacity=".32"/></pattern>` +
      `<pattern id="${id}-cloud-bkn" width="14" height="7" patternUnits="userSpaceOnUse"><rect x="0.5" y="0.9" width="9.4" height="2.3" rx="1.1" fill="#f1f5f9" fill-opacity=".50"/><rect x="3.8" y="4.2" width="9.4" height="2.3" rx="1.1" fill="#f1f5f9" fill-opacity=".46"/></pattern>` +
    `</defs>`,
    `<rect width="${fmt(view.width)}" height="${fmt(view.height)}" rx="6" fill="${WINDGRAM_STABLE_COLOR}"/>`,
    heightAxisHeader(view, system),
    view.compact ? '' : text(right + 12, view.top - 14, `${unitLabel('elevation', system)} MSL`, 'class="wg-axis-unit"'),
    `<g clip-path="url(#${id}-plot)"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="${backdropColor}"/>`,
  ];
  for (const field of view.fields) {
    const fieldTitle = field.className.startsWith('wg-inversion-')
      ? '<title>Temperature inversion (dT/dz &gt; 0) · stable lid resisting vertical mixing</title>'
      : field.className.startsWith('wg-wave-')
        ? '<title>Resolved statically stable model ascent</title>'
        : '';
    parts.push(
      `<path d="${escape(field.path)}" class="${escape(field.className)}" fill-rule="evenodd"${field.className === 'windgram-missing' ? ` fill="url(#${id}-missing)"` : ''}>${fieldTitle}</path>`,
    );
  }
  const firstData = view.hours[0], lastData = view.hours.at(-1);
  const uncovered = stitched
    ? dayPanels!.flatMap(panel => panel.uncoveredSpans)
    : firstData && lastData
      ? [
          { x: view.left, width: firstData.x - view.columnWidth / 2 - view.left },
          { x: lastData.x + view.columnWidth / 2, width: right - lastData.x - view.columnWidth / 2 },
        ].filter(span => span.width > 0.01)
      : view.timeAxis.length ? [{ x: view.left, width: view.plotWidth }] : [];
  for (const span of uncovered) {
    parts.push(
      `<rect x="${fmt(span.x)}" y="${view.top}" width="${fmt(span.width)}" height="${fmt(view.plotHeight)}" fill="url(#${id}-missing)" data-forecast-unavailable=""><title>Forecast unavailable for these hours in this run</title></rect>`,
    );
    if (span.width >= 64) parts.push(text(span.x + span.width / 2, view.top + view.plotHeight / 2, 'Unavailable', 'text-anchor="middle" class="wg-unavailable"'));
  }

  if (hybrid) {
    for (const deck of view.cloudDeckFields ?? []) {
      const ovcAttr = deck.className === 'wg-cloud-deck-ovc' ? ' data-cloud-band="humidity"' : '';
      const fillAttr = deck.className === 'wg-cloud-deck-sct'
        ? ` fill="url(#${id}-cloud-sct)"`
        : deck.className === 'wg-cloud-deck-bkn'
          ? ` fill="url(#${id}-cloud-bkn)"`
          : '';
      const deckTitle = deck.className === 'wg-cloud-deck-ovc'
        ? `Inferred saturated moisture band (RH ≥ ${CLOUD_RH_THRESHOLD_PERCENT}%)`
        : deck.className === 'wg-cloud-deck-bkn'
          ? `Inferred moisture band (RH ${CLOUD_BKN_RH_PERCENT}–<${CLOUD_RH_THRESHOLD_PERCENT}%)`
          : `Inferred moisture band (RH ${CLOUD_SCT_RH_PERCENT}–<${CLOUD_BKN_RH_PERCENT}%)`;
      parts.push(
        `<path d="${escape(deck.path)}" class="${escape(deck.className)}" fill-rule="evenodd"${fillAttr}${ovcAttr}><title>${escape(deckTitle)}</title></path>`,
      );
    }
  } else {
    for (const band of view.cloudBands) {
      parts.push(
        `<rect x="${fmt(band.x)}" y="${fmt(band.y)}" width="${fmt(band.width)}" height="${fmt(band.height)}" fill="url(#${id}-humidity)" data-cloud-band="humidity"><title>Interpolated relative humidity of at least ${CLOUD_RH_THRESHOLD_PERCENT}%</title></rect>`,
      );
    }
  }

  for (const hour of view.timeAxis) parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${view.top}" y2="${fmt(view.bottom)}" class="wg-hourline"/>`);
  for (const tick of elevationTicks(view, system)) {
    parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(tick.y)}" y2="${fmt(tick.y)}" class="wg-grid"/>`);
  }
  for (const series of view.series) {
    if (series.path) {
      if (series.key === 'usableLiftTopM' && hybrid) {
        const coreW = view.presentation.strokes.lift;
        const haloW = Number((coreW + 1.9).toFixed(2));
        parts.push(`<path d="${escape(series.path)}" class="wg-tol-halo" stroke-width="${haloW}" aria-hidden="true"/>`);
        parts.push(
          `<path d="${escape(series.path)}" class="wg-tol-core" stroke-width="${coreW}" data-height-series="${escape(series.key)}"><title>${escape(series.label)}</title></path>`,
        );
      } else if (series.key === 'nativeUsableLiftTopM') {
        parts.push(
          `<path d="${escape(series.path)}" class="wg-tol-native" data-height-series="${escape(series.key)}"><title>${escape(series.label)}</title></path>`,
        );
      } else {
        parts.push(
          `<path d="${escape(series.path)}" fill="none" stroke="${escape(series.color)}" stroke-width="${series.key === 'usableLiftTopM' ? view.presentation.strokes.lift : 1}"${series.dash ? ` stroke-dasharray="${escape(series.dash)}"` : ''} opacity="${series.key === 'usableLiftTopM' ? 1 : 0.5}" data-height-series="${escape(series.key)}"><title>${escape(series.label)}</title></path>`,
        );
      }
    }
    if (series.key === 'usableLiftTopM') {
      const nodeRadius = stitched ? '2.8' : '3.4';
      view.hours.forEach((hour, i) => {
        const z = hour.usableLiftTopM;
        if (z === null) return;
        if (stitched) {
          const panel = panelContainingHour(dayPanels, i);
          if (!panel || !panelShowsX(panel, hour.x)) return;
        }
        parts.push(
          `<circle cx="${fmt(hour.x)}" cy="${fmt(heightToY(view, z))}" r="${nodeRadius}" class="wg-tol-node" fill="${hybrid ? '#0284c7' : series.color}" stroke="#ffffff" stroke-width="1.4" data-map-lift-ceiling=""/>`,
        );
      });
    } else if (series.key === 'nativeUsableLiftTopM') {
      const nodeRadius = stitched ? '2.5' : '3.0';
      view.hours.forEach((hour, i) => {
        if (hour.usableLiftTopM !== null) return;
        if (stitched) {
          const panel = panelContainingHour(dayPanels, i);
          if (!panel || !panelShowsX(panel, hour.x)) return;
        }
        const z = view.sourceHours[i]?.nativeUsableLiftTopM ?? null;
        if (z !== null && z >= view.floorM && z <= view.topM) {
          parts.push(
            `<circle cx="${fmt(hour.x)}" cy="${fmt(heightToY(view, z))}" r="${nodeRadius}" class="wg-tol-native-node" data-native-lift-ceiling=""><title>${escape(series.label)}</title></circle>`,
          );
        }
      });
    }
  }
  for (const contour of view.contours) {
    parts.push(
      `<path d="${escape(contour.path)}" class="${contour.temperatureF === 32 ? 'wg-isotherm-freezing' : 'wg-isotherm'}" data-temperature-f="${contour.temperatureF}"/>`,
    );
  }
  for (const barb of barbs) {
    const geometry = windBarbGlyph(barb, view.presentation, system);
    const tierClass = windBarbTierClass(barb.speedKt, hybrid);
    const reference = barb.surface
      ? `Model surface · 10 m above model ground (${formatQuantity(view.sourceHours[barb.hourIndex].modelTerrainM, 'elevation', undefined, system)} MSL)`
      : `${formatQuantity(barb.heightM, 'elevation', undefined, system)} MSL · ${barb.interpolated ? 'Interpolated' : 'Model level'}`;
    const windLabel = geometry.calm ? 'Calm' : `${barbSpeed(barb.speedKt, system)} from ${compassDegrees(barb.directionDeg)}`;
    const title = `${windLabel} · ${reference}`;
    const shape = geometry.calm
      ? `<circle r="${CALM_RADIUS}" class="wg-barb-rim"/><circle r="${CALM_RADIUS}" class="wg-barb"/>`
      : ['wg-barb-rim', 'wg-barb'].map(className =>
        `<path d="${geometry.staff}" class="${className}"/>${geometry.flags.map(flag =>
          `<path d="${flag}" class="${className === 'wg-barb' && flag.endsWith('Z') ? 'wg-barb wg-barb-flag' : className}"/>`
        ).join('')}`
      ).join('');
    parts.push(
      `<g transform="translate(${fmt(barb.x)} ${fmt(barb.y)})" class="${barb.interpolated ? 'wg-barb-interpolated' : 'wg-barb-native'} ${tierClass}" data-wind-source="${barb.interpolated ? 'interpolated' : 'native'}"><title>${escape(title)}</title>${shape}</g>`,
    );
  }
  parts.push(renderTemperatureLabelsSvg(labels));
  for (const freeze of view.freezing) {
    parts.push(
      `<path d="${SNOWFLAKE_PATH}" transform="translate(${fmt(freeze.x)} ${fmt(freeze.y)})" class="wg-freezing-mark"><title>Lowest freezing level · ${formatQuantity(0, 'temperature', undefined, system)}</title></path>`,
    );
  }
  for (const cloud of clouds) parts.push(cloudGlyph(cloud, cloudScale, system, hybrid));
  if (hybrid && view.skyCoverSpans?.length) {
    for (const span of view.skyCoverSpans) parts.push(skyCoverSpanSvg(span, view));
  }
  if (stitched) {
    for (const panel of dayPanels!) {
      if (panel.seamX !== null && panel.seamWidth > 0) {
        parts.push(
          `<g class="wg-night-seam" data-night-seam=""><title>Overnight hours folded</title>` +
          `<rect x="${fmt(panel.seamX - panel.seamWidth / 2)}" y="${view.top}" width="${fmt(panel.seamWidth)}" height="${fmt(view.plotHeight)}" class="wg-night-seam-fill"/>` +
          `<line x1="${fmt(panel.seamX)}" x2="${fmt(panel.seamX)}" y1="${view.top}" y2="${fmt(view.bottom)}" class="wg-night-seam-line"/>` +
          `<text x="${fmt(panel.seamX)}" y="${fmt(view.top + 11.5)}" text-anchor="middle" class="wg-night-seam-moon">☾</text>` +
          `</g>`,
        );
      }
    }
  }
  parts.push('</g>');
  parts.push(`<rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="none" stroke="#eeebff" stroke-width="1"/>`);
  parts.push(heightAxisLabels(view, system));
  if (!view.compact) {
    for (const tick of elevationTicks(view, system)) {
      parts.push(`<path d="M${fmt(right)} ${fmt(tick.y)}h5" stroke="#fff" stroke-width="1"/>`);
      parts.push(text(right + 10, tick.y + 4, tick.label, 'class="wg-axis-feet"'));
    }
  }
  if (stitched) {
    for (const panel of dayPanels!) {
      const pillX = panel.left + 1.5;
      const pillW = Math.max(16, panel.width - 3);
      const pillCx = pillX + pillW / 2;
      const classes = `wg-day-banner${panel.isSelectedDay ? ' is-selected' : ''}${panel.isBestDay ? ' is-best' : ''}`;
      const pillTitle = `${panel.isBestDay ? '★ ' : ''}${panel.label}`;
      const rankHint = panel.isBestDay ? ' — ★ highest daily thermal score in window (peak lift height, w*, and surface wind)' : '';
      parts.push(
        `<g class="${classes}" data-windgram-day="${escape(panel.dateKey)}" role="button" tabindex="0" aria-label="${escape(`Zoom to ${panel.label} 1-day windgram${rankHint}`)}">` +
        `<title>${escape(`Open ${panel.label} 1-day windgram${rankHint}`)}</title>` +
        `<rect x="${fmt(pillX)}" y="2.5" width="${fmt(pillW)}" height="14" rx="4.5" class="wg-day-banner-pill"/>` +
        text(pillCx, 12.2, pillTitle, 'text-anchor="middle" class="wg-day-banner-label"') +
        `</g>`,
      );
      if (panel.seamX !== null) {
        parts.push(`<line x1="${fmt(panel.seamX)}" x2="${fmt(panel.seamX)}" y1="${fmt(view.bottom)}" y2="${fmt(view.bottom + 28)}" class="wg-night-seam-line"/>`);
      }
    }
  }
  for (const [axisIndex, tick] of view.timeAxis.entries()) {
    const hour = tick.hourIndex === null ? null : view.hours[tick.hourIndex];
    parts.push(`<line x1="${fmt(tick.x)}" x2="${fmt(tick.x)}" y1="${fmt(view.bottom)}" y2="${fmt(view.bottom + 5)}" stroke="#fff"/>`);
    if (!visibleHours.has(axisIndex)) continue;
    const panel = stitched ? panelForX(tick.x) : null;
    const x = panel ? labelX(tick.x, panel.left, panel.left + panel.width) : labelX(tick.x);
    const liftStr = hour?.thermalVelocityMps == null
      ? '—'
      : `${Number(convertQuantity(hour.thermalVelocityMps, 'lift', system)!.toFixed(system === 'metric' ? 1 : 0))}`;
    parts.push(text(x, stitched ? 28 : 16, tick.label, `text-anchor="middle" class="wg-hour wg-hour-top${stitched ? ' wg-hour-stitched' : ''}"`));
    parts.push(text(x, stitched ? 41.5 : 31, liftStr, `text-anchor="middle" class="wg-lift${stitched ? ' wg-lift-stitched' : ''}"`));
    parts.push(text(x, view.bottom + 15, tick.label, `text-anchor="middle" class="wg-hour${stitched ? ' wg-hour-stitched' : ''}"`));
    parts.push(
      text(
        x,
        view.bottom + 28,
        hour?.temperatureF == null ? '—' : `${Math.round(temperature(hour.temperatureF, system))}°`,
        `text-anchor="middle" class="wg-surface-temp${stitched ? ' wg-hour-stitched' : ''}"`,
      ),
    );
  }
  parts.push(
    text(
      view.left - (view.compact ? 8 : 10),
      view.bottom + 28,
      `${view.compact ? 'Sfc' : 'Surface'} ${unitLabel('temperature', system)}`,
      'text-anchor="end" class="wg-axis-unit"',
    ),
  );
  const fineGroundM = view.sourceHours.reduce<number | null>(
    (found, h) => found ?? h.fineTerrainM ?? null,
    null,
  );
  const modelGroundM = view.sourceHours.reduce<number | null>(
    (found, h) => found ?? h.modelTerrainM ?? null,
    null,
  );
  const groundPrefix = fineGroundM !== null
    ? `Ground ${formatQuantity(fineGroundM, 'elevation', undefined, system)} MSL${view.width >= 380 && modelGroundM !== null && Math.abs(fineGroundM - modelGroundM) >= 15 ? ` (model ${formatQuantity(modelGroundM, 'elevation', undefined, system)})` : ''} · `
    : modelGroundM !== null
      ? `Model ground ${formatQuantity(modelGroundM, 'elevation', undefined, system)} MSL · `
      : '';
  parts.push(text(view.width / 2, view.bottom + 41,
    `${groundPrefix}Wind ${unitLabel('wind', system)} · temperature ${unitLabel('temperature', system)}${view.isUtcFallback ? ' · time UTC (fallback)' : ''}`,
    'text-anchor="middle" class="wg-axis-unit wg-footer"'));
  parts.push(
    '<g class="wg-inspector" data-windgram-cursor="" visibility="hidden" aria-hidden="true">' +
    '<line data-cursor-vertical-halo=""/><line data-cursor-horizontal-halo=""/>' +
    '<line data-cursor-vertical=""/><line data-cursor-horizontal=""/>' +
    '<circle data-cursor-tol-ring="" r="6.5" visibility="hidden"/>' +
    '<circle data-cursor-point-halo="" r="7"/>' +
    '<circle data-cursor-point="" r="7"/>' +
    `<g data-cursor-readout="" data-callout-variant="${calloutRenderer.id}">` +
    calloutRenderer.renderSvg() +
    '</g></g>',
  );
  const first = view.timeAxis[0], last = view.timeAxis.at(-1)!;
  const dayDesc = stitched ? ` (${dayPanels!.map(p => p.label).join(', ')})` : '';
  const coverage = uncovered.length && firstData && lastData ? ` Forecast available ${firstData.label}–${lastData.label}; hatched hours unavailable.` : !view.hours.length ? ' Daylight forecast unavailable in this run.' : '';
  const description = `Windgram${dayDesc}${first ? ` ${first.label}–${last.label}` : ''}.${coverage} Height ${unitLabel('elevation', system)} MSL. Wind feathers kt (${unitLabel('wind', system)} readout). Temperature ${unitLabel('temperature', system)}. Lift ${unitLabel('lift', system)}. Dashed moisture bands mark inferred RH ${CLOUD_SCT_RH_PERCENT}–<${CLOUD_RH_THRESHOLD_PERCENT}%; solid frosted bands mark RH ≥ ${CLOUD_RH_THRESHOLD_PERCENT}%; cloud icons mark cumulus and overdevelopment base; top strip marks model sky-cover shade. Dark hatching marks unavailable hours or vertical heights. The haloed curve shows map usable lift.`;
  return `<svg xmlns="${SVG_NS}" width="${fmt(view.width)}" height="${fmt(view.height)}" viewBox="0 0 ${fmt(view.width)} ${fmt(view.height)}" role="img" aria-label="Wind, temperature and clouds by hour and altitude" aria-describedby="${id}-description" class="windgram${hybrid ? ' windgram-hybrid' : ''}${view.compact ? ' windgram-compact' : ''}${stitched ? ' windgram-stitched' : ''}"><desc id="${id}-description">${escape(description)}</desc>${parts.join('\n')}</svg>`;
}
