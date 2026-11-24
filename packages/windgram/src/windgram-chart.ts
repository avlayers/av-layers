import { SINK_RATE_MPS } from '@av/soaring';
import {
  climbBandRange,
  CLOUD_BKN_RH_PERCENT,
  CLOUD_SCT_RH_PERCENT,
  DEFAULT_WINDGRAM_FIELD_MODE,
  WIND_SPEED_KNOT_THRESHOLDS,
  windBarbSpeedColor,
  WINDGRAM_CLIMB_BANDS,
  WINDGRAM_HYBRID_SKY_COLOR,
  WINDGRAM_INVERSION_BANDS,
  type WindgramFieldMode,
} from './windgram-atmosphere.ts';
import {
  compass16,
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
import { CALM_RADIUS, CLOUD_PATH, SNOWFLAKE_PATH, windBarbGlyph, windgramCloudScale } from './windgram-glyphs.ts';
import { barbGeometry, displayedBarbSpeed } from './wind-barb.ts';
import { displayedBarbs, layoutWindgramMarks, type PlacedTemperatureLabel } from './windgram-label-layout.ts';
import { WINDGRAM_STABILITY, WINDGRAM_STABLE_COLOR, stabilityRange } from './windgram-stability.ts';
import { heightToY, visibleHeightAnchors } from './windgram-scale.ts';
import { getWindgramCalloutRenderer, type WindgramCalloutVariant } from './windgram-callout.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import { visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramCloud, WindgramDayPanel, WindgramView } from './windgram-view.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const identifier = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');
const text = (x: number, y: number, value: string, attrs = '') =>
  `<text x="${fmt(x)}" y="${fmt(y)}" ${attrs}>${escape(value)}</text>`;
const altitude = (m: number, system: UnitSystem) => Math.round(convertQuantity(m, 'elevation', system)!).toLocaleString('en-US');
const temperature = (f: number, system: UnitSystem) => convertQuantity(fahrenheitToCelsius(f), 'temperature', system)!;
const barbSpeed = (knots: number, system: UnitSystem) => `${displayedBarbSpeed(knotsToMps(knots), system)} ${unitLabel('wind', system)}`;
const degrees = (direction: number) => `${compass16(direction)} ${Math.round(direction) % 360}°`;
const styleTag = (stylesheet?: string) => stylesheet ? `<style>${stylesheet}</style>` : '';

function windBarbTierClass(speedKt: number, hybrid: boolean): string {
  if (!hybrid) return speedKt < 9 ? 'wg-barb-ok' : 'wg-barb-mod';
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.greenMaxKt) return 'wg-barb-ok';
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt) return 'wg-barb-mod';
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt) return 'wg-barb-caution';
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.redMaxKt) return 'wg-barb-danger';
  return 'wg-barb-pennant';
}

function cloudGlyph(cloud: WindgramCloud, scale: number, system: UnitSystem, hybrid: boolean) {
  if (hybrid && cloud.cumulus) {
    const regime = cloud.regime ?? 'cu';
    const isOd = regime === 'od';
    const glaciatedOd = Boolean(isOd && cloud.glaciated && (cloud.depthM ?? (cloud.topM - cloud.baseM)) >= 1500);
    const elevUnit = unitLabel('elevation', system);
    const covTag = cloud.coverageCode ? ` (${cloud.coverageCode}${cloud.coverPercent != null ? ` ${cloud.coverPercent}%` : ''})` : '';
    const depthTag = cloud.depthM && cloud.depthM >= 60 ? ` · ${altitude(cloud.depthM, system)} ${elevUnit} deep` : '';
    const topTempTag = cloud.topTempC != null ? ` · top ${formatQuantity(cloud.topTempC, 'temperature', 0, system)}` : '';
    const capeText = cloud.capeJkg != null && cloud.capeJkg >= 450 ? ` · CAPE ${Math.round(cloud.capeJkg)} J/kg` : '';
    const titlePrefix = glaciatedOd ? 'Overdeveloped cloud · cold top' : isOd ? 'Overdevelopment / spreadout risk' : 'Cumulus cloud base';
    return (
      `<g class="wg-cloud-symbol wg-cloud-active-cu${isOd ? ' wg-cloud-active-od' : ''}${glaciatedOd ? ' wg-cloud-od-glaciated' : ''}" data-cumulus="${regime}" transform="translate(${fmt(cloud.x)} ${fmt(cloud.y)}) scale(${fmt(scale)})">` +
      `<title>${escape(`${titlePrefix}${covTag} · ${altitude(cloud.baseM, system)} ${elevUnit} MSL${depthTag}${topTempTag}${capeText}`)}</title>` +
      `<path d="${CLOUD_PATH}" class="${isOd ? 'wg-cloud-od' : 'wg-cloud-cu'}"/>` +
      `<line x1="${isOd ? -22 : -19}" x2="${isOd ? 23 : 21}" y1="-0.8" y2="-0.8" class="${isOd ? 'wg-cloud-od-base' : 'wg-cloud-cu-base'}"/>` +
      `</g>`
    );
  }
  return `<g class="wg-cloud-symbol" transform="translate(${fmt(cloud.x)} ${fmt(cloud.y)}) scale(${fmt(scale)})"><title>Potential cloud base (surface LCL) · ${altitude(cloud.baseM, system)} ${unitLabel('elevation', system)} MSL</title><path d="${CLOUD_PATH}" class="wg-cloud-potential"/></g>`;
}

function thinDisplayedClouds(
  candidates: readonly WindgramCloud[],
  scale: number,
  dayPanels: readonly WindgramDayPanel[] | undefined,
  hours: WindgramView['hours'],
): WindgramCloud[] {
  if (candidates.length <= 1) return [...candidates];
  const minSpacing = Math.max(20, 38 * scale);
  const panelOf = (x: number) => dayPanels?.findIndex(p => x >= p.left - 0.5 && x <= p.left + p.width + 0.5) ?? 0;
  const regimeRank = (c: WindgramCloud) => (c.regime === 'od' ? 1 : 0);
  const prioritized = [...candidates].sort(
    (a, b) =>
      regimeRank(b) - regimeRank(a) ||
      (hours[b.hourIndex]?.thermalVelocityMps ?? 0) - (hours[a.hourIndex]?.thermalVelocityMps ?? 0),
  );
  const kept: WindgramCloud[] = [];
  for (const c of prioritized) {
    const pIdx = panelOf(c.x);
    const panel = dayPanels?.[pIdx];
    const halfW = 24 * scale;
    if (panel && (c.x - halfW < panel.left + 1 || c.x + halfW > panel.left + panel.width - 1)) {
      if (panel.width < halfW * 2.1) continue;
    }
    if (kept.every(other => panelOf(other.x) !== pIdx || Math.abs(other.x - c.x) >= minSpacing)) {
      kept.push(c);
    }
  }
  return kept.sort((a, b) => a.x - b.x);
}

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
  const panelForX = (x: number) => dayPanels?.find(p => x >= p.left - 0.5 && x <= p.left + p.width + 0.5) ?? null;

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
          const panel = dayPanels!.find(p => p.endHourIndex >= p.startHourIndex && i >= p.startHourIndex && i <= p.endHourIndex);
          if (!panel || hour.x < panel.left - 0.5 || hour.x > panel.left + panel.width + 0.5) return;
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
          const panel = dayPanels!.find(p => p.endHourIndex >= p.startHourIndex && i >= p.startHourIndex && i <= p.endHourIndex);
          if (!panel || hour.x < panel.left - 0.5 || hour.x > panel.left + panel.width + 0.5) return;
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
    const windLabel = geometry.calm ? 'Calm' : `${barbSpeed(barb.speedKt, system)} from ${degrees(barb.directionDeg)}`;
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
    const capH = 9.5;
    for (const span of view.skyCoverSpans) {
      const highOnly = Boolean(span.highLevelOnly);
      const tierLabel = highOnly
        ? `High ${span.tier === 'ovc' ? 'overcast' : 'broken'} cirrus above chart`
        : span.tier === 'ovc'
          ? 'Overcast'
          : 'Broken';
      const cx = span.x + span.width / 2;
      const badgeLabel = highOnly ? 'HI OVC' : 'OVC';
      const pillHalfW = highOnly ? 16.5 : 12;
      const minSpanForBadge = highOnly ? 38 : 34;
      parts.push(
        `<g class="wg-sky-cover" data-sky-cover="${span.tier}"${highOnly ? ' data-sky-high="true"' : ''}>` +
        `<title>${escape(`${tierLabel} (up to ${Math.round(span.coverPercent)}%)`)}</title>` +
        `<rect x="${fmt(span.x)}" y="${view.top}" width="${fmt(span.width)}" height="${capH}" class="${highOnly ? 'wg-sky-high' : `wg-sky-${span.tier}`}"/>` +
        (span.tier === 'ovc'
          ? `<line x1="${fmt(span.x)}" x2="${fmt(span.x + span.width)}" y1="${fmt(view.top + capH)}" y2="${fmt(view.top + capH)}" class="${highOnly ? 'wg-sky-high-edge' : 'wg-sky-ovc-edge'}"/>` +
            (span.width >= minSpanForBadge
              ? `<rect x="${fmt(cx - pillHalfW)}" y="${fmt(view.top + 0.8)}" width="${pillHalfW * 2}" height="7.9" rx="2.2" class="wg-sky-label-back"/>` +
                text(cx, view.top + 7.2, badgeLabel, 'text-anchor="middle" class="wg-sky-label"')
              : '')
          : '') +
        `</g>`,
      );
    }
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

function renderKeyWindStrip(fieldMode: WindgramFieldMode, southernHemisphere = false): string {
  const hybrid = fieldMode === 'hybrid-climb';
  const colorFor = (kt: number) => (hybrid ? windBarbSpeedColor(kt) : kt < 9 ? '#78ff78' : '#ffffff');
  const samples = [
    { kt: 0, x: 14, label: '0' },
    { kt: 5, x: 38, label: '5' },
    { kt: 10, x: 64, label: '10' },
    { kt: 15, x: 92, label: '15' },
    { kt: 50, x: 122, label: '50 kt' },
  ] as const;
  const glyphs = samples
    .map(({ kt, x, label }) => {
      const geo = barbGeometry(kt, 0, 14, southernHemisphere);
      const color = colorFor(kt);
      const body = geo.calm
        ? `<circle r="${CALM_RADIUS}" fill="none" stroke="${color}" stroke-width="1.35"/>`
        : `<path d="${geo.staff}" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round"/>` +
          geo.flags
            .map(flag =>
              flag.endsWith('Z')
                ? `<path d="${flag}" fill="${color}" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>`
                : `<path d="${flag}" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round"/>`,
            )
            .join('');
      return (
        `<g transform="translate(${x} 18)" data-key-barb="${kt}">${body}</g>` +
        `<text x="${x}" y="29" text-anchor="middle" fill="#cbd5e1" font-size="8.5" font-family="ui-sans-serif,system-ui,sans-serif">${label}</text>`
      );
    })
    .join('');
  // Downwind hover-dial arrow sample (wind from N = 0°: barb points up toward N source, hover arrow points down S downwind)
  const dialSample =
    '<g transform="translate(162 12)" data-key-hover-dial="">' +
    '<circle cx="0" cy="0" r="7.5" fill="#0f1b2d" stroke="#64748b" stroke-width="1"/>' +
    '<path d="M0 -4.4L2.9 3.6L0 1.8L-2.9 3.6Z" transform="rotate(180)" fill="#f8fafc"/>' +
    '</g>' +
    '<text x="162" y="29" text-anchor="middle" fill="#cbd5e1" font-size="8.5" font-family="ui-sans-serif,system-ui,sans-serif">hover</text>';
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 184 32" width="184" height="32" class="wg-key-wind-svg" aria-hidden="true">${glyphs}${dialSample}</svg>`;
}

const LAPSE_SHORT_LABELS = [
  'Strong',
  'Good',
  'Unstable',
  'Weak',
  'Marginal',
  'Stable',
  'Weak inv',
  'Inversion',
] as const;

const CLIMB_SHORT_LABELS = ['Marginal', 'Light', 'Moderate', 'Good', 'Strong', 'Booming'] as const;

export function renderWindgramKey(
  system: UnitSystem,
  usesDsm = false,
  fieldMode: WindgramFieldMode = DEFAULT_WINDGRAM_FIELD_MODE,
  southernHemisphere = false,
): string {
  const icon = (content: string, width = 32) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} 22" width="${width}" height="22" aria-hidden="true">${content}</svg>`;
  const feathers = 'half 5 / full 10 / flag 50 kt';
  const lapseGreenLimit = formatQuantity(knotsToMps(9), 'wind', undefined, system);
  const freezing = icon(
    `<path d="M1 11H31" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="5 3"/><path d="${SNOWFLAKE_PATH}" transform="translate(16 11)" fill="none" stroke="#67e8f9"/>`,
  );
  const missing = icon(
    '<rect x="2" y="2" width="28" height="18" rx="3" fill="#a7a4c0"/>' +
    '<path d="M4 19L19 4M12 19L27 4M4 11L11 4M20 19L27 12" stroke="#5b5875" stroke-width="1.2"/>',
  );
  const windStrip = renderKeyWindStrip(fieldMode, southernHemisphere);

  if (fieldMode === 'lapse') {
    const humidity = icon(
      `<rect x="2" y="2" width="28" height="18" rx="3" fill="${WINDGRAM_STABLE_COLOR}"/><path d="M4 4L20 19M12 4L28 19M4 19L20 4M12 19L28 4" stroke="#fff" stroke-width="1"/>`,
    );
    const potential = icon(`<path d="${CLOUD_PATH}" transform="translate(16 18) scale(.52)" fill="none" stroke="#93c5fd" stroke-width="1.7" stroke-dasharray="3.5 2.5"/>`);
    const lift = icon(
      '<path d="M1 11H31" stroke="#3b82f6" stroke-width="2"/>' +
      '<circle cx="9" cy="11" r="3" fill="#2563eb" stroke="#fff" stroke-width="1.2"/>' +
      '<circle cx="23" cy="11" r="3" fill="#2563eb" stroke="#fff" stroke-width="1.2"/>',
    );
    const lapseUnit = unitLabel('lapseRate', system);
    const lapseCells = WINDGRAM_STABILITY.map(({ className }, i) => {
      const range = stabilityRange(i, system);
      const shortName = LAPSE_SHORT_LABELS[i] ?? `Band ${i + 1}`;
      return (
        `<div class="wg-key-band" role="listitem" tabindex="0" aria-label="${escape(`${shortName}: ${range} ${lapseUnit}`)}">` +
        `<span class="wg-key-band-lbl">${escape(shortName)}</span>` +
        `<span class="wg-key-seg meteo-gram-stab-${escape(className)}"></span>` +
        `<span class="wg-key-band-rng">${escape(range)}</span>` +
        `</div>`
      );
    }).join('');
    return (
      `<div class="windgram-legend">` +
      `<div class="wg-key-head"><strong>Visual Chart Key</strong><span>Lapse rate · ${escape(lapseUnit)}</span></div>` +
      `<div class="wg-key-spectrum">` +
      `<div class="wg-key-bands wg-key-bands-4" role="list" aria-label="Environmental lapse rate bands">${lapseCells}</div>` +
      `</div>` +
      `<div class="wg-key-wind-box">` +
      `<div class="wg-key-wind-copy"><strong>Wind · ${feathers} (15 = 10 + 5 kt)</strong><span>Green wind is below ${escape(lapseGreenLimit)}; white ≥${escape(lapseGreenLimit)}. Barb points to wind source; hover arrow points downwind.</span></div>` +
      windStrip +
      `</div>` +
      `<div class="wg-key-grid">` +
      `<div class="wg-key-item">${lift}<div><strong>Map usable lift</strong><span>Magnetic Top-of-Lift curve</span></div></div>` +
      `<div class="wg-key-item">${potential}<div><strong>Cloud base (LCL)</strong><span>Potential cumulus base</span></div></div>` +
      `<div class="wg-key-item">${humidity}<div><strong>Moisture layer</strong><span>Inferred RH ≥${CLOUD_RH_THRESHOLD_PERCENT}%</span></div></div>` +
      `<div class="wg-key-item">${freezing}<div><strong>${escape(formatQuantity(0, 'temperature', undefined, system))} freezing</strong><span>Cyan isotherm &amp; freeze mark</span></div></div>` +
      `<div class="wg-key-item">${missing}<div><strong>Missing data</strong><span>Unavailable hours or heights</span></div></div>` +
      `</div>` +
      `<details class="wg-key-more"><summary>More chart details</summary>` +
      `<p class="wg-key-foot">Faint barbs are interpolated between native model levels. Dashed amber marks native parcel top; dashed teal marks effective cloud limit; dashed gray marks fine terrain.${usesDsm ? ' The digital surface model (DSM) includes vegetation and buildings.' : ''}</p>` +
      `</details>` +
      `</div>`
    );
  }

  const greenLimit = formatQuantity(knotsToMps(WIND_SPEED_KNOT_THRESHOLDS.greenMaxKt), 'wind', undefined, system);
  const yellowLimit = formatQuantity(knotsToMps(WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt), 'wind', 0, system);
  const redLimit = formatQuantity(knotsToMps(WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt), 'wind', 0, system);
  const pennantLimit = formatQuantity(knotsToMps(WIND_SPEED_KNOT_THRESHOLDS.redMaxKt), 'wind', 0, system);
  const liftUnit = unitLabel('lift', system);
  const sinkLabel = formatQuantity(SINK_RATE_MPS, 'lift', system === 'metric' ? 1 : 0, system);
  const climbCells = WINDGRAM_CLIMB_BANDS.map(({ className, label }, i) => {
    const range = climbBandRange(i, system);
    const shortName = CLIMB_SHORT_LABELS[i] ?? label;
    return (
      `<div class="wg-key-band" role="listitem" tabindex="0" aria-label="${escape(`${label}: ${range} ${liftUnit}`)}">` +
      `<span class="wg-key-band-lbl">${escape(shortName)}</span>` +
      `<span class="wg-key-seg ${escape(className)}"></span>` +
      `<span class="wg-key-band-rng">${escape(range)}</span>` +
      `</div>`
    );
  }).join('');

  const lift = icon(
    '<path d="M1 12H31" stroke="#f8fafc" stroke-width="3.6" stroke-linecap="round"/>' +
    '<path d="M1 12H31" stroke="#0f3a6d" stroke-width="1.9" stroke-linecap="round"/>' +
    '<circle cx="9" cy="12" r="3" fill="#0284c7" stroke="#fff" stroke-width="1.3"/>' +
    '<circle cx="23" cy="12" r="3" fill="#0284c7" stroke="#fff" stroke-width="1.3"/>',
  );
  const nativeLift = icon(
    '<path d="M1 12H31" stroke="#7dd3fc" stroke-width="1.8" stroke-dasharray="5 3" stroke-linecap="round"/>' +
    '<circle cx="16" cy="12" r="2.8" fill="#0f172a" stroke="#7dd3fc" stroke-width="1.4"/>',
  );
  const cumulus = icon(
    `<path d="${CLOUD_PATH}" transform="translate(9.5 16.5) scale(.38)" fill="#f8fafc" stroke="#475569" stroke-width="1.6"/>` +
    '<line x1="2.5" x2="17" y1="16.2" y2="16.2" stroke="#64748b" stroke-width="1.5" stroke-linecap="round"/>' +
    `<path d="${CLOUD_PATH}" transform="translate(22.5 16.5) scale(.38)" fill="#64748b" stroke="#0f172a" stroke-width="1.9"/>` +
    '<line x1="14" x2="31" y1="16.2" y2="16.2" stroke="#0f172a" stroke-width="1.8" stroke-linecap="round"/>',
  );
  const cloudDeck = icon(
    `<rect x="2" y="2" width="28" height="18" rx="3" fill="${WINDGRAM_HYBRID_SKY_COLOR}"/>` +
    '<rect x="2" y="2" width="28" height="3.8" rx="1.2" fill="#94a3b8" fill-opacity=".85"/>' +
    '<rect x="4" y="8.2" width="8" height="2" rx="1" fill="#e2e8f0" fill-opacity=".52"/>' +
    '<rect x="16" y="8.2" width="10" height="2" rx="1" fill="#e2e8f0" fill-opacity=".52"/>' +
    '<path d="M2 15C8 13.5 15 13 30 14.2L30 20L2 20Z" fill="#f8fafc" fill-opacity=".68"/>',
  );
  const ascentIcon = icon(
    `<rect x="2" y="2" width="28" height="18" rx="3" fill="${WINDGRAM_HYBRID_SKY_COLOR}"/>` +
    `<rect x="2" y="12" width="28" height="6" fill="${WINDGRAM_INVERSION_BANDS[1].color}" fill-opacity=".75"/>` +
    '<ellipse cx="16" cy="6.5" rx="10" ry="3.2" fill="#38bdf8" fill-opacity=".42" stroke="none"/>',
  );

  return (
    `<div class="windgram-legend">` +
    `<div class="wg-key-head"><strong>Visual Chart Key</strong><span>Net climb · ${escape(liftUnit)} (includes ${escape(sinkLabel)} sink)</span></div>` +
    `<div class="wg-key-spectrum">` +
    `<div class="wg-key-bands wg-key-bands-6" role="list" aria-label="Net thermal climb bands">${climbCells}</div>` +
    `<div class="wg-key-backdrops">` +
    `<span class="wg-key-chip"><i class="wg-key-sky-swatch"></i>Neutral sky</span>` +
    `<span class="wg-key-chip"><i class="wg-key-inv-swatch"></i>Inversion lid (dT/dz &gt; 0)</span>` +
    `</div>` +
    `</div>` +
    `<div class="wg-key-wind-box">` +
    `<div class="wg-key-wind-copy"><strong>Wind · ${feathers} (15 = 10 + 5 kt)</strong><span>Green wind is below ${escape(greenLimit)} · yellow ≥${escape(yellowLimit)} · red ≥${escape(redLimit)} · magenta ≥${escape(pennantLimit)}. Barb points to wind source; hover arrow points downwind.</span></div>` +
    windStrip +
    `</div>` +
    `<div class="wg-key-grid">` +
    `<div class="wg-key-item">${lift}<div><strong>Map usable lift</strong><span>Magnetic Top-of-Lift curve</span></div></div>` +
    `<div class="wg-key-item">${nativeLift}<div><strong>Native lift estimate</strong><span>Dashed ceiling beyond map hours</span></div></div>` +
    `<div class="wg-key-item">${cumulus}<div><strong>Cu &amp; OD</strong><span>Cumulus base &amp; spreadout risk</span></div></div>` +
    `<div class="wg-key-item">${cloudDeck}<div><strong>Inferred moisture</strong><span>RH ${CLOUD_SCT_RH_PERCENT}–&lt;${CLOUD_BKN_RH_PERCENT}%, ${CLOUD_BKN_RH_PERCENT}–&lt;${CLOUD_RH_THRESHOLD_PERCENT}%, ≥${CLOUD_RH_THRESHOLD_PERCENT}%</span></div></div>` +
    `<div class="wg-key-item">${ascentIcon}<div><strong>Modeled ascent aloft</strong><span>Cyan ascent; indigo inversion lid</span></div></div>` +
    `<div class="wg-key-item">${freezing}<div><strong>${escape(formatQuantity(0, 'temperature', undefined, system))} freezing</strong><span>Cyan isotherm &amp; freeze mark</span></div></div>` +
    `<div class="wg-key-item">${missing}<div><strong>Missing data</strong><span>Unavailable hours or heights</span></div></div>` +
    `</div>` +
    `<details class="wg-key-more"><summary>More chart details</summary>` +
    `<p class="wg-key-foot">Dome colors show Lenschow net thermal climb (already subtracting ${escape(sinkLabel)} glider sink). Top cap strip marks model sky cover. Faint barbs are interpolated; dashed pink marks surface LCL; dashed amber marks parcel top; dashed teal marks cloud limit; dashed slate marks model ground when above site ground.${usesDsm ? ' The digital surface model (DSM) includes vegetation and buildings.' : ''}</p>` +
    `</details>` +
    `</div>`
  );
}
