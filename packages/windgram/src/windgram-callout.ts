// Pluggable SVG hover/inspection callout renderers for Windgram charts.
// To swap the default callout or add a new variant (e.g. 'ribbon' or 'compass'),
// register a WindgramCalloutRenderer in WINDGRAM_CALLOUT_RENDERERS and update
// DEFAULT_WINDGRAM_CALLOUT (or pass `calloutVariant` at mount/render time).

import { FEET_PER_MINUTE_TO_MPS } from '@av/soaring';
import { KPH_PER_MPS } from '@av/contracts/units';
import {
  clamp,
  convertQuantity,
  fahrenheitToCelsius,
  formatQuantity,
  knotsToMps,
  svgNumber as fmt,
  unitLabel,
  type UnitSystem,
} from './windgram-format.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import type { WindgramReading } from './scene-types.ts';
import type { WindgramTelemetryStrip } from './windgram-readout.ts';

export const WINDGRAM_CALLOUT_VARIANTS = ['tile-2x2', 'classic'] as const;
export type WindgramCalloutVariant = (typeof WINDGRAM_CALLOUT_VARIANTS)[number];
export const DEFAULT_WINDGRAM_CALLOUT: WindgramCalloutVariant = 'tile-2x2';

export type ParagliderWindLevel = 'missing' | 'calm' | 'ok' | 'caution' | 'danger';
export type ClimbVisualLevel = 'none' | 'mild' | 'good' | 'strong';

export interface WindgramCalloutPayload {
  readonly aglText: string;
  readonly mslText: string;
  readonly useTol: boolean;
  readonly telemetry: WindgramTelemetryStrip;
  readonly reading: WindgramReading;
  readonly unitSystem: UnitSystem;
}

export interface BoundWindgramCallout {
  paint(payload: WindgramCalloutPayload): { readonly width: number; readonly height: number };
}

export interface WindgramCalloutRenderer {
  readonly id: WindgramCalloutVariant;
  readonly stylesheet: string;
  renderSvg(): string;
  bind(svg: ParentNode | null): BoundWindgramCallout;
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;
const compass16 = (deg: number) => COMPASS_16[Math.round(deg / 22.5) % 16]!;

/** Paraglider wind envelope thresholds: <20 km/h ok, 20–30 km/h caution (trim/rotor), >30 km/h danger. */
export function classifyParagliderWind(speedMps: number | null): ParagliderWindLevel {
  if (speedMps === null || !Number.isFinite(speedMps)) return 'missing';
  const kph = speedMps * KPH_PER_MPS;
  if (kph < 1.5) return 'calm';
  if (kph < 20) return 'ok';
  if (kph <= 30) return 'caution';
  return 'danger';
}

export function classifyClimbLevel(climbMps: number | null): ClimbVisualLevel {
  if (climbMps === null || !Number.isFinite(climbMps) || climbMps < 0.05) return 'none';
  if (climbMps < 1.5) return 'mild';
  if (climbMps <= 3.5) return 'good';
  return 'strong';
}

/** Quantizes 0..100% sky cover into 0..5 oktas-style indicator segments. */
export function cloudOktasSegments(cloudPercent: number | null): number {
  if (cloudPercent === null || !Number.isFinite(cloudPercent) || cloudPercent <= 5) return 0;
  return clamp(Math.ceil(clamp(cloudPercent, 0, 100) / 20), 1, 5);
}

function formatCompactClimb(mps: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const fpm = Math.round((mps / FEET_PER_MINUTE_TO_MPS) / 5) * 5;
    return fpm > 0 ? `+${fpm.toLocaleString('en-US')} fpm` : '0 fpm';
  }
  const rounded = Math.round(mps * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)} m/s` : '0.0 m/s';
}

const setAttr = (el: Element | null, name: string, value: string) => {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
};

const setText = (el: Element | null, value: string) => {
  if (el && el.textContent !== value) el.textContent = value;
};

// ---------------------------------------------------------------------------
// Variant 1: Option B — 2x2 Instrument Tile ('tile-2x2', default)
// Fixed 4-quadrant eye-scan: Wind Vector + PG Thresholds | Vario Climb Gauge
//                            5-Segment Cloud Oktas       | Temp + Cond. Rain
// ---------------------------------------------------------------------------

const TILE_WIDTH = 194;
const TILE_HEIGHT = 84;
const TILE_VARIO_MAX_PX = 21;

const tile2x2Stylesheet = `
.windgram .wg-tile-back { fill: #0f172a; fill-opacity: .96; stroke: #475569; stroke-opacity: .75; stroke-width: .9; }
.windgram .wg-tile-back.is-caution { stroke: #f59e0b; stroke-opacity: .85; }
.windgram .wg-tile-back.is-danger { stroke: #ef4444; stroke-opacity: .9; }
.windgram .wg-tile-divider { stroke: #1e293b; stroke-width: 1; stroke-dasharray: none; }
.windgram .wg-tile-pill { fill: #f59e0b; fill-opacity: .2; stroke: #fbbf24; stroke-opacity: .55; stroke-width: .7; }
.windgram .wg-tile-pill.is-free { fill: #38bdf8; fill-opacity: .16; stroke: #7dd3fc; stroke-opacity: .45; }
.windgram .wg-tile-badge { fill: #fbbf24; font-size: 8.5px; font-weight: 800; letter-spacing: .04em; }
.windgram .wg-tile-badge.is-free { fill: #93c5fd; font-weight: 700; }
.windgram .wg-tile-agl { fill: #f8fafc; font-size: 11.5px; font-weight: 750; }
.windgram .wg-tile-msl { fill: #94a3b8; font-size: 9.5px; font-weight: 600; }
.windgram .wg-tile-cell-tint { fill: transparent; }
.windgram .wg-tile-cell-tint.is-caution { fill: #f59e0b; fill-opacity: .14; }
.windgram .wg-tile-cell-tint.is-danger { fill: #ef4444; fill-opacity: .19; }
.windgram .wg-tile-cell-tint.is-cloud { fill: #0ea5e9; fill-opacity: .17; }
.windgram .wg-tile-cell-tint.is-rain { fill: #0284c7; fill-opacity: .18; }
.windgram .wg-tile-dial { fill: #0b1324; stroke: #4ade80; stroke-width: 1.2; }
.windgram .wg-tile-dial.is-calm, .windgram .wg-tile-dial.is-missing { stroke: #64748b; }
.windgram .wg-tile-dial.is-caution { stroke: #fbbf24; }
.windgram .wg-tile-dial.is-danger { stroke: #f87171; }
.windgram .wg-tile-dial-tick { stroke: #64748b; stroke-width: 1; stroke-dasharray: none; }
.windgram .wg-tile-arrow { fill: #4ade80; stroke: none; }
.windgram .wg-tile-arrow.is-caution { fill: #fbbf24; }
.windgram .wg-tile-arrow.is-danger { fill: #f87171; }
.windgram .wg-tile-calm-dot { fill: none; stroke: #94a3b8; stroke-width: 1.2; }
.windgram .wg-tile-val { fill: #f1f5f9; font-size: 11px; font-weight: 750; }
.windgram .wg-tile-val.is-ok { fill: #4ade80; }
.windgram .wg-tile-val.is-caution { fill: #fbbf24; }
.windgram .wg-tile-val.is-danger { fill: #f87171; }
.windgram .wg-tile-val.is-mild { fill: #86efac; }
.windgram .wg-tile-val.is-good { fill: #4ade80; }
.windgram .wg-tile-val.is-strong { fill: #fbbf24; }
.windgram .wg-tile-val.is-muted { fill: #94a3b8; font-weight: 650; }
.windgram .wg-tile-val.is-freeze { fill: #67e8f9; }
.windgram .wg-tile-sub { fill: #94a3b8; font-size: 9px; font-weight: 650; }
.windgram .wg-tile-sub.is-caution { fill: #fcd34d; }
.windgram .wg-tile-sub.is-danger { fill: #fca5a5; }
.windgram .wg-tile-sub.is-cloud { fill: #7dd3fc; font-weight: 750; }
.windgram .wg-tile-sub.is-rain { fill: #38bdf8; font-weight: 750; }
.windgram .wg-tile-vario-track { fill: #1e293b; }
.windgram .wg-tile-vario-tick { stroke: #475569; stroke-width: .8; stroke-dasharray: none; }
.windgram .wg-tile-vario-fill { fill: #4ade80; }
.windgram .wg-tile-vario-fill.is-strong { fill: #fbbf24; }
.windgram .wg-tile-okta { fill: #1e293b; stroke: #334155; stroke-width: .6; }
.windgram .wg-tile-okta.is-lit { fill: #e2e8f0; stroke: #cbd5e1; }
.windgram .wg-tile-okta.is-cloud { fill: #38bdf8; stroke: #7dd3fc; }
.windgram .wg-tile-drop { fill: #38bdf8; stroke: none; }
`;

const tile2x2Renderer: WindgramCalloutRenderer = {
  id: 'tile-2x2',
  stylesheet: tile2x2Stylesheet,
  renderSvg(): string {
    const oktas = [0, 1, 2, 3, 4]
      .map((i) => `<rect x="${8 + i * 12}" y="58" width="9.5" height="6.5" rx="1.5" data-tile-okta="${i}" class="wg-tile-okta"/>`)
      .join('');
    const varioTicks = [0, 1, 2, 3]
      .map((i) => {
        const ty = fmt(48 - (i / 3) * TILE_VARIO_MAX_PX);
        return `<line x1="101.5" y1="${ty}" x2="103.5" y2="${ty}" class="wg-tile-vario-tick"/>`;
      })
      .join('');
    return (
      `<rect data-cursor-back="" width="${TILE_WIDTH}" height="${TILE_HEIGHT}" rx="8" class="wg-tile-back"/>` +
      // Quadrant background tints (clipped inside inner cells)
      `<rect x="1" y="22.5" width="95.5" height="30" data-tile-wind-bg="" class="wg-tile-cell-tint"/>` +
      `<rect x="1" y="53.5" width="95.5" height="29.5" rx="3" data-tile-cloud-bg="" class="wg-tile-cell-tint"/>` +
      `<rect x="97.5" y="53.5" width="95.5" height="29.5" rx="3" data-tile-rain-bg="" class="wg-tile-cell-tint"/>` +
      // Structural grid hairlines
      `<line x1="0" y1="22" x2="${TILE_WIDTH}" y2="22" class="wg-tile-divider"/>` +
      `<line x1="0" y1="53" x2="${TILE_WIDTH}" y2="53" class="wg-tile-divider"/>` +
      `<line x1="97" y1="22" x2="97" y2="${TILE_HEIGHT}" class="wg-tile-divider"/>` +
      // Header bar: TOL/ALT pill + AGL + right-aligned MSL
      `<rect x="6" y="4.5" width="35" height="13" rx="4" data-tile-badge-pill="" class="wg-tile-pill"/>` +
      `<text x="23.5" y="13.8" text-anchor="middle" data-cursor-badge="" class="wg-tile-badge"/>` +
      `<text x="46" y="14.8" data-cursor-agl="" class="wg-tile-agl"/>` +
      `<text x="${TILE_WIDTH - 6}" y="14.5" text-anchor="end" data-cursor-msl="" class="wg-tile-msl"/>` +
      // Top-Left: Rotating Wind-Vector Compass + Paraglider Speed/Direction
      `<circle cx="18" cy="37.5" r="9.5" data-tile-dial="" class="wg-tile-dial"/>` +
      `<line x1="18" y1="26.8" x2="18" y2="29" class="wg-tile-dial-tick"/>` +
      `<path d="M0 -5.6L3.7 4.6L0 2.3L-3.7 4.6Z" transform="translate(18 37.5)" data-tile-wind-arrow="" class="wg-tile-arrow"/>` +
      `<circle cx="18" cy="37.5" r="3" visibility="hidden" data-tile-wind-calm="" class="wg-tile-calm-dot"/>` +
      `<text x="33" y="35.5" data-tile-wind-speed="" class="wg-tile-val"/>` +
      `<text x="33" y="47.2" data-tile-wind-dir="" class="wg-tile-sub"/>` +
      // Top-Right: Variometer Climb Bar + Rate
      varioTicks +
      `<rect x="104.5" y="27" width="4" height="${TILE_VARIO_MAX_PX}" rx="2" class="wg-tile-vario-track"/>` +
      `<rect x="104.5" y="48" width="4" height="0" rx="2" data-tile-climb-fill="" class="wg-tile-vario-fill"/>` +
      `<text x="113" y="35.5" data-tile-climb-val="" class="wg-tile-val"/>` +
      `<text x="113" y="47.2" data-tile-climb-sub="" class="wg-tile-sub"/>` +
      // Bottom-Left: 5-Segment Sky Cover Oktas Bar + Cloud % / In-Layer
      oktas +
      `<text x="8" y="76.2" data-tile-cloud-text="" class="wg-tile-sub"/>` +
      // Bottom-Right: Temperature + Conditional Precipitation / Shear
      `<text x="105" y="65.2" data-tile-temp="" class="wg-tile-val"/>` +
      `<path d="M108.5 70.2C108.5 70.2 105.5 73.8 105.5 75.6C105.5 77.3 106.8 78.6 108.5 78.6C110.2 78.6 111.5 77.3 111.5 75.6C111.5 73.8 108.5 70.2 108.5 70.2Z" visibility="hidden" data-tile-rain-icon="" class="wg-tile-drop"/>` +
      `<text x="105" y="77.2" data-tile-hazard="" class="wg-tile-sub"/>`
    );
  },
  bind(svg: ParentNode | null): BoundWindgramCallout {
    const q = <T extends Element>(sel: string) => svg?.querySelector<T>(sel) ?? null;
    const back = q<SVGRectElement>('[data-cursor-back]');
    const badgePill = q<SVGRectElement>('[data-tile-badge-pill]');
    const badge = q<SVGTextElement>('[data-cursor-badge]');
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
    const cloudText = q<SVGTextElement>('[data-tile-cloud-text]');
    const rainBg = q<SVGRectElement>('[data-tile-rain-bg]');
    const tempEl = q<SVGTextElement>('[data-tile-temp]');
    const rainIcon = q<SVGPathElement>('[data-tile-rain-icon]');
    const hazardEl = q<SVGTextElement>('[data-tile-hazard]');
    // Optional fallback hooks if a minimal test stub uses classic selectors:
    const legacyMeteo = q<SVGTextElement>('[data-cursor-meteo]');
    const legacySoar = q<SVGTextElement>('[data-cursor-soar]');
    const hasTileDom = Boolean(windSpeed || climbVal || cloudText || tempEl);

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

        // Header badge ('★ TOL' vs 'ALT')
        setText(badge, useTol ? '★ TOL' : 'ALT');
        setAttr(badge, 'class', useTol ? 'wg-tile-badge' : 'wg-tile-badge is-free');
        setAttr(badgePill, 'class', useTol ? 'wg-tile-pill' : 'wg-tile-pill is-free');

        // Quadrant 1: Wind vector + Paraglider safety envelope
        const speedMps = reading.speedKt === null ? null : knotsToMps(reading.speedKt);
        const pgWind = classifyParagliderWind(speedMps);
        setAttr(back, 'class', pgWind === 'danger' ? 'wg-tile-back is-danger' : pgWind === 'caution' ? 'wg-tile-back is-caution' : 'wg-tile-back');
        setAttr(windBg, 'class', pgWind === 'danger' ? 'wg-tile-cell-tint is-danger' : pgWind === 'caution' ? 'wg-tile-cell-tint is-caution' : 'wg-tile-cell-tint');
        setAttr(dial, 'class', `wg-tile-dial is-${pgWind}`);

        if (pgWind === 'missing') {
          setAttr(windArrow, 'visibility', 'hidden');
          setAttr(windCalm, 'visibility', 'hidden');
          setText(windSpeed, '—');
          setAttr(windSpeed, 'class', 'wg-tile-val is-muted');
          setText(windDir, 'No wind');
          setAttr(windDir, 'class', 'wg-tile-sub');
        } else if (pgWind === 'calm') {
          setAttr(windArrow, 'visibility', 'hidden');
          setAttr(windCalm, 'visibility', 'visible');
          setText(windSpeed, 'Calm');
          setAttr(windSpeed, 'class', 'wg-tile-val is-ok');
          setText(windDir, `< 2 ${unitLabel('wind', unitSystem)}`);
          setAttr(windDir, 'class', 'wg-tile-sub');
        } else {
          const dispSpeed = Math.round(convertQuantity(speedMps, 'wind', unitSystem) ?? 0);
          const dir = reading.directionDeg;
          const cardinal = dir === null ? '' : compass16(dir);
          if (dir !== null) {
            const downwindDeg = fmt((dir + 180) % 360);
            setAttr(windArrow, 'transform', `translate(18 37.5) rotate(${downwindDeg})`);
            setAttr(windArrow, 'class', pgWind === 'danger' ? 'wg-tile-arrow is-danger' : pgWind === 'caution' ? 'wg-tile-arrow is-caution' : 'wg-tile-arrow');
            setAttr(windArrow, 'visibility', 'visible');
            setAttr(windCalm, 'visibility', 'hidden');
          } else {
            setAttr(windArrow, 'visibility', 'hidden');
            setAttr(windCalm, 'visibility', 'visible');
          }
          setText(windSpeed, `${dispSpeed} ${unitLabel('wind', unitSystem)}`);
          setAttr(windSpeed, 'class', `wg-tile-val is-${pgWind}`);
          const pgSuffix = pgWind === 'danger' ? ' · Strong' : pgWind === 'caution' ? ' · Caution' : '';
          setText(windDir, `${cardinal}${pgSuffix}` || 'Wind');
          setAttr(windDir, 'class', pgWind === 'danger' ? 'wg-tile-sub is-danger' : pgWind === 'caution' ? 'wg-tile-sub is-caution' : 'wg-tile-sub');
        }

        // Quadrant 2: Variometer Climb Rate + Vertical Bar
        let displayClimbMps: number | null = null;
        let climbCaption = 'No thermal';
        if (useTol) {
          if (reading.estimatedClimbMps !== null && reading.estimatedClimbMps >= 0.08) {
            displayClimbMps = reading.estimatedClimbMps;
            climbCaption = '▲ At TOL';
          } else if (reading.peakClimbMps !== null && reading.peakClimbMps > 0) {
            displayClimbMps = reading.peakClimbMps;
            climbCaption = '▲ Peak lift';
          }
        } else if (reading.estimatedClimbMps !== null) {
          displayClimbMps = reading.estimatedClimbMps >= 0.05 ? reading.estimatedClimbMps : 0;
          climbCaption = displayClimbMps > 0 ? '▲ Thermal' : 'Above lift';
        }
        const climbTier = classifyClimbLevel(displayClimbMps);
        const barFrac = displayClimbMps !== null && displayClimbMps > 0 ? clamp(displayClimbMps / 4.0, 0.08, 1) : 0;
        const barH = fmt(barFrac * TILE_VARIO_MAX_PX);
        setAttr(climbFill, 'y', String(fmt(48 - barFrac * TILE_VARIO_MAX_PX)));
        setAttr(climbFill, 'height', String(barH));
        setAttr(climbFill, 'class', climbTier === 'strong' ? 'wg-tile-vario-fill is-strong' : 'wg-tile-vario-fill');
        if (displayClimbMps === null) {
          setText(climbVal, '—');
          setAttr(climbVal, 'class', 'wg-tile-val is-muted');
          setText(climbSub, 'No thermal');
        } else {
          setText(climbVal, formatCompactClimb(displayClimbMps, unitSystem));
          setAttr(climbVal, 'class', climbTier === 'none' ? 'wg-tile-val is-muted' : `wg-tile-val is-${climbTier}`);
          setText(climbSub, climbCaption);
        }

        // Quadrant 3: 5-Segment Sky Cover Oktas + In-Cloud Layer Alert
        const inCloud = reading.cloud === 'humidity';
        const cloudPct = reading.cloudCoverTotalPercent === null
          ? null
          : Math.round(clamp(reading.cloudCoverTotalPercent, 0, 100));
        const effectivePct = cloudPct ?? (inCloud ? 100 : reading.relativeHumidityPercent !== null && reading.relativeHumidityPercent >= 80 ? Math.round(reading.relativeHumidityPercent) : null);
        const litCount = inCloud ? Math.max(3, cloudOktasSegments(effectivePct)) : cloudOktasSegments(cloudPct);
        setAttr(cloudBg, 'class', inCloud ? 'wg-tile-cell-tint is-cloud' : 'wg-tile-cell-tint');
        for (let i = 0; i < oktas.length; i++) {
          const lit = i < litCount;
          setAttr(oktas[i], 'class', !lit ? 'wg-tile-okta' : inCloud ? 'wg-tile-okta is-cloud' : 'wg-tile-okta is-lit');
        }
        if (inCloud) {
          setText(cloudText, cloudPct !== null ? `IN CLOUD · ${cloudPct}%` : `IN CLOUD (RH ≥${CLOUD_RH_THRESHOLD_PERCENT}%)`);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (cloudPct !== null) {
          setText(cloudText, `Cloud ${cloudPct}%`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (reading.relativeHumidityPercent !== null) {
          setText(cloudText, `RH ${Math.round(reading.relativeHumidityPercent)}%`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else {
          setText(cloudText, 'Sky —');
          setAttr(cloudText, 'class', 'wg-tile-sub');
        }

        // Quadrant 4: Temperature + Conditional Precipitation (or Strong Shear / Dry)
        if (reading.temperatureF == null) {
          setText(tempEl, '—');
          setAttr(tempEl, 'class', 'wg-tile-val is-muted');
        } else {
          const tempC = fahrenheitToCelsius(reading.temperatureF);
          const dispTemp = Math.round(convertQuantity(tempC, 'temperature', unitSystem) ?? 0);
          const freezing = tempC <= 0;
          setText(tempEl, `${freezing ? '❄ ' : ''}${dispTemp}${unitLabel('temperature', unitSystem)}`);
          setAttr(tempEl, 'class', freezing ? 'wg-tile-val is-freeze' : 'wg-tile-val');
        }

        const precipMm = reading.precipitationMmHr;
        const hasRain = precipMm !== null && Number.isFinite(precipMm) && precipMm > 0.04;
        if (hasRain) {
          setAttr(rainBg, 'class', 'wg-tile-cell-tint is-rain');
          setAttr(rainIcon, 'visibility', 'visible');
          setAttr(hazardEl, 'x', '114');
          setText(hazardEl, `Rain ${formatQuantity(precipMm, 'rainRate', undefined, unitSystem)}`);
          setAttr(hazardEl, 'class', 'wg-tile-sub is-rain');
        } else {
          setAttr(rainBg, 'class', 'wg-tile-cell-tint');
          setAttr(rainIcon, 'visibility', 'hidden');
          setAttr(hazardEl, 'x', '105');
          if (reading.windShear !== null && reading.windShear.perKmMps >= 6) {
            setText(hazardEl, `Shear ${reading.windShear.perKmMps.toFixed(1)}/km`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else {
            setText(hazardEl, 'Dry');
            setAttr(hazardEl, 'class', 'wg-tile-sub');
          }
        }

        setAttr(back, 'width', String(TILE_WIDTH));
        setAttr(back, 'height', String(TILE_HEIGHT));
        return { width: TILE_WIDTH, height: TILE_HEIGHT };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Variant 2: Classic 4-Row Text Callout ('classic')
// Kept registered so callers can switch or A/B compare with one option change.
// ---------------------------------------------------------------------------

const classicStylesheet = `
.windgram .wg-inspector-back { fill: #122033; fill-opacity: .95; stroke: #ffffff; stroke-opacity: .55; stroke-width: .75; }
.windgram .wg-inspector-badge { fill: #fbbf24; font-size: 9px; font-weight: 750; letter-spacing: .04em; }
.windgram .wg-inspector-badge.is-free { fill: #93c5fd; font-weight: 700; }
.windgram .wg-inspector-agl { fill: #fff; font-size: 12px; font-weight: 750; }
.windgram .wg-inspector-msl { fill: #94a3b8; font-size: 10.5px; font-weight: 600; }
.windgram .wg-inspector-meteo { fill: #e2e8f0; font-size: 10.5px; font-weight: 600; }
.windgram .wg-inspector-soar { fill: #86efac; font-size: 10.5px; font-weight: 650; }
.windgram .wg-inspector-soar.is-muted { fill: #cbd5e1; font-weight: 600; }
`;

const classicRenderer: WindgramCalloutRenderer = {
  id: 'classic',
  stylesheet: classicStylesheet,
  renderSvg(): string {
    return (
      '<rect data-cursor-back="" height="58" rx="7" class="wg-inspector-back"/>' +
      '<text x="10" y="13.5" data-cursor-badge="" class="wg-inspector-badge"/>' +
      '<text x="10" y="27.5" data-cursor-agl="" class="wg-inspector-agl"/>' +
      '<text x="92" y="27.5" data-cursor-msl="" class="wg-inspector-msl"/>' +
      '<text x="10" y="41" data-cursor-meteo="" class="wg-inspector-meteo"/>' +
      '<text x="10" y="53" data-cursor-soar="" class="wg-inspector-soar"/>'
    );
  },
  bind(svg: ParentNode | null): BoundWindgramCallout {
    const q = <T extends Element>(sel: string) => svg?.querySelector<T>(sel) ?? null;
    const back = q<SVGRectElement>('[data-cursor-back]');
    const badge = q<SVGTextElement>('[data-cursor-badge]');
    const agl = q<SVGTextElement>('[data-cursor-agl]');
    const msl = q<SVGTextElement>('[data-cursor-msl]');
    const meteo = q<SVGTextElement>('[data-cursor-meteo]');
    const soar = q<SVGTextElement>('[data-cursor-soar]');
    const rich = Boolean(badge || meteo || soar);
    return {
      paint({ aglText, mslText, useTol, telemetry }) {
        setText(agl, aglText);
        setText(msl, mslText);
        if (rich && msl) {
          const mslX = aglText ? Math.round(10 + aglText.length * 6.9 + 8) : 10;
          setAttr(msl, 'x', String(mslX));
        }
        setText(badge, telemetry.calloutBadge);
        setAttr(badge, 'class', useTol ? 'wg-inspector-badge' : 'wg-inspector-badge is-free');
        setText(meteo, telemetry.calloutMeteo);
        setText(soar, telemetry.calloutSoar);
        setAttr(soar, 'class', telemetry.hasPositiveClimb ? 'wg-inspector-soar' : 'wg-inspector-soar is-muted');
        const height = rich ? (telemetry.calloutSoar ? 58 : telemetry.calloutMeteo ? 46 : 34) : 47;
        const row2Width = rich
          ? (aglText ? aglText.length * 6.9 + 8 + mslText.length * 5.8 : mslText.length * 6.2)
          : Math.max(aglText.length * 8.2, mslText.length * 5.8);
        const width = Math.ceil(Math.max(
          row2Width,
          rich ? telemetry.calloutBadge.length * 5.8 : 0,
          rich ? telemetry.calloutMeteo.length * 5.8 : 0,
          rich ? telemetry.calloutSoar.length * 5.8 : 0,
        )) + 20;
        if (rich) setAttr(back, 'height', String(height));
        setAttr(back, 'width', String(width));
        return { width, height };
      },
    };
  },
};

export const WINDGRAM_CALLOUT_RENDERERS: Readonly<Record<WindgramCalloutVariant, WindgramCalloutRenderer>> = {
  'tile-2x2': tile2x2Renderer,
  classic: classicRenderer,
};

export function resolveWindgramCalloutVariant(value: string | null | undefined): WindgramCalloutVariant {
  return value === 'classic' || value === 'tile-2x2' ? value : DEFAULT_WINDGRAM_CALLOUT;
}

export function getWindgramCalloutRenderer(variant?: WindgramCalloutVariant): WindgramCalloutRenderer {
  return WINDGRAM_CALLOUT_RENDERERS[variant ?? DEFAULT_WINDGRAM_CALLOUT];
}

export const windgramCalloutStyles = Object.values(WINDGRAM_CALLOUT_RENDERERS)
  .map((renderer) => renderer.stylesheet)
  .join('\n');
