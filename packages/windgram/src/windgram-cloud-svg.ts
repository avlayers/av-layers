// Cloud base glyphs, their thinning, and the top-of-plot sky-cover strip.

import type { SkyCoverSpan } from './windgram-clouds.ts';
import { convertQuantity, formatQuantity, svgNumber as fmt, unitLabel, type UnitSystem } from './windgram-format.ts';
import { CLOUD_PATH } from './windgram-glyphs.ts';
import { escapeMarkup as escape, svgText as text } from './windgram-markup.ts';
import { panelShowsX } from './windgram-panels.ts';
import type { WindgramCloud, WindgramDayPanel, WindgramView } from './windgram-view.ts';

const altitude = (m: number, system: UnitSystem) => Math.round(convertQuantity(m, 'elevation', system)!).toLocaleString('en-US');

export function cloudGlyph(cloud: WindgramCloud, scale: number, system: UnitSystem, hybrid: boolean) {
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

/** Keeps the strongest cumulus per panel at glyph spacing, dropping glyphs clipped by a narrow panel. */
export function thinDisplayedClouds(
  candidates: readonly WindgramCloud[],
  scale: number,
  dayPanels: readonly WindgramDayPanel[] | undefined,
  hours: WindgramView['hours'],
): WindgramCloud[] {
  if (candidates.length <= 1) return [...candidates];
  const minSpacing = Math.max(20, 38 * scale);
  const panelOf = (x: number) => dayPanels?.findIndex(p => panelShowsX(p, x)) ?? 0;
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

export function skyCoverSpanSvg(span: SkyCoverSpan, view: WindgramView): string {
  const capH = 9.5;
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
  return (
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
    `</g>`
  );
}
