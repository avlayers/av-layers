import {
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
import { displayedBarbSpeed } from './wind-barb.ts';
import { displayedBarbs, layoutWindgramMarks, type PlacedTemperatureLabel } from './windgram-label-layout.ts';
import { WINDGRAM_STABILITY, WINDGRAM_STABLE_COLOR, stabilityRange } from './windgram-stability.ts';
import { heightToY, visibleHeightAnchors } from './windgram-scale.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import { visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramCloud, WindgramView } from './windgram-view.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const identifier = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');
const text = (x: number, y: number, value: string, attrs = '') =>
  `<text x="${fmt(x)}" y="${fmt(y)}" ${attrs}>${escape(value)}</text>`;
const altitude = (m: number, system: UnitSystem) => Math.round(convertQuantity(m, 'elevation', system)!).toLocaleString('en-US');
const temperature = (f: number, system: UnitSystem) => convertQuantity(fahrenheitToCelsius(f), 'temperature', system)!;
const barbSpeed = (knots: number, system: UnitSystem) => `${displayedBarbSpeed(knotsToMps(knots), system)} ${unitLabel('wind', system)}`;
const degrees = (direction: number) =>
  `${['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(direction / 22.5) % 16]} ${Math.round(direction) % 360}°`;

const styleTag = (stylesheet?: string) => stylesheet ? `<style>${stylesheet}</style>` : '';

function cloudGlyph(cloud: WindgramCloud, scale: number, system: UnitSystem) {
  return `<g class="wg-cloud-symbol" transform="translate(${fmt(cloud.x)} ${fmt(cloud.y)}) scale(${fmt(scale)})"><title>Potential cloud base (surface LCL) · ${altitude(cloud.baseM, system)} ${unitLabel('elevation', system)} MSL</title><path d="${CLOUD_PATH}" class="wg-cloud-potential"/></g>`;
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
  return text(x, 16, `${unitLabel('elevation', system)} MSL`, 'text-anchor="end" class="wg-axis-unit"') +
    text(x, 31, 'Lift w*', 'text-anchor="end" class="wg-lift"') +
    text(x, 42, unitLabel('lift', system), 'text-anchor="end" class="wg-axis-unit"');
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
    const mark = `<path d="M${view.left - 5} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>"/>`;
    return mark + text(view.left - 10, anchor.y - 3, anchor.pressureHpa === null ? '' : formatQuantity(anchor.pressureHpa, 'pressure', undefined, system), 'text-anchor="end" class="wg-axis"');
  }).join('');
  return pressures + altitudes;
}

export function renderWindgramSvg(
  view: WindgramView,
  options: { idPrefix?: string; stylesheet?: string } = {},
): string {
  const system = view.unitSystem;
  const id = identifier(options.idPrefix ?? 'windgram');
  const right = view.left + view.plotWidth;
  const labelX = (x: number) => Math.max(view.left + 12, Math.min(right - 12, x));
  const visibleHours = new Set(visibleWindgramHourIndices({
    hours: view.timeAxis.map(tick => ({ x: labelX(tick.x) })), compact: view.compact,
  }));
  // Cloud outlines show the published parcel base or effective limit.
  const clouds = view.clouds.filter(cloud => cloud.kind === 'potential');
  const cloudScale = windgramCloudScale(view);
  const { barbs, labels } = layoutWindgramMarks(view, cloudScale, clouds,
    displayedBarbs(view, new Set(view.hours.map((_, i) => i))));
  const parts: string[] = [
    styleTag(options.stylesheet),
    `<defs><clipPath id="${id}-plot"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}"/></clipPath><pattern id="${id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a7a4c0"/><path d="M0 0L8 8M-2 6L2 10M6-2L10 2" stroke="#77758f" stroke-width="1"/></pattern><pattern id="${id}-humidity" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M0 8L8" fill="none" stroke="#fff" stroke-width=".8" opacity=".75"/></pattern></defs>`,
    `<rect width="${fmt(view.width)}" height="${fmt(view.height)}" rx="6" fill="${WINDGRAM_STABLE_COLOR}"/>`,
    heightAxisHeader(view, system),
    view.compact ? '' : text(right + 12, view.top - 14, `${unitLabel('elevation', system)} MSL`, 'class="wg-axis-unit"'),
    `<g clip-path="url(#${id}-plot)"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="${WINDGRAM_STABLE_COLOR}"/>`,
  ];
  // Fix humidity hatch path cleanly: M0 0L8 8M0 8L8 0
  parts[1] = `<defs><clipPath id="${id}-plot"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}"/></clipPath><pattern id="${id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a7a4c0"/><path d="M0 0L8 8M-2 6L2 10M6-2L10 2" stroke="#77758f" stroke-width="1"/></pattern><pattern id="${id}-humidity" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M0 8L8 0" fill="none" stroke="#fff" stroke-width=".8" opacity=".75"/></pattern></defs>`;
  for (const field of view.fields) {
    parts.push(
      `<path d="${escape(field.path)}" class="${escape(field.className)}" fill-rule="evenodd"${field.className === 'windgram-missing' ? ` fill="url(#${id}-missing)"` : ''}/>`,
    );
  }
  const firstData = view.hours[0], lastData = view.hours.at(-1);
  const uncovered =
    firstData && lastData
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
  for (const band of view.cloudBands) {
    parts.push(
      `<rect x="${fmt(band.x)}" y="${fmt(band.y)}" width="${fmt(band.width)}" height="${fmt(band.height)}" fill="url(#${id}-humidity)" data-cloud-band="humidity"><title>Interpolated relative humidity of at least ${CLOUD_RH_THRESHOLD_PERCENT}%</title></rect>`,
    );
  }
  for (const hour of view.timeAxis) parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${view.top}" y2="${fmt(view.bottom)}" class="wg-hourline"/>`);
  for (const tick of elevationTicks(view, system)) {
    parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(tick.y)}" y2="${fmt(tick.y)}" class="wg-grid"/>`);
  }
  for (const series of view.series) {
    if (series.path) {
      parts.push(
        `<path d="${escape(series.path)}" fill="none" stroke="${escape(series.color)}" stroke-width="${series.key === 'usableLiftTopM' ? view.presentation.strokes.lift : 1}"${series.dash ? ` stroke-dasharray="${escape(series.dash)}"` : ''} opacity="${series.key === 'usableLiftTopM' ? 1 : 0.55}" data-height-series="${escape(series.key)}"><title>${escape(series.label)}</title></path>`,
      );
    }
    if (series.key === 'usableLiftTopM') {
      for (const hour of view.hours) {
        const z = hour.usableLiftTopM;
        if (z !== null) parts.push(`<circle cx="${fmt(hour.x)}" cy="${fmt(heightToY(view, z))}" r="3.4" class="wg-tol-node" fill="${series.color}" stroke="#ffffff" stroke-width="1.3" data-map-lift-ceiling=""/>`);
      }
    }
  }
  for (const contour of view.contours) {
    parts.push(
      `<path d="${escape(contour.path)}" class="${contour.temperatureF === 32 ? 'wg-isotherm-freezing' : 'wg-isotherm'}" data-temperature-f="${contour.temperatureF}"/>`,
    );
  }
  for (const barb of barbs) {
    const geometry = windBarbGlyph(barb, view.presentation, system);
    const color = barb.speedKt < 9 ? '#78ff78' : '#ffffff';
    const reference = barb.surface
      ? `Model surface · 10 m above model ground (${formatQuantity(view.sourceHours[barb.hourIndex].modelTerrainM, 'elevation', undefined, system)} MSL)`
      : `${formatQuantity(barb.heightM, 'elevation', undefined, system)} MSL · ${barb.interpolated ? 'Interpolated' : 'Model level'}`;
    const windLabel = geometry.calm ? 'Calm' : `${barbSpeed(barb.speedKt, system)} from ${degrees(barb.directionDeg)}`;
    const title = `${windLabel} · ${reference}`;
    const shape = geometry.calm
      ? `<circle r="${CALM_RADIUS}" class="wg-barb-rim"/><circle r="${CALM_RADIUS}" class="wg-barb"/>`
      : ['wg-barb-rim', 'wg-barb'].map(className =>
        `<path d="${geometry.staff}" class="${className}"/>${geometry.flags.map(flag =>
          `<path d="${flag}" class="${className}"${className === 'wg-barb' && flag.endsWith('Z') ? ' style="fill:currentColor"' : ''}/>`
        ).join('')}`
      ).join('');
    parts.push(
      `<g transform="translate(${fmt(barb.x)} ${fmt(barb.y)})" style="color:${color}" class="${barb.interpolated ? 'wg-barb-interpolated' : 'wg-barb-native'}" data-wind-source="${barb.interpolated ? 'interpolated' : 'native'}"><title>${escape(title)}</title>${shape}</g>`,
    );
  }
  parts.push(renderTemperatureLabelsSvg(labels));
  for (const freeze of view.freezing) {
    parts.push(
      `<path d="${SNOWFLAKE_PATH}" transform="translate(${fmt(freeze.x)} ${fmt(freeze.y)})" class="wg-freezing-mark"><title>Lowest freezing level · ${formatQuantity(0, 'temperature', undefined, system)}</title></path>`,
    );
  }
  // Potential cloud-base symbols are outlines so the lapse-rate color stays visible.
  for (const cloud of clouds) parts.push(cloudGlyph(cloud, cloudScale, system));
  parts.push('</g>');
  parts.push(`<rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="none" stroke="#eeebff" stroke-width="1"/>`);
  parts.push(heightAxisLabels(view, system));
  if (!view.compact) {
    for (const tick of elevationTicks(view, system)) {
      parts.push(`<path d="M${fmt(right)} ${fmt(tick.y)}h5" stroke="#fff" stroke-width="1"/>`);
      parts.push(text(right + 10, tick.y + 4, tick.label, 'class="wg-axis-feet"'));
    }
  }
  for (const [axisIndex, tick] of view.timeAxis.entries()) {
    const hour = tick.hourIndex === null ? null : view.hours[tick.hourIndex];
    parts.push(`<line x1="${fmt(tick.x)}" x2="${fmt(tick.x)}" y1="${fmt(view.bottom)}" y2="${fmt(view.bottom + 5)}" stroke="#fff"/>`);
    if (!visibleHours.has(axisIndex)) continue;
    const x = labelX(tick.x);
    parts.push(text(x, 16, tick.label, 'text-anchor="middle" class="wg-hour wg-hour-top"'));
    parts.push(
      text(
        x,
        31,
        hour?.thermalVelocityMps == null ? '—' : `${Number(convertQuantity(hour.thermalVelocityMps, 'lift', system)!.toFixed(system === 'metric' ? 1 : 0))}`,
        'text-anchor="middle" class="wg-lift"',
      ),
    );
    parts.push(text(x, view.bottom + 15, tick.label, 'text-anchor="middle" class="wg-hour"'));
    parts.push(
      text(
        x,
        view.bottom + 28,
        hour?.temperatureF == null ? '—' : `${Math.round(temperature(hour.temperatureF, system))}°`,
        'text-anchor="middle" class="wg-surface-temp"',
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
  parts.push(text(view.width / 2, view.bottom + 41,
    `Wind ${unitLabel('wind', system)} · temperature ${unitLabel('temperature', system)}`,
    'text-anchor="middle" class="wg-axis-unit wg-footer"'));
  parts.push(
    '<g class="wg-inspector" data-windgram-cursor="" visibility="hidden" aria-hidden="true">' +
    '<line data-cursor-vertical=""/><line data-cursor-horizontal=""/>' +
    '<circle data-cursor-tol-ring="" r="6.5" visibility="hidden"/>' +
    '<circle data-cursor-point="" r="7"/>' +
    '<g data-cursor-readout="">' +
    '<rect data-cursor-back="" height="58" rx="7" class="wg-inspector-back"/>' +
    '<text x="10" y="13.5" data-cursor-badge="" class="wg-inspector-badge"/>' +
    '<text x="10" y="27.5" data-cursor-agl="" class="wg-inspector-agl"/>' +
    '<text x="92" y="27.5" data-cursor-msl="" class="wg-inspector-msl"/>' +
    '<text x="10" y="41" data-cursor-meteo="" class="wg-inspector-meteo"/>' +
    '<text x="10" y="53" data-cursor-soar="" class="wg-inspector-soar"/>' +
    '</g></g>',
  );
  const first = view.timeAxis[0], last = view.timeAxis.at(-1)!;
  const coverage = uncovered.length && firstData && lastData ? ` Forecast available ${firstData.label}–${lastData.label}; hatched hours unavailable.` : !view.hours.length ? ' Daylight forecast unavailable in this run.' : '';
  const description = `Windgram${first ? ` ${first.label}–${last.label}` : ''}.${coverage} Height ${unitLabel('elevation', system)} MSL. Wind feathers kt (${unitLabel('wind', system)} readout). Temperature ${unitLabel('temperature', system)}. Lift ${unitLabel('lift', system)}. Crosshatching marks interpolated RH of at least ${CLOUD_RH_THRESHOLD_PERCENT}%. Dark hatching marks unavailable atmosphere. The blue series shows map usable lift.`;
  return `<svg xmlns="${SVG_NS}" width="${fmt(view.width)}" height="${fmt(view.height)}" viewBox="0 0 ${fmt(view.width)} ${fmt(view.height)}" role="img" aria-labelledby="${id}-title ${id}-description" class="windgram${view.compact ? ' windgram-compact' : ''}"><title id="${id}-title">Wind, temperature and clouds by hour and altitude</title><desc id="${id}-description">${escape(description)}</desc>${parts.join('\n')}</svg>`;
}

export function renderWindgramKey(system: UnitSystem, usesDsm = false): string {
  const icon = (content: string, width = 32) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} 22" width="${width}" height="22" aria-hidden="true">${content}</svg>`;
  const humidity = icon(
    `<rect x="2" y="2" width="28" height="18" rx="3" fill="${WINDGRAM_STABLE_COLOR}"/><path d="M4 4L20 19M12 4L28 19M4 19L20 4M12 19L28 4" stroke="#fff" stroke-width="1"/>`,
  );
  const potential = icon(`<path d="${CLOUD_PATH}" transform="translate(16 18) scale(.52)" fill="none" stroke="#93c5fd" stroke-width="1.7" stroke-dasharray="3.5 2.5"/>`);
  const wind = icon(
    '<path d="M8 19L8 3M8 3L18 6.5M8 7.5L13.5 9.5" fill="none" stroke="#78ff78" stroke-width="1.35" stroke-linecap="round"/>' +
    '<path d="M21 19L21 3M21 3L30 6.5M21 7.5L30 11" fill="none" stroke="#f8fafc" stroke-width="1.35" stroke-linecap="round"/>',
  );
  const freezing = icon(
    `<path d="M1 11H31" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="5 3"/><path d="${SNOWFLAKE_PATH}" transform="translate(16 11)" fill="none" stroke="#67e8f9"/>`,
  );
  const lift = icon(
    '<path d="M1 11H31" stroke="#3b82f6" stroke-width="2"/>' +
    '<circle cx="9" cy="11" r="3" fill="#2563eb" stroke="#fff" stroke-width="1.2"/>' +
    '<circle cx="23" cy="11" r="3" fill="#2563eb" stroke="#fff" stroke-width="1.2"/>',
  );
  const missing = icon(
    '<rect x="2" y="2" width="28" height="18" rx="3" fill="#a7a4c0"/>' +
    '<path d="M4 19L19 4M12 19L27 4M4 11L11 4M20 19L27 12" stroke="#5b5875" stroke-width="1.2"/>',
  );
  const feathers = 'half 5 / full 10 / flag 50 kt';
  const greenLimit = formatQuantity(knotsToMps(9), 'wind', undefined, system);
  const lapseUnit = unitLabel('lapseRate', system);
  const segments = WINDGRAM_STABILITY.map(
    ({ color }, i) => `<span class="wg-key-seg" style="background:${color}" title="${escape(`${stabilityRange(i, system)} ${lapseUnit}`)}"></span>`,
  ).join('');
  return (
    `<div class="windgram-legend">` +
    `<div class="wg-key-head"><strong>Visual Chart Key</strong><span>Lapse rate · ${escape(lapseUnit)}</span></div>` +
    `<div class="wg-key-spectrum">` +
    `<div class="wg-key-zones"><span>Strong Thermal</span><span>Unstable</span><span>Marginal</span><span>Stable</span><span>Inversion</span></div>` +
    `<div class="wg-key-bar">${segments}</div>` +
    `<div class="wg-key-ticks"><span>${escape(stabilityRange(0, system))}</span><span>${escape(stabilityRange(2, system))}</span><span>${escape(stabilityRange(4, system))}</span><span>${escape(stabilityRange(5, system))}</span><span>${escape(stabilityRange(7, system))}</span></div>` +
    `</div>` +
    `<div class="wg-key-grid">` +
    `<div class="wg-key-item">${lift}<div><strong>Map usable lift</strong><span>Magnetic Top-of-Lift curve</span></div></div>` +
    `<div class="wg-key-item">${wind}<div><strong>Wind · ${feathers}</strong><span>Green wind is below ${escape(greenLimit)}</span></div></div>` +
    `<div class="wg-key-item">${potential}<div><strong>Cloud base (LCL)</strong><span>Potential cumulus base</span></div></div>` +
    `<div class="wg-key-item">${humidity}<div><strong>Cloud layer</strong><span>RH ≥${CLOUD_RH_THRESHOLD_PERCENT}% moisture</span></div></div>` +
    `<div class="wg-key-item">${freezing}<div><strong>${escape(formatQuantity(0, 'temperature', undefined, system))} freezing</strong><span>Cyan isotherm &amp; freeze mark</span></div></div>` +
    `<div class="wg-key-item">${missing}<div><strong>No forecast data</strong><span>Unavailable hours in run</span></div></div>` +
    `</div>` +
    `<p class="wg-key-foot">Faint barbs are interpolated. Dashed amber marks native parcel top; dashed teal marks effective cloud limit; dashed gray marks surface terrain.${usesDsm ? ' The digital surface model (DSM) includes vegetation and buildings.' : ''}</p>` +
    `</div>`
  );
}
