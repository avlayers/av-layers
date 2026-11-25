// Compact 2x2 instrument tile ('tile-2x2', default).
// Light-footprint 204x74 translucent glass tile:
//   Wind Vector + WMO Thresholds       | Vario Climb Gauge + Vertical Motion
//   5-Segment Oktas + METAR + Clear/In | Temp + Dewpoint (Td) + Cues
// Cell content rules live in `windgram-callout-tile-cells.ts` and `windgram-callout-tile-weather.ts`.

import tile2x2Stylesheet from './styles/windgram-callout-tile.css?inline';
import type { BoundWindgramCallout, WindgramCalloutRenderer } from './windgram-callout.ts';
import {
  paintClimbCell,
  paintSkyCell,
  paintWindCell,
  TILE_VARIO_MAX_PX,
  tileConditions,
  type TileElements,
} from './windgram-callout-tile-cells.ts';
import { paintWeatherCell } from './windgram-callout-tile-weather.ts';
import { svgNumber as fmt } from './windgram-format.ts';
import { setAttr, setText } from './windgram-svg-dom.ts';

const TILE_WIDTH = 204;
const TILE_HEIGHT = 74;
const TILE_DIVIDER_X = 103;

export const tile2x2Renderer: WindgramCalloutRenderer = {
  id: 'tile-2x2',
  stylesheet: tile2x2Stylesheet,
  renderSvg(): string {
    const oktas = [0, 1, 2, 3, 4]
      .map((i) => `<rect x="${fmt(7 + i * 9.4)}" y="51" width="7.6" height="5.6" rx="1.2" data-tile-okta="${i}" class="wg-tile-okta"/>`)
      .join('');
    const varioTicks = [0, 1, 2, 3]
      .map((i) => {
        const ty = fmt(42.5 - (i / 3) * TILE_VARIO_MAX_PX);
        return `<line x1="106.5" y1="${ty}" x2="108.5" y2="${ty}" class="wg-tile-vario-tick"/>`;
      })
      .join('');
    return (
      `<rect data-cursor-back="" width="${TILE_WIDTH}" height="${TILE_HEIGHT}" rx="7.5" class="wg-tile-back"/>` +
      `<rect x="1" y="20" width="${TILE_DIVIDER_X - 1.5}" height="26" data-tile-wind-bg="" class="wg-tile-cell-tint"/>` +
      `<rect x="1" y="47" width="${TILE_DIVIDER_X - 1.5}" height="26" rx="3" data-tile-cloud-bg="" class="wg-tile-cell-tint"/>` +
      `<rect x="${TILE_DIVIDER_X + 0.5}" y="47" width="${TILE_WIDTH - TILE_DIVIDER_X - 1.5}" height="26" rx="3" data-tile-rain-bg="" class="wg-tile-cell-tint"/>` +
      `<line x1="0" y1="19.5" x2="${TILE_WIDTH}" y2="19.5" data-tile-div-top="" class="wg-tile-divider"/>` +
      `<line x1="0" y1="46.5" x2="${TILE_WIDTH}" y2="46.5" data-tile-div-mid="" class="wg-tile-divider"/>` +
      `<line x1="${TILE_DIVIDER_X}" y1="19.5" x2="${TILE_DIVIDER_X}" y2="${TILE_HEIGHT}" class="wg-tile-divider"/>` +
      `<rect x="4.5" y="3.8" width="31" height="12" rx="3.8" data-tile-badge-pill="" class="wg-tile-pill"/>` +
      `<text x="20" y="12.5" text-anchor="middle" data-cursor-badge="" class="wg-tile-badge"/>` +
      `<text x="39" y="13.2" data-tile-time="" class="wg-tile-time"/>` +
      `<text x="40" y="13.3" data-cursor-agl="" class="wg-tile-agl"/>` +
      `<text x="${TILE_WIDTH - 5.5}" y="13.2" text-anchor="end" data-cursor-msl="" class="wg-tile-msl"/>` +
      `<circle cx="16.5" cy="33" r="8.5" data-tile-dial="" class="wg-tile-dial"/>` +
      `<line x1="16.5" y1="23.4" x2="16.5" y2="25.3" class="wg-tile-dial-tick"/>` +
      `<path d="M0 -5L3.3 4.1L0 2L-3.3 4.1Z" transform="translate(16.5 33)" data-tile-wind-arrow="" class="wg-tile-arrow"/>` +
      `<circle cx="16.5" cy="33" r="2.7" visibility="hidden" data-tile-wind-calm="" class="wg-tile-calm-dot"/>` +
      `<text x="29.5" y="31.5" data-tile-wind-speed="" class="wg-tile-val"/>` +
      `<text x="29.5" y="42" data-tile-wind-dir="" class="wg-tile-sub"/>` +
      varioTicks +
      `<rect x="109.5" y="24.5" width="3.8" height="${TILE_VARIO_MAX_PX}" rx="1.9" class="wg-tile-vario-track"/>` +
      `<rect x="109.5" y="42.5" width="3.8" height="0" rx="1.9" data-tile-climb-fill="" class="wg-tile-vario-fill"/>` +
      `<text x="117" y="31.5" data-tile-climb-val="" class="wg-tile-val"/>` +
      `<text x="117" y="42" data-tile-climb-sub="" class="wg-tile-sub"/>` +
      oktas +
      `<text x="56" y="56.1" data-tile-sky-code="" class="wg-tile-sky-code"/>` +
      `<text x="7" y="67.6" data-tile-cloud-text="" class="wg-tile-sub"/>` +
      `<text x="110" y="57.5" data-tile-temp="" class="wg-tile-val"/>` +
      `<text x="${TILE_WIDTH - 6}" y="57.2" text-anchor="end" data-tile-dewpoint="" class="wg-tile-td"/>` +
      `<path d="M113 61.6C113 61.6 110.3 64.9 110.3 66.5C110.3 68 111.5 69.2 113 69.2C114.5 69.2 115.7 68 115.7 66.5C115.7 64.9 113 61.6 113 61.6Z" visibility="hidden" data-tile-rain-icon="" class="wg-tile-drop"/>` +
      `<text x="110" y="68" data-tile-hazard="" class="wg-tile-sub"/>`
    );
  },
  bind(svg: ParentNode | null): BoundWindgramCallout {
    const q = <T extends Element>(sel: string) => svg?.querySelector<T>(sel) ?? null;
    const back = q<SVGRectElement>('[data-cursor-back]');
    const badgePill = q<SVGRectElement>('[data-tile-badge-pill]');
    const badge = q<SVGTextElement>('[data-cursor-badge]');
    const timeEl = q<SVGTextElement>('[data-tile-time]');
    const agl = q<SVGTextElement>('[data-cursor-agl]');
    const msl = q<SVGTextElement>('[data-cursor-msl]');
    const windBg = q<SVGRectElement>('[data-tile-wind-bg]');
    const dial = q<SVGCircleElement>('[data-tile-dial]');
    const windArrow = q<SVGPathElement>('[data-tile-wind-arrow]');
    const windCalm = q<SVGCircleElement>('[data-tile-wind-calm]');
    const windSpeed = q<SVGTextElement>('[data-tile-wind-speed]');
    const windDir = q<SVGTextElement>('[data-tile-wind-dir]');
    const climbFill = q<SVGRectElement>('[data-tile-climb-fill]');
    const climbVal = q<SVGTextElement>('[data-tile-climb-val]');
    const climbSub = q<SVGTextElement>('[data-tile-climb-sub]');
    const cloudBg = q<SVGRectElement>('[data-tile-cloud-bg]');
    const oktas = [0, 1, 2, 3, 4].map((i) => q<SVGRectElement>(`[data-tile-okta="${i}"]`));
    const skyCodeEl = q<SVGTextElement>('[data-tile-sky-code]');
    const cloudText = q<SVGTextElement>('[data-tile-cloud-text]');
    const rainBg = q<SVGRectElement>('[data-tile-rain-bg]');
    const tempEl = q<SVGTextElement>('[data-tile-temp]');
    const dewpointEl = q<SVGTextElement>('[data-tile-dewpoint]');
    const rainIcon = q<SVGPathElement>('[data-tile-rain-icon]');
    const hazardEl = q<SVGTextElement>('[data-tile-hazard]');
    const divTop = q<SVGLineElement>('[data-tile-div-top]');
    const divMid = q<SVGLineElement>('[data-tile-div-mid]');
    const legacyMeteo = q<SVGTextElement>('[data-cursor-meteo]');
    const legacySoar = q<SVGTextElement>('[data-cursor-soar]');
    const hasTileDom = Boolean(windSpeed || climbVal || cloudText || tempEl);
    const el: TileElements = {
      back, windBg, dial, windArrow, windCalm, windSpeed, windDir, climbFill, climbVal, climbSub,
      cloudBg, oktas, skyCodeEl, cloudText, rainBg, tempEl, dewpointEl, rainIcon, hazardEl,
    };

    return {
      paint({ aglText, mslText, useTol, telemetry, reading, unitSystem }) {
        setText(agl, aglText);
        setText(msl, mslText);
        if (!hasTileDom) {
          setText(badge, telemetry.calloutBadge);
          setText(legacyMeteo, telemetry.calloutMeteo);
          setText(legacySoar, telemetry.calloutSoar);
          const fallbackWidth = Math.max(aglText.length * 8.2, mslText.length * 5.8, telemetry.calloutSoar.length * 5.8) + 20;
          setAttr(back, 'width', String(Math.ceil(fallbackWidth)));
          return { width: Math.ceil(fallbackWidth), height: legacySoar ? 58 : 47 };
        }

        // Header badge ('★ TOL' vs 'ALT') + hovered hour timestamp
        setText(badge, useTol ? '★ TOL' : 'ALT');
        setAttr(badge, 'class', useTol ? 'wg-tile-badge' : 'wg-tile-badge is-free');
        setAttr(badgePill, 'class', useTol ? 'wg-tile-pill' : 'wg-tile-pill is-free');
        const compactTime = telemetry.compactTime ?? '';
        setText(timeEl, compactTime);
        const aglX = compactTime ? Math.round(39 + compactTime.length * 5.3 + 6) : 40;
        setAttr(agl, 'x', String(aglX));

        const conditions = tileConditions(reading, useTol);
        const wind = paintWindCell(el, reading, unitSystem);
        const displayClimbMps = paintClimbCell(el, reading, conditions, useTol, unitSystem);
        const sky = paintSkyCell(el, reading, conditions, useTol, unitSystem);
        paintWeatherCell(el, reading, conditions, useTol, unitSystem, { ...sky, ...wind, displayClimbMps });
        const { hasRain } = conditions;

        const neededHeaderWidth = compactTime
          ? aglX + aglText.length * 6.4 + mslText.length * 5.4 + 18
          : aglText.length * 6.0 + mslText.length * 5.2 + 52;
        const hazardLen = (hazardEl?.textContent ?? '').length;
        const neededHazardWidth = hasRain ? 118.5 + hazardLen * 5.1 + 8 : 110 + hazardLen * 5.1 + 8;
        const dynamicWidth = Math.max(TILE_WIDTH, Math.min(244, Math.ceil(Math.max(neededHeaderWidth, neededHazardWidth))));
        setAttr(msl, 'x', String(fmt(dynamicWidth - 5.5)));
        setAttr(dewpointEl, 'x', String(fmt(dynamicWidth - 6)));
        setAttr(divTop, 'x2', String(dynamicWidth));
        setAttr(divMid, 'x2', String(dynamicWidth));
        setAttr(rainBg, 'width', String(fmt(dynamicWidth - TILE_DIVIDER_X - 1.5)));
        setAttr(back, 'width', String(dynamicWidth));
        setAttr(back, 'height', String(TILE_HEIGHT));
        return { width: dynamicWidth, height: TILE_HEIGHT };
      },
    };
  },
};
