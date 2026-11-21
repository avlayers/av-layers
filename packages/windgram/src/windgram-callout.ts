// Pluggable SVG hover/inspection callout renderers and anti-clobber sky-pocket
// placement for Windgram charts.
// To swap the default callout or add a new variant (e.g. 'ribbon' or 'compass'),
// register a WindgramCalloutRenderer in WINDGRAM_CALLOUT_RENDERERS and update
// DEFAULT_WINDGRAM_CALLOUT (or pass `calloutVariant` at mount/render time).

import { FEET_PER_MINUTE_TO_MPS } from '@av/soaring';
import { MPH_PER_MPS } from '@av/contracts/units';
import {
  HIGH_INSTABILITY_CAPE_JKG,
  skyCoverageCode,
  WAVE_MIN_LAPSE_C_PER_1000FT,
  WAVE_MIN_WIND_KT,
  WIND_SPEED_KNOT_THRESHOLDS,
} from './windgram-atmosphere.ts';
import {
  clamp,
  convertQuantity,
  fahrenheitToCelsius,
  formatQuantity,
  knotsToMps,
  METRES_PER_THOUSAND_FEET,
  mpsToKnots,
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

export type ParagliderWindLevel = 'missing' | 'calm' | 'ok' | 'moderate' | 'caution' | 'danger' | 'pennant';
export type ClimbVisualLevel = 'none' | 'mild' | 'good' | 'strong';
export type CalloutHorizontalSide = 'left' | 'right';

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

export interface CalloutPlacementInput {
  readonly cursorX: number;
  readonly cursorY: number;
  readonly width: number;
  readonly height: number;
  readonly bounds: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** Optional convective dome ceiling Y per visible hour (smaller Y = higher in sky). */
  readonly ceilingSamples?: readonly { readonly x: number; readonly ceilingY: number | null }[];
  readonly preferredSide?: CalloutHorizontalSide;
}

export interface CalloutPlacementResult {
  readonly x: number;
  readonly y: number;
  readonly side: CalloutHorizontalSide;
}

/**
 * Places the floating hover callout inside `bounds` while minimizing occlusion of:
 * 1) The active cursor crosshair bullseye `(cursorX, cursorY)`
 * 2) The active convective thermal dome (`y >= ceilingY`)
 * 3) Rapid side-flipping during smooth horizontal scrubbing (`preferredSide` hysteresis)
 */
export function placeWindgramCallout(input: CalloutPlacementInput): CalloutPlacementResult {
  const pad = 4;
  const { cursorX, cursorY, width, height, bounds, ceilingSamples, preferredSide = 'right' } = input;
  const minX = bounds.left + pad;
  const maxX = Math.max(minX, bounds.right - width - pad);
  const minY = bounds.top + pad;
  const maxY = Math.max(minY, bounds.bottom - height - pad);

  const rightNearX = clamp(cursorX + 14, minX, maxX);
  const leftNearX = clamp(cursorX - 14 - width, minX, maxX);
  const farRightX = maxX;
  const farLeftX = minX;

  const skyTopY = minY;
  const aboveCursorY = clamp(cursorY - height - 12, minY, maxY);
  const belowCursorY = clamp(cursorY + 14, minY, maxY);

  const rawCandidates: Array<{ x: number; y: number; side: CalloutHorizontalSide }> = [
    { x: rightNearX, y: skyTopY, side: 'right' },
    { x: leftNearX, y: skyTopY, side: 'left' },
    { x: rightNearX, y: aboveCursorY, side: 'right' },
    { x: leftNearX, y: aboveCursorY, side: 'left' },
    { x: farRightX, y: skyTopY, side: 'right' },
    { x: farLeftX, y: skyTopY, side: 'left' },
    { x: rightNearX, y: belowCursorY, side: 'right' },
    { x: leftNearX, y: belowCursorY, side: 'left' },
    { x: farRightX, y: belowCursorY, side: 'right' },
    { x: farLeftX, y: belowCursorY, side: 'left' },
    { x: farRightX, y: maxY, side: 'right' },
    { x: farLeftX, y: maxY, side: 'left' },
  ];

  const clearance = 10;
  let best = rawCandidates[0]!;
  let bestCost = Infinity;

  for (const cand of rawCandidates) {
    let cost = 0;

    // 1) Strong penalty if candidate box covers or crowds the cursor bullseye
    const overlapsCursorX = cursorX >= cand.x - clearance && cursorX <= cand.x + width + clearance;
    const overlapsCursorY = cursorY >= cand.y - clearance && cursorY <= cand.y + height + clearance;
    if (overlapsCursorX && overlapsCursorY) {
      const dx = Math.min(cursorX - (cand.x - clearance), cand.x + width + clearance - cursorX);
      const dy = Math.min(cursorY - (cand.y - clearance), cand.y + height + clearance - cursorY);
      cost += 12_000 + Math.min(dx, dy) * 200;
    }

    // 2) Penalty if vertical cursor line cuts straight through the middle of the callout box
    if (cursorX > cand.x + 2 && cursorX < cand.x + width - 2) {
      cost += 2_400;
    }

    // 3) Convective dome clobber penalty: keep the red/orange thermal core & TOL curve uncovered
    if (ceilingSamples && ceilingSamples.length > 0) {
      let domeIntrusion = 0;
      let sampleCount = 0;
      const boxBottom = cand.y + height;
      for (const s of ceilingSamples) {
        if (s.x < cand.x - 6 || s.x > cand.x + width + 6) continue;
        sampleCount += 1;
        if (s.ceilingY !== null && boxBottom > s.ceilingY - 4) {
          const intrusion = Math.min(height, boxBottom - (s.ceilingY - 4));
          domeIntrusion += intrusion;
        }
      }
      if (sampleCount > 0) {
        cost += (domeIntrusion / sampleCount) * 18;
      }
    }

    // 4) Prefer floating in the calm upper sky rather than covering surface barbs at the bottom
    cost += (cand.y - minY) * 0.65;

    // 5) Mild proximity preference so the eye doesn't jump across a 650px chart unnecessarily
    const boxCenterX = cand.x + width / 2;
    cost += Math.abs(boxCenterX - cursorX) * 0.28;

    // 6) Hysteresis bonus to prevent side-flipping on tiny pointer jitter
    if (cand.side === preferredSide) {
      cost -= 22;
    }

    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }

  return best;
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;
const compass16 = (deg: number) => COMPASS_16[Math.round(deg / 22.5) % 16]!;

/** Aviation WMO 5-knot rounding tiers matching Windgram barb colors across all altitudes (<2.5 calm, <12.5 green, <17.5 white, <27.5 yellow, <47.5 coral, >=47.5 pennant). */
export function classifyParagliderWind(speedMps: number | null): ParagliderWindLevel {
  if (speedMps === null || !Number.isFinite(speedMps)) return 'missing';
  const kt = mpsToKnots(speedMps);
  if (kt < WIND_SPEED_KNOT_THRESHOLDS.calmKt) return 'calm';
  if (kt < WIND_SPEED_KNOT_THRESHOLDS.greenMaxKt) return 'ok';
  if (kt < WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt) return 'moderate';
  if (kt < WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt) return 'caution';
  if (kt < WIND_SPEED_KNOT_THRESHOLDS.redMaxKt) return 'danger';
  return 'pennant';
}

export function classifyClimbLevel(climbMps: number | null): ClimbVisualLevel {
  if (climbMps === null || !Number.isFinite(climbMps) || climbMps < 0.05) return 'none';
  if (climbMps < 1.5) return 'mild';
  if (climbMps < 3.5) return 'good';
  return 'strong';
}

/** Quantizes 0..100% sky cover into 0..5 oktas-style indicator segments. */
export function cloudOktasSegments(cloudPercent: number | null): number {
  if (cloudPercent === null || !Number.isFinite(cloudPercent) || cloudPercent <= 5) return 0;
  return clamp(Math.ceil(clamp(cloudPercent, 0, 100) / 20), 1, 5);
}

function formatCompactClimb(mps: number, system: UnitSystem): string {
  const sign = mps < 0 ? '-' : '+';
  const abs = Math.abs(mps);
  if (system === 'imperial') {
    const fpm = Math.round((abs / FEET_PER_MINUTE_TO_MPS) / 5) * 5;
    return fpm > 0 ? `${sign}${fpm.toLocaleString('en-US')} fpm` : '0 fpm';
  }
  const rounded = Math.round(abs * 10) / 10;
  return rounded > 0 ? `${sign}${rounded.toFixed(1)} m/s` : '0.0 m/s';
}

function formatCompactSpan(metres: number, system: UnitSystem): string {
  const converted = convertQuantity(Math.max(10, metres), 'elevation', system) ?? metres;
  if (system === 'metric') {
    const rounded = converted >= 100 ? Math.round(converted / 10) * 10 : Math.max(10, Math.round(converted / 5) * 5);
    return `${rounded.toLocaleString('en-US')} m`;
  }
  if (converted >= 10_000) {
    return `${(converted / 1000).toFixed(1)}k ft`;
  }
  const roundedFt = Math.max(50, Math.round(converted / 50) * 50);
  return `${roundedFt.toLocaleString('en-US')} ft`;
}

const setAttr = (el: Element | null, name: string, value: string) => {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
};

const setText = (el: Element | null, value: string) => {
  if (el && el.textContent !== value) el.textContent = value;
};

// ---------------------------------------------------------------------------
// Variant 1: Option B — Compact 2x2 Instrument Tile ('tile-2x2', default)
// Light-footprint 204x74 translucent glass tile:
//   Wind Vector + WMO Thresholds       | Vario Climb Gauge + B/S & Cu Context
//   5-Segment Oktas + METAR + Clear/In | Temp + Dewpoint (Td) + Hazards
// ---------------------------------------------------------------------------

const TILE_WIDTH = 204;
const TILE_HEIGHT = 74;
const TILE_DIVIDER_X = 103;
const TILE_VARIO_MAX_PX = 18;

const tile2x2Stylesheet = `
.windgram .wg-tile-back { fill: #0f172a; fill-opacity: .88; stroke: #475569; stroke-opacity: .72; stroke-width: .85; }
.windgram .wg-tile-back.is-caution { stroke: #f59e0b; stroke-opacity: .85; }
.windgram .wg-tile-back.is-danger { stroke: #ef4444; stroke-opacity: .9; }
.windgram .wg-tile-back.is-pennant { stroke: #e879f9; stroke-opacity: .92; }
.windgram .wg-tile-divider { stroke: #1e293b; stroke-opacity: .9; stroke-width: .9; stroke-dasharray: none; }
.windgram .wg-tile-pill { fill: #f59e0b; fill-opacity: .2; stroke: #fbbf24; stroke-opacity: .55; stroke-width: .7; }
.windgram .wg-tile-pill.is-free { fill: #38bdf8; fill-opacity: .16; stroke: #7dd3fc; stroke-opacity: .45; }
.windgram .wg-tile-badge { fill: #fbbf24; font-size: 8px; font-weight: 800; letter-spacing: .03em; }
.windgram .wg-tile-badge.is-free { fill: #93c5fd; font-weight: 700; }
.windgram .wg-tile-time { fill: #bae6fd; font-size: 9px; font-weight: 750; }
.windgram .wg-tile-agl { fill: #f8fafc; font-size: 10px; font-weight: 750; }
.windgram .wg-tile-msl { fill: #94a3b8; font-size: 8.6px; font-weight: 600; }
.windgram .wg-tile-cell-tint { fill: transparent; }
.windgram .wg-tile-cell-tint.is-caution { fill: #f59e0b; fill-opacity: .14; }
.windgram .wg-tile-cell-tint.is-danger { fill: #ef4444; fill-opacity: .19; }
.windgram .wg-tile-cell-tint.is-pennant { fill: #d946ef; fill-opacity: .19; }
.windgram .wg-tile-cell-tint.is-cloud { fill: #0ea5e9; fill-opacity: .18; }
.windgram .wg-tile-cell-tint.is-rain { fill: #0284c7; fill-opacity: .18; }
.windgram .wg-tile-dial { fill: #0b1324; stroke: #4ade80; stroke-width: 1.15; }
.windgram .wg-tile-dial.is-calm { stroke: #86efac; }
.windgram .wg-tile-dial.is-missing { stroke: #64748b; }
.windgram .wg-tile-dial.is-moderate { stroke: #e2e8f0; }
.windgram .wg-tile-dial.is-caution { stroke: #fbbf24; }
.windgram .wg-tile-dial.is-danger { stroke: #f87171; }
.windgram .wg-tile-dial.is-pennant { stroke: #e879f9; }
.windgram .wg-tile-dial-tick { stroke: #64748b; stroke-width: .9; stroke-dasharray: none; }
.windgram .wg-tile-arrow { fill: #4ade80; stroke: none; }
.windgram .wg-tile-arrow.is-moderate { fill: #f8fafc; }
.windgram .wg-tile-arrow.is-caution { fill: #fbbf24; }
.windgram .wg-tile-arrow.is-danger { fill: #f87171; }
.windgram .wg-tile-arrow.is-pennant { fill: #e879f9; }
.windgram .wg-tile-calm-dot { fill: none; stroke: #86efac; stroke-width: 1.15; }
.windgram .wg-tile-val { fill: #f1f5f9; font-size: 10.2px; font-weight: 750; }
.windgram .wg-tile-val.is-ok { fill: #4ade80; }
.windgram .wg-tile-val.is-moderate { fill: #f8fafc; }
.windgram .wg-tile-val.is-caution { fill: #fbbf24; }
.windgram .wg-tile-val.is-danger { fill: #f87171; }
.windgram .wg-tile-val.is-pennant { fill: #f0abfc; }
.windgram .wg-tile-val.is-mild { fill: #86efac; }
.windgram .wg-tile-val.is-good { fill: #4ade80; }
.windgram .wg-tile-val.is-strong { fill: #fbbf24; }
.windgram .wg-tile-val.is-wave { fill: #67e8f9; }
.windgram .wg-tile-val.is-sink { fill: #fda4af; }
.windgram .wg-tile-val.is-muted { fill: #94a3b8; font-weight: 650; }
.windgram .wg-tile-val.is-freeze { fill: #67e8f9; }
.windgram .wg-tile-td { fill: #94a3b8; font-size: 7.9px; font-weight: 650; }
.windgram .wg-tile-sky-code { fill: #cbd5e1; font-size: 7.5px; font-weight: 750; letter-spacing: .02em; }
.windgram .wg-tile-sky-code.is-cloud { fill: #7dd3fc; font-weight: 800; }
.windgram .wg-tile-sky-code.is-muted { fill: #94a3b8; font-weight: 650; }
.windgram .wg-tile-sub { fill: #94a3b8; font-size: 8.0px; font-weight: 650; }
.windgram .wg-tile-sub.is-caution { fill: #fcd34d; }
.windgram .wg-tile-sub.is-danger { fill: #fca5a5; }
.windgram .wg-tile-sub.is-pennant { fill: #f0abfc; }
.windgram .wg-tile-sub.is-wave { fill: #67e8f9; font-weight: 700; }
.windgram .wg-tile-sub.is-cloud { fill: #7dd3fc; font-weight: 750; }
.windgram .wg-tile-sub.is-rain { fill: #38bdf8; font-weight: 750; }
.windgram .wg-tile-vario-track { fill: #1e293b; }
.windgram .wg-tile-vario-tick { stroke: #475569; stroke-width: .75; stroke-dasharray: none; }
.windgram .wg-tile-vario-fill { fill: #4ade80; }
.windgram .wg-tile-vario-fill.is-strong { fill: #fbbf24; }
.windgram .wg-tile-vario-fill.is-wave { fill: #22d3ee; }
.windgram .wg-tile-okta { fill: #1e293b; stroke: #334155; stroke-width: .55; }
.windgram .wg-tile-okta.is-lit { fill: #e2e8f0; stroke: #cbd5e1; }
.windgram .wg-tile-okta.is-high { fill: #64748b; stroke: #94a3b8; fill-opacity: .65; }
.windgram .wg-tile-okta.is-cloud { fill: #38bdf8; stroke: #7dd3fc; }
.windgram .wg-tile-drop { fill: #38bdf8; stroke: none; }
`;

const tile2x2Renderer: WindgramCalloutRenderer = {
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
      // Quadrant background tints
      `<rect x="1" y="20" width="${TILE_DIVIDER_X - 1.5}" height="26" data-tile-wind-bg="" class="wg-tile-cell-tint"/>` +
      `<rect x="1" y="47" width="${TILE_DIVIDER_X - 1.5}" height="26" rx="3" data-tile-cloud-bg="" class="wg-tile-cell-tint"/>` +
      `<rect x="${TILE_DIVIDER_X + 0.5}" y="47" width="${TILE_WIDTH - TILE_DIVIDER_X - 1.5}" height="26" rx="3" data-tile-rain-bg="" class="wg-tile-cell-tint"/>` +
      // Structural grid hairlines
      `<line x1="0" y1="19.5" x2="${TILE_WIDTH}" y2="19.5" class="wg-tile-divider"/>` +
      `<line x1="0" y1="46.5" x2="${TILE_WIDTH}" y2="46.5" class="wg-tile-divider"/>` +
      `<line x1="${TILE_DIVIDER_X}" y1="19.5" x2="${TILE_DIVIDER_X}" y2="${TILE_HEIGHT}" class="wg-tile-divider"/>` +
      // Header bar: TOL/ALT pill + compact timestamp + AGL + right-aligned MSL
      `<rect x="4.5" y="3.8" width="31" height="12" rx="3.8" data-tile-badge-pill="" class="wg-tile-pill"/>` +
      `<text x="20" y="12.5" text-anchor="middle" data-cursor-badge="" class="wg-tile-badge"/>` +
      `<text x="39" y="13.2" data-tile-time="" class="wg-tile-time"/>` +
      `<text x="40" y="13.3" data-cursor-agl="" class="wg-tile-agl"/>` +
      `<text x="${TILE_WIDTH - 5.5}" y="13.2" text-anchor="end" data-cursor-msl="" class="wg-tile-msl"/>` +
      // Top-Left: Rotating Wind-Vector Compass + Speed/Direction
      `<circle cx="16.5" cy="33" r="8.5" data-tile-dial="" class="wg-tile-dial"/>` +
      `<line x1="16.5" y1="23.4" x2="16.5" y2="25.3" class="wg-tile-dial-tick"/>` +
      `<path d="M0 -5L3.3 4.1L0 2L-3.3 4.1Z" transform="translate(16.5 33)" data-tile-wind-arrow="" class="wg-tile-arrow"/>` +
      `<circle cx="16.5" cy="33" r="2.7" visibility="hidden" data-tile-wind-calm="" class="wg-tile-calm-dot"/>` +
      `<text x="29.5" y="31.5" data-tile-wind-speed="" class="wg-tile-val"/>` +
      `<text x="29.5" y="42" data-tile-wind-dir="" class="wg-tile-sub"/>` +
      // Top-Right: Variometer Climb Bar + Rate
      varioTicks +
      `<rect x="109.5" y="24.5" width="3.8" height="${TILE_VARIO_MAX_PX}" rx="1.9" class="wg-tile-vario-track"/>` +
      `<rect x="109.5" y="42.5" width="3.8" height="0" rx="1.9" data-tile-climb-fill="" class="wg-tile-vario-fill"/>` +
      `<text x="117" y="31.5" data-tile-climb-val="" class="wg-tile-val"/>` +
      `<text x="117" y="42" data-tile-climb-sub="" class="wg-tile-sub"/>` +
      // Bottom-Left: 5-Segment Sky Oktas + Aviation Sky Code + Clear vs In-Cloud State
      oktas +
      `<text x="56" y="56.1" data-tile-sky-code="" class="wg-tile-sky-code"/>` +
      `<text x="7" y="67.6" data-tile-cloud-text="" class="wg-tile-sub"/>` +
      // Bottom-Right: Temperature + Dewpoint (Td) + Conditional Precipitation / Hazards
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

        // Header badge ('★ TOL' vs 'ALT') + hovered hour timestamp
        setText(badge, useTol ? '★ TOL' : 'ALT');
        setAttr(badge, 'class', useTol ? 'wg-tile-badge' : 'wg-tile-badge is-free');
        setAttr(badgePill, 'class', useTol ? 'wg-tile-pill' : 'wg-tile-pill is-free');
        const compactTime = telemetry.compactTime ?? '';
        setText(timeEl, compactTime);
        const aglX = compactTime ? Math.round(39 + compactTime.length * 5.3 + 6) : 40;
        setAttr(agl, 'x', String(aglX));

        const rhVal = reading.relativeHumidityPercent !== null && Number.isFinite(reading.relativeHumidityPercent)
          ? Math.round(clamp(reading.relativeHumidityPercent, 0, 100))
          : null;
        const inSaturatedCloud = reading.cloud === 'humidity' || (rhVal !== null && rhVal >= CLOUD_RH_THRESHOLD_PERCENT);
        const activeLayer = reading.activeCloudLayer ?? null;
        const inStratiformDeck = activeLayer?.kind === 'stratiform';
        const inConvectiveTower =
          !useTol &&
          activeLayer !== null &&
          activeLayer.kind !== 'stratiform' &&
          reading.heightM > activeLayer.baseM + 20;
        const inAnyCloudAtHeight = inSaturatedCloud || inStratiformDeck || inConvectiveTower;
        const inInversion = reading.lapseCPer1000Ft != null && Number.isFinite(reading.lapseCPer1000Ft) && reading.lapseCPer1000Ft > 0.05;
        const precipMm = reading.precipitationMmHr;
        const hasRain = precipMm !== null && Number.isFinite(precipMm) && precipMm > 0.04;
        const shearedLift =
          reading.buoyancyShearRatio != null &&
          Number.isFinite(reading.buoyancyShearRatio) &&
          reading.buoyancyShearRatio <= 0.35;

        // Quadrant 1: Wind vector + speed + compass direction + surface-only 10m gust (zero opinionated adjectives)
        const speedMps = reading.speedKt === null ? null : knotsToMps(reading.speedKt);
        const pgWind = classifyParagliderWind(speedMps);
        const nearSurface = reading.heightAglM !== null && reading.heightAglM <= 150;
        const hasSurfaceGust = nearSurface
          && reading.gustKt !== null
          && Number.isFinite(reading.gustKt)
          && reading.speedKt !== null
          && reading.gustKt - reading.speedKt >= 5;
        const gustTag = hasSurfaceGust
          ? ` · G${Math.round(convertQuantity(knotsToMps(reading.gustKt!), 'wind', unitSystem) ?? 0)}`
          : '';
        const effectiveAlert: ParagliderWindLevel =
          hasSurfaceGust && reading.gustKt! >= WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt && (pgWind === 'calm' || pgWind === 'ok' || pgWind === 'moderate' || pgWind === 'caution')
            ? 'danger'
            : hasSurfaceGust && reading.gustKt! >= WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt && (pgWind === 'calm' || pgWind === 'ok' || pgWind === 'moderate')
              ? 'caution'
              : pgWind;
        const borderMod = effectiveAlert === 'pennant'
          ? ' is-pennant'
          : effectiveAlert === 'danger'
            ? ' is-danger'
            : effectiveAlert === 'caution'
              ? ' is-caution'
              : '';
        setAttr(back, 'class', `wg-tile-back${borderMod}`);
        setAttr(windBg, 'class', `wg-tile-cell-tint${borderMod}`);
        setAttr(dial, 'class', `wg-tile-dial is-${pgWind}`);

        if (pgWind === 'missing') {
          setAttr(windArrow, 'visibility', 'hidden');
          setAttr(windCalm, 'visibility', 'hidden');
          setText(windSpeed, '—');
          setAttr(windSpeed, 'class', 'wg-tile-val is-muted');
          setText(windDir, '—');
          setAttr(windDir, 'class', 'wg-tile-sub');
        } else if (pgWind === 'calm') {
          const dispSpeed = Math.round(convertQuantity(speedMps, 'wind', unitSystem) ?? 0);
          const cardinal = reading.directionDeg === null ? '—' : compass16(reading.directionDeg);
          setAttr(windArrow, 'visibility', 'hidden');
          setAttr(windCalm, 'visibility', 'visible');
          setText(windSpeed, `${dispSpeed} ${unitLabel('wind', unitSystem)}`);
          setAttr(windSpeed, 'class', 'wg-tile-val is-ok');
          setText(windDir, `${cardinal}${gustTag}`);
          setAttr(windDir, 'class', borderMod ? `wg-tile-sub${borderMod}` : 'wg-tile-sub');
        } else {
          const dispSpeed = Math.round(convertQuantity(speedMps, 'wind', unitSystem) ?? 0);
          const dir = reading.directionDeg;
          const cardinal = dir === null ? '—' : compass16(dir);
          if (dir !== null) {
            const downwindDeg = fmt((dir + 180) % 360);
            setAttr(windArrow, 'transform', `translate(16.5 33) rotate(${downwindDeg})`);
            const arrowMod = pgWind === 'pennant'
              ? ' is-pennant'
              : pgWind === 'danger'
                ? ' is-danger'
                : pgWind === 'caution'
                  ? ' is-caution'
                  : pgWind === 'moderate'
                    ? ' is-moderate'
                    : '';
            setAttr(windArrow, 'class', `wg-tile-arrow${arrowMod}`);
            setAttr(windArrow, 'visibility', 'visible');
            setAttr(windCalm, 'visibility', 'hidden');
          } else {
            setAttr(windArrow, 'visibility', 'hidden');
            setAttr(windCalm, 'visibility', 'visible');
          }
          setText(windSpeed, `${dispSpeed} ${unitLabel('wind', unitSystem)}`);
          setAttr(windSpeed, 'class', `wg-tile-val is-${pgWind}`);
          setText(windDir, `${cardinal}${gustTag}`);
          setAttr(windDir, 'class', borderMod ? `wg-tile-sub${borderMod}` : 'wg-tile-sub');
        }

        // Quadrant 2: Variometer Climb Rate (Thermal, Sheared Lift, Cu-Base TOL, Cu Tower, Wave vs Ascent, or Inversion Lid)
        let displayClimbMps: number | null = null;
        let climbCaption = inInversion && !useTol ? 'Inversion lid' : 'No thermal';
        let climbSubClass = 'wg-tile-sub';
        let waveMode: 'none' | 'up' | 'down' = 'none';
        if (useTol) {
          if (reading.estimatedClimbMps !== null && reading.estimatedClimbMps >= 0.08) {
            displayClimbMps = reading.estimatedClimbMps;
            climbCaption = reading.cloudCapped ? '▲ Cu base' : '▲ At TOL';
          } else if (reading.peakClimbMps !== null && reading.peakClimbMps > 0) {
            displayClimbMps = reading.peakClimbMps;
            climbCaption = '▲ Peak lift';
          }
        } else if (reading.estimatedClimbMps !== null && reading.estimatedClimbMps >= 0.05) {
          displayClimbMps = reading.estimatedClimbMps;
          if (shearedLift) {
            climbCaption = '▲ Sheared lift';
            climbSubClass = 'wg-tile-sub is-caution';
          } else {
            climbCaption = '▲ Thermal';
          }
        } else if (!hasRain && !inSaturatedCloud && reading.waveVelocityMps != null && reading.waveVelocityMps >= 0.5) {
          const isStableWave =
            (reading.lapseCPer1000Ft == null || reading.lapseCPer1000Ft > WAVE_MIN_LAPSE_C_PER_1000FT)
            && (reading.speedKt == null || reading.speedKt >= WAVE_MIN_WIND_KT);
          displayClimbMps = reading.waveVelocityMps;
          climbCaption = isStableWave ? '▲ Wave' : '▲ Ascent';
          climbSubClass = 'wg-tile-sub is-wave';
          waveMode = 'up';
        } else if (!hasRain && reading.waveVelocityMps != null && reading.waveVelocityMps <= -0.6) {
          displayClimbMps = reading.waveVelocityMps;
          climbCaption = '▼ Wave sink';
          climbSubClass = 'wg-tile-sub is-danger';
          waveMode = 'down';
        } else if (inConvectiveTower) {
          displayClimbMps = 0;
          climbCaption = activeLayer?.kind === 'overdeveloped' ? '☁ In OD layer' : '☁ In Cu tower';
          climbSubClass = 'wg-tile-sub is-cloud';
        } else if (reading.estimatedClimbMps !== null) {
          displayClimbMps = 0;
          climbCaption = inInversion ? 'Inversion lid' : 'Above lift';
        }
        const climbTier = classifyClimbLevel(displayClimbMps);
        const barFrac = displayClimbMps !== null && displayClimbMps > 0 ? clamp(displayClimbMps / 5.0, 0.08, 1) : 0;
        const barH = fmt(barFrac * TILE_VARIO_MAX_PX);
        setAttr(climbFill, 'y', String(fmt(42.5 - barFrac * TILE_VARIO_MAX_PX)));
        setAttr(climbFill, 'height', String(barH));
        setAttr(
          climbFill,
          'class',
          waveMode === 'up'
            ? 'wg-tile-vario-fill is-wave'
            : climbTier === 'strong'
              ? 'wg-tile-vario-fill is-strong'
              : 'wg-tile-vario-fill',
        );
        if (displayClimbMps === null) {
          setText(climbVal, '—');
          setAttr(climbVal, 'class', 'wg-tile-val is-muted');
          setText(climbSub, climbCaption);
          setAttr(climbSub, 'class', climbSubClass);
        } else {
          setText(climbVal, formatCompactClimb(displayClimbMps, unitSystem));
          const valClass = waveMode === 'up'
            ? 'wg-tile-val is-wave'
            : waveMode === 'down'
              ? 'wg-tile-val is-sink'
              : climbTier === 'none'
                ? 'wg-tile-val is-muted'
                : `wg-tile-val is-${climbTier}`;
          setAttr(climbVal, 'class', valClass);
          setText(climbSub, climbCaption);
          setAttr(climbSub, 'class', climbSubClass);
        }

        // Quadrant 3: 5-Segment Sky Oktas + Aviation METAR Code + Explicit Point State (Clear vs Whiteout / Cu Tower)
        const cloudPct = reading.cloudCoverTotalPercent === null
          ? null
          : Math.round(clamp(reading.cloudCoverTotalPercent, 0, 100));
        const layers = reading.cloudLayers ?? [];
        const maxLayerCover = layers.length ? Math.max(...layers.map(l => l.coverPercent)) : null;
        const effectiveCoverPct = cloudPct !== null && maxLayerCover !== null
          ? Math.max(cloudPct, maxLayerCover)
          : (cloudPct ?? maxLayerCover ?? (inSaturatedCloud ? 100 : null));
        const highOnly = Boolean(reading.highCloudOnly) && !inAnyCloudAtHeight;
        const litCount = inSaturatedCloud
          ? Math.max(4, cloudOktasSegments(effectiveCoverPct))
          : inAnyCloudAtHeight
            ? Math.max(2, cloudOktasSegments(activeLayer?.coverPercent ?? effectiveCoverPct))
            : cloudOktasSegments(effectiveCoverPct);

        setAttr(cloudBg, 'class', inAnyCloudAtHeight ? 'wg-tile-cell-tint is-cloud' : 'wg-tile-cell-tint');
        for (let i = 0; i < oktas.length; i++) {
          const lit = i < litCount;
          const oktaCls = !lit
            ? 'wg-tile-okta'
            : inAnyCloudAtHeight
              ? 'wg-tile-okta is-cloud'
              : highOnly
                ? 'wg-tile-okta is-high'
                : 'wg-tile-okta is-lit';
          setAttr(oktas[i], 'class', oktaCls);
        }

        let skyCode = '—';
        let skyCodeClass = 'wg-tile-sky-code';
        if (inSaturatedCloud) {
          skyCode = 'IMC';
          skyCodeClass = 'wg-tile-sky-code is-cloud';
        } else if (inStratiformDeck && activeLayer) {
          skyCode = `${activeLayer.coverageCode} ${activeLayer.coverPercent}%`;
          skyCodeClass = 'wg-tile-sky-code is-cloud';
        } else if (inConvectiveTower && activeLayer) {
          skyCode = `${activeLayer.coverageCode} ${activeLayer.kind === 'overdeveloped' ? 'OD' : 'Cu'}`;
          skyCodeClass = 'wg-tile-sky-code is-cloud';
        } else if (highOnly && cloudPct !== null) {
          skyCode = `HI ${cloudPct}%`;
          skyCodeClass = 'wg-tile-sky-code is-muted';
        } else if (layers.length >= 2) {
          skyCode = `${layers.length} LYR`;
        } else if (effectiveCoverPct !== null) {
          const code = skyCoverageCode(effectiveCoverPct);
          skyCode = code === 'CLR' ? 'CLR' : `${code} ${effectiveCoverPct}%`;
          if (code === 'CLR') skyCodeClass = 'wg-tile-sky-code is-muted';
        }
        setText(skyCodeEl, skyCode);
        setAttr(skyCodeEl, 'class', skyCodeClass);

        const cuLayer = layers.find(l => l.kind !== 'stratiform') ?? (activeLayer?.kind !== 'stratiform' ? activeLayer : null);
        if (inSaturatedCloud) {
          const satDepth = activeLayer?.depthM ?? null;
          const label = satDepth !== null && satDepth >= 40
            ? `☁ Whiteout · ${formatCompactSpan(satDepth, unitSystem)}`
            : rhVal !== null
              ? `☁ Whiteout · RH ${rhVal}%`
              : '☁ Whiteout (IMC)';
          setText(cloudText, label);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (inStratiformDeck && activeLayer) {
          setText(cloudText, `☁ ${activeLayer.coverageCode} deck · ${formatCompactSpan(activeLayer.depthM, unitSystem)}`);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (inConvectiveTower && activeLayer) {
          const tag = activeLayer.kind === 'overdeveloped' ? 'OD' : 'Cu';
          setText(cloudText, `☁ In ${tag} · ${formatCompactSpan(activeLayer.depthM, unitSystem)} deep`);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (useTol && reading.cloudCapped) {
          const label = cuLayer && cuLayer.depthM >= 50
            ? `Cu base · ${formatCompactSpan(cuLayer.depthM, unitSystem)} deep`
            : rhVal !== null
              ? `At Cu base · RH ${rhVal}%`
              : 'At Cu base';
          setText(cloudText, label);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (reading.nearestCloudBaseAboveM != null && reading.nearestCloudBaseAboveM - reading.heightM <= 4000) {
          const clearanceM = reading.nearestCloudBaseAboveM - reading.heightM;
          setText(cloudText, `Clear · Base +${formatCompactSpan(clearanceM, unitSystem)}`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (highOnly) {
          setText(cloudText, 'Clear · High cirrus');
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (reading.nearestCloudTopBelowM != null && reading.heightM - reading.nearestCloudTopBelowM <= 2500) {
          const aboveM = reading.heightM - reading.nearestCloudTopBelowM;
          setText(cloudText, `Clear · Top -${formatCompactSpan(aboveM, unitSystem)}`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (rhVal !== null) {
          setText(cloudText, `Clear · RH ${rhVal}%`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (cloudPct !== null) {
          setText(cloudText, `Clear · Sky ${cloudPct}%`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else {
          setText(cloudText, 'Sky —');
          setAttr(cloudText, 'class', 'wg-tile-sub');
        }

        // Quadrant 4: Temperature + Dewpoint (Td) + Conditional Precipitation / Icing / Cloud Suck / CAPE / Shear / OD / Inversion
        let tempC: number | null = null;
        let freezing = false;
        if (reading.temperatureF == null) {
          setText(tempEl, '—');
          setAttr(tempEl, 'class', 'wg-tile-val is-muted');
        } else {
          tempC = fahrenheitToCelsius(reading.temperatureF);
          const dispTemp = Math.round(convertQuantity(tempC, 'temperature', unitSystem) ?? 0);
          freezing = tempC <= 0;
          setText(tempEl, `${freezing ? '❄ ' : ''}${dispTemp}${unitLabel('temperature', unitSystem)}`);
          setAttr(tempEl, 'class', freezing ? 'wg-tile-val is-freeze' : 'wg-tile-val');
        }

        if (reading.dewPointC != null && Number.isFinite(reading.dewPointC)) {
          const dispTd = Math.round(convertQuantity(reading.dewPointC, 'temperature', unitSystem) ?? 0);
          setText(dewpointEl, `Td ${dispTd}°`);
        } else {
          setText(dewpointEl, '');
        }

        const icingRisk = inSaturatedCloud && tempC !== null && tempC <= 0 && tempC >= -20;
        const cuDepthM = cuLayer?.depthM ?? 0;
        const cloudSuckRisk =
          !reading.overdeveloped &&
          (inConvectiveTower || (useTol && Boolean(reading.cloudCapped))) &&
          cuDepthM >= 1000 &&
          (reading.peakClimbMps ?? 0) >= 1.8 &&
          (reading.capeJkg === null || reading.capeJkg < HIGH_INSTABILITY_CAPE_JKG);

        if (hasRain) {
          setAttr(rainBg, 'class', 'wg-tile-cell-tint is-rain');
          setAttr(rainIcon, 'visibility', 'visible');
          setAttr(hazardEl, 'x', '118.5');
          setText(hazardEl, `Rain ${formatQuantity(precipMm, 'rainRate', undefined, unitSystem)}`);
          setAttr(hazardEl, 'class', 'wg-tile-sub is-rain');
        } else {
          setAttr(rainBg, 'class', 'wg-tile-cell-tint');
          setAttr(rainIcon, 'visibility', 'hidden');
          setAttr(hazardEl, 'x', '110');
          if (icingRisk) {
            setText(hazardEl, '❄ Icing risk');
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (cloudSuckRisk) {
            setText(hazardEl, '⚠ Cloud suck');
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (reading.capeJkg !== null && reading.capeJkg >= HIGH_INSTABILITY_CAPE_JKG) {
            setText(hazardEl, `CAPE ${Math.round(reading.capeJkg)}`);
            setAttr(hazardEl, 'class', reading.capeJkg >= 1800 ? 'wg-tile-sub is-danger' : 'wg-tile-sub is-caution');
          } else if (reading.windShear !== null && reading.windShear.perKmMps >= 6) {
            const shearLabel = unitSystem === 'imperial'
              ? `Shear ${((reading.windShear.perKmMps * MPH_PER_MPS * METRES_PER_THOUSAND_FEET) / 1000).toFixed(1)} mph/kft`
              : `Shear ${reading.windShear.perKmMps.toFixed(1)}/km`;
            setText(hazardEl, shearLabel);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else if (reading.overdeveloped) {
            setText(hazardEl, 'OD spreadout');
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else if (!inSaturatedCloud && displayClimbMps !== null && displayClimbMps >= 0.2 && shearedLift) {
            const raspBs = Math.max(1, Math.round(reading.buoyancyShearRatio! * 10));
            setText(hazardEl, `B/S ${raspBs} · Sheared`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else if (inInversion) {
            setText(hazardEl, 'Inversion');
            setAttr(hazardEl, 'class', 'wg-tile-sub');
          } else if (layers.length >= 2) {
            setText(hazardEl, `Dry · ${layers.length} layers`);
            setAttr(hazardEl, 'class', 'wg-tile-sub');
          } else {
            setText(hazardEl, 'Dry');
            setAttr(hazardEl, 'class', 'wg-tile-sub');
          }
        }

        const neededHeaderWidth = compactTime
          ? aglX + aglText.length * 6.4 + mslText.length * 5.4 + 18
          : aglText.length * 6.0 + mslText.length * 5.2 + 52;
        const dynamicWidth = Math.max(TILE_WIDTH, Math.min(228, Math.ceil(neededHeaderWidth)));
        setAttr(msl, 'x', String(fmt(dynamicWidth - 5.5)));
        setAttr(dewpointEl, 'x', String(fmt(dynamicWidth - 6)));
        setAttr(back, 'width', String(dynamicWidth));
        setAttr(back, 'height', String(TILE_HEIGHT));
        return { width: dynamicWidth, height: TILE_HEIGHT };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Variant 2: Classic 4-Row Text Callout ('classic')
// Kept registered so callers can switch or A/B compare with one option change.
// ---------------------------------------------------------------------------

const classicStylesheet = `
.windgram .wg-inspector-back { fill: #122033; fill-opacity: .92; stroke: #ffffff; stroke-opacity: .55; stroke-width: .75; }
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
      '<text x="10" y="27.5" data-cursor-agl="" data-cursor-agl-classic="" class="wg-inspector-agl"/>' +
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
