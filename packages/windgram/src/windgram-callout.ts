// Pluggable SVG hover/inspection callout renderers and anti-clobber sky-pocket
// placement for Windgram charts.
// To swap the default callout or add a new variant (e.g. 'ribbon' or 'compass'),
// register a WindgramCalloutRenderer in WINDGRAM_CALLOUT_RENDERERS and update
// DEFAULT_WINDGRAM_CALLOUT (or pass `calloutVariant` at mount/render time).

import { FEET_PER_MINUTE_TO_MPS } from '@av/soaring';
import { MPH_PER_MPS } from '@av/contracts/units';
import classicStylesheet from './styles/windgram-callout-classic.css?inline';
import tile2x2Stylesheet from './styles/windgram-callout-tile.css?inline';
import {
  HIGH_INSTABILITY_CAPE_JKG,
  skyCoverageCode,
  WIND_SPEED_KNOT_THRESHOLDS,
} from './windgram-atmosphere.ts';
import {
  clamp,
  compass16,
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
import { resolveSnappedTolClimb, type WindgramTelemetryStrip } from './windgram-readout.ts';

export const WINDGRAM_CALLOUT_VARIANTS = ['tile-2x2', 'classic'] as const;
export type WindgramCalloutVariant = (typeof WINDGRAM_CALLOUT_VARIANTS)[number];
export const DEFAULT_WINDGRAM_CALLOUT: WindgramCalloutVariant = 'tile-2x2';

export type ParagliderWindLevel = 'missing' | 'calm' | 'ok' | 'moderate' | 'caution' | 'danger' | 'pennant';
type ClimbVisualLevel = 'none' | 'mild' | 'good' | 'strong';
export type CalloutHorizontalSide = 'left' | 'right';

interface WindgramCalloutPayload {
  readonly aglText: string;
  readonly mslText: string;
  readonly useTol: boolean;
  readonly telemetry: WindgramTelemetryStrip;
  readonly reading: WindgramReading;
  readonly unitSystem: UnitSystem;
}

interface BoundWindgramCallout {
  paint(payload: WindgramCalloutPayload): { readonly width: number; readonly height: number };
}

interface WindgramCalloutRenderer {
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
  /** True during touch interaction so the floating card stays clear above the user's finger. */
  readonly touchMode?: boolean;
}

export interface CalloutPlacementResult {
  readonly x: number;
  readonly y: number;
  readonly side: CalloutHorizontalSide;
}

/**
 * Places the floating hover callout inside `bounds` while minimizing occlusion of:
 * 1) The active cursor crosshair bullseye `(cursorX, cursorY)` (plus thumb pad in `touchMode`)
 * 2) The active convective thermal dome (`y >= ceilingY`)
 * 3) Rapid side-flipping during smooth horizontal scrubbing (`preferredSide` hysteresis)
 */
export function placeWindgramCallout(input: CalloutPlacementInput): CalloutPlacementResult {
  const pad = 4;
  const { cursorX, cursorY, width, height, bounds, ceilingSamples, preferredSide = 'right', touchMode = false } = input;
  const minX = bounds.left + pad;
  const maxX = Math.max(minX, bounds.right - width - pad);
  const minY = bounds.top + pad;
  const maxY = Math.max(minY, bounds.bottom - height - pad);

  const hGap = touchMode ? 22 : 14;
  const rightNearX = clamp(cursorX + hGap, minX, maxX);
  const leftNearX = clamp(cursorX - hGap - width, minX, maxX);
  const farRightX = maxX;
  const farLeftX = minX;

  const skyTopY = minY;
  const aboveCursorY = clamp(cursorY - height - (touchMode ? 28 : 12), minY, maxY);
  const belowCursorY = clamp(cursorY + (touchMode ? 48 : 14), minY, maxY);

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

  const clearanceX = touchMode ? 24 : 10;
  const clearanceYAbove = touchMode ? 20 : 10;
  const clearanceYBelow = touchMode ? 44 : 10;
  const skyWeight = touchMode ? 1.55 : 0.65;
  let best = rawCandidates[0]!;
  let bestCost = Infinity;

  for (const cand of rawCandidates) {
    let cost = 0;

    // 1) Strong penalty if candidate box covers or crowds the cursor bullseye or thumb pad
    const overlapsCursorX = cursorX >= cand.x - clearanceX && cursorX <= cand.x + width + clearanceX;
    const overlapsCursorY = cursorY >= cand.y - clearanceYBelow && cursorY <= cand.y + height + clearanceYAbove;
    if (overlapsCursorX && overlapsCursorY) {
      const dx = Math.min(cursorX - (cand.x - clearanceX), cand.x + width + clearanceX - cursorX);
      const dy = Math.min(cursorY - (cand.y - clearanceYBelow), cand.y + height + clearanceYAbove - cursorY);
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

    // 4) Float in the calm upper sky to keep surface barbs and touch zone unobstructed
    cost += (cand.y - minY) * skyWeight;

    // 5) Mild proximity preference so eye travel across wide charts stays short
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
//   Wind Vector + WMO Thresholds       | Vario Climb Gauge + Vertical Motion
//   5-Segment Oktas + METAR + Clear/In | Temp + Dewpoint (Td) + Cues
// ---------------------------------------------------------------------------

const TILE_WIDTH = 204;
const TILE_HEIGHT = 74;
const TILE_DIVIDER_X = 103;
const TILE_VARIO_MAX_PX = 18;

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

        const rawLiquidRh = reading.relativeHumidityPercent !== null && Number.isFinite(reading.relativeHumidityPercent)
          ? clamp(reading.relativeHumidityPercent, 0, 100)
          : null;
        const liquidRhVal = rawLiquidRh !== null ? Math.round(rawLiquidRh) : null;
        const rawCloudRh = reading.cloudHumidityPercent ?? reading.relativeHumidityPercent;
        const clampedCloudRh = rawCloudRh !== null && Number.isFinite(rawCloudRh)
          ? clamp(rawCloudRh, 0, 100)
          : null;
        const cloudRhVal = clampedCloudRh !== null ? Math.round(clampedCloudRh) : null;
        const inLiquidSaturatedCloud = rawLiquidRh !== null && rawLiquidRh >= CLOUD_RH_THRESHOLD_PERCENT;
        const inSaturatedCloud = reading.cloud === 'humidity' || (clampedCloudRh !== null && clampedCloudRh >= CLOUD_RH_THRESHOLD_PERCENT);
        const activeLayer = reading.activeCloudLayer ?? null;
        const inStratiformDeck = activeLayer?.kind === 'stratiform';
        const inConvectiveTower =
          !useTol &&
          activeLayer !== null &&
          activeLayer.kind !== 'stratiform' &&
          activeLayer.depthM >= 50 &&
          reading.heightM > activeLayer.baseM + 20;
        const inAnyCloudAtHeight = inSaturatedCloud || inStratiformDeck || inConvectiveTower;
        const inInversion = reading.lapseCPer1000Ft != null && Number.isFinite(reading.lapseCPer1000Ft) && reading.lapseCPer1000Ft > 0.05;
        const precipMm = reading.precipitationMmHr;
        const hasRain = precipMm !== null && Number.isFinite(precipMm) && precipMm > 0.04;
        const shearedLift =
          reading.buoyancyShearRatio != null &&
          Number.isFinite(reading.buoyancyShearRatio) &&
          reading.buoyancyShearRatio <= 0.35;

        // Quadrant 1: Wind vector + speed + compass direction + 10 m surface gust
        const speedMps = reading.speedKt === null ? null : knotsToMps(reading.speedKt);
        const pgWind = classifyParagliderWind(speedMps);
        const modelAglM = reading.modelTerrainM !== null && reading.heightM >= reading.modelTerrainM
          ? reading.heightM - reading.modelTerrainM
          : null;
        const nearSurface = reading.heightAglM !== null
          ? reading.heightAglM <= 150
          : (modelAglM !== null && modelAglM <= 150);
        const surfaceWindKt = reading.surfaceWindSpeedMps !== null && Number.isFinite(reading.surfaceWindSpeedMps)
          ? mpsToKnots(reading.surfaceWindSpeedMps)
          : null;
        const gustSpreadGateKt = reading.gustKt !== null && reading.gustKt >= WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt ? 4 : 5;
        const hasSurfaceGustExcess =
          reading.gustKt !== null &&
          Number.isFinite(reading.gustKt) &&
          surfaceWindKt !== null &&
          reading.gustKt - surfaceWindKt >= gustSpreadGateKt;
        const hasNearSurfaceGust = nearSurface && hasSurfaceGustExcess;
        const gustKt = reading.gustKt !== null && Number.isFinite(reading.gustKt) ? reading.gustKt : null;
        const gustRounded = gustKt !== null
          ? Math.round(convertQuantity(knotsToMps(gustKt), 'wind', unitSystem) ?? 0)
          : 0;
        const gustTag = hasNearSurfaceGust
          ? ` · G${gustRounded}`
          : (!nearSurface && hasSurfaceGustExcess && gustKt !== null && gustKt >= WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt)
            ? ` · Sfc G${gustRounded}`
            : '';
        const effectiveAlert: ParagliderWindLevel =
          hasNearSurfaceGust && gustKt !== null && gustKt >= WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt && (pgWind === 'calm' || pgWind === 'ok' || pgWind === 'moderate' || pgWind === 'caution')
            ? 'danger'
            : hasNearSurfaceGust && gustKt !== null && gustKt >= WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt && (pgWind === 'calm' || pgWind === 'ok' || pgWind === 'moderate')
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
          setText(windDir, gustTag ? gustTag.slice(3) : '—');
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

        // Quadrant 2: Variometer Climb Rate & Neutral Model Vertical Motion
        let displayClimbMps: number | null = null;
        let climbCaption = inInversion && !useTol ? 'Inversion lid' : 'No thermal';
        let climbSubClass = 'wg-tile-sub';
        let waveMode: 'none' | 'up' | 'down' = 'none';
        if (useTol) {
          const snappedClimb = resolveSnappedTolClimb(reading);
          if (snappedClimb) {
            displayClimbMps = snappedClimb.climbMps;
            climbCaption = snappedClimb.tileCaption;
          }
        } else if (reading.estimatedClimbMps !== null && reading.estimatedClimbMps >= 0.05) {
          displayClimbMps = reading.estimatedClimbMps;
          if (shearedLift) {
            climbCaption = '▲ Sheared lift';
            climbSubClass = 'wg-tile-sub is-caution';
          } else {
            climbCaption = '▲ Thermal';
          }
        } else if (!hasRain && reading.waveVelocityMps != null && reading.waveVelocityMps >= 0.5) {
          displayClimbMps = reading.waveVelocityMps;
          climbCaption = '▲ Model ascent';
          climbSubClass = 'wg-tile-sub is-wave';
          waveMode = 'up';
        } else if (!hasRain && reading.waveVelocityMps != null && reading.waveVelocityMps <= -0.6) {
          displayClimbMps = reading.waveVelocityMps;
          climbCaption = '▼ Model descent';
          climbSubClass = 'wg-tile-sub is-caution';
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

        // Quadrant 3: 5-Segment Sky Oktas + Aviation Sky Cover + Inferred Cloud State
        const tempC = reading.temperatureF == null ? null : fahrenheitToCelsius(reading.temperatureF);
        const cloudPct = reading.cloudCoverTotalPercent === null
          ? null
          : Math.round(clamp(reading.cloudCoverTotalPercent, 0, 100));
        const layers = reading.cloudLayers ?? [];
        const maxLayerCover = layers.length ? Math.max(...layers.map(l => l.coverPercent)) : null;
        const suppliedDisagreesWithLayer = cloudPct !== null && maxLayerCover !== null && maxLayerCover - cloudPct >= 25;
        const effectiveCoverPct = cloudPct !== null && maxLayerCover !== null
          ? (suppliedDisagreesWithLayer ? cloudPct : Math.max(cloudPct, maxLayerCover))
          : (cloudPct ?? maxLayerCover ?? (inSaturatedCloud ? 100 : null));
        const localRhKnown = liquidRhVal !== null || cloudRhVal !== null;
        const localCloudKnown = localRhKnown || layers.length > 0;
        const highOnly = Boolean(reading.highCloudOnly) && !inAnyCloudAtHeight && localRhKnown;
        const litCount = inSaturatedCloud && !suppliedDisagreesWithLayer
          ? Math.max(4, cloudOktasSegments(effectiveCoverPct))
          : inAnyCloudAtHeight && !suppliedDisagreesWithLayer
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
        if (suppliedDisagreesWithLayer) {
          skyCode = `SKY ${cloudPct}%`;
          if (inAnyCloudAtHeight) skyCodeClass = 'wg-tile-sky-code is-cloud';
          else if (cloudPct < 5) skyCodeClass = 'wg-tile-sky-code is-muted';
        } else if (inSaturatedCloud) {
          skyCode = activeLayer ? `${activeLayer.coverageCode} ${activeLayer.coverPercent}%` : 'OVC';
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
        } else if (!localCloudKnown && cloudPct !== null) {
          skyCode = cloudPct < 5 ? 'CLR' : `SKY ${cloudPct}%`;
          if (cloudPct < 5) skyCodeClass = 'wg-tile-sky-code is-muted';
        } else if (effectiveCoverPct !== null) {
          const code = skyCoverageCode(effectiveCoverPct);
          skyCode = code === 'CLR' ? 'CLR' : `${code} ${effectiveCoverPct}%`;
          if (code === 'CLR') skyCodeClass = 'wg-tile-sky-code is-muted';
        }
        setText(skyCodeEl, skyCode);
        setAttr(skyCodeEl, 'class', skyCodeClass);

        const cuLayer = layers.find(l => l.kind !== 'stratiform') ?? (activeLayer?.kind !== 'stratiform' ? activeLayer : null);
        const outsidePrefix = suppliedDisagreesWithLayer ? 'Moist RH' : 'Clear';
        if (inSaturatedCloud) {
          const satDepth = activeLayer?.depthM ?? null;
          const cloudPrefix = !inLiquidSaturatedCloud && tempC !== null && tempC < 0
            ? '☁ Cold cloud'
            : suppliedDisagreesWithLayer
              ? '☁ Moist RH'
              : '☁ In cloud';
          const label = satDepth !== null && satDepth >= 40
            ? `${cloudPrefix} · ${formatCompactSpan(satDepth, unitSystem)}`
            : cloudRhVal !== null
              ? `${cloudPrefix} · RH ${cloudRhVal}%`
              : cloudPrefix;
          setText(cloudText, label);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (inStratiformDeck && activeLayer) {
          const deckPrefix = suppliedDisagreesWithLayer ? '☁ Moist layer' : `☁ ${activeLayer.coverageCode} deck`;
          setText(cloudText, `${deckPrefix} · ${formatCompactSpan(activeLayer.depthM, unitSystem)}`);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (inConvectiveTower && activeLayer) {
          const tag = activeLayer.kind === 'overdeveloped' ? 'OD' : 'Cu';
          setText(cloudText, `☁ In ${tag} · ${formatCompactSpan(activeLayer.depthM, unitSystem)} deep`);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (useTol && reading.cloudCapped) {
          const label = cuLayer && cuLayer.depthM >= 50
            ? `Cu base · ${formatCompactSpan(cuLayer.depthM, unitSystem)} deep`
            : liquidRhVal !== null
              ? `At Cu base · RH ${liquidRhVal}%`
              : 'At Cu base';
          setText(cloudText, label);
          setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
        } else if (reading.nearestCloudBaseAboveM != null && reading.nearestCloudBaseAboveM - reading.heightM <= 4000) {
          const clearanceM = reading.nearestCloudBaseAboveM - reading.heightM;
          setText(cloudText, `${outsidePrefix} · Base +${formatCompactSpan(clearanceM, unitSystem)}`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (highOnly) {
          setText(cloudText, 'Clear · High cirrus');
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (reading.nearestCloudTopBelowM != null && reading.heightM - reading.nearestCloudTopBelowM <= 2500) {
          const aboveM = reading.heightM - reading.nearestCloudTopBelowM;
          setText(cloudText, `${outsidePrefix} · Top -${formatCompactSpan(aboveM, unitSystem)}`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (liquidRhVal !== null) {
          setText(cloudText, `${outsidePrefix} · RH ${liquidRhVal}%`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (cloudRhVal !== null) {
          setText(cloudText, `Model RH ${cloudRhVal}%`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else if (cloudPct !== null) {
          setText(cloudText, cloudPct < 5 ? `Sky ${cloudPct}%` : `Local RH — · Sky ${cloudPct}%`);
          setAttr(cloudText, 'class', 'wg-tile-sub');
        } else {
          setText(cloudText, 'Sky —');
          setAttr(cloudText, 'class', 'wg-tile-sub');
        }

        // Quadrant 4: Temperature + Dewpoint (Td) + Input-Supported Weather Cues
        if (tempC === null) {
          setText(tempEl, '—');
          setAttr(tempEl, 'class', 'wg-tile-val is-muted');
        } else {
          const dispTemp = Math.round(convertQuantity(tempC, 'temperature', unitSystem) ?? 0);
          const freezing = tempC <= 0;
          setText(tempEl, `${freezing ? '❄ ' : ''}${dispTemp}${unitLabel('temperature', unitSystem)}`);
          setAttr(tempEl, 'class', freezing ? 'wg-tile-val is-freeze' : 'wg-tile-val');
        }

        if (reading.dewPointC != null && Number.isFinite(reading.dewPointC)) {
          const dispTd = Math.round(convertQuantity(reading.dewPointC, 'temperature', unitSystem) ?? 0);
          setText(dewpointEl, `Td ${dispTd}°`);
        } else {
          setText(dewpointEl, '');
        }

        // Supercooled liquid icing requires liquid-water saturation (liquid RH >= 94%) in -20..0 °C
        const icingRisk = inLiquidSaturatedCloud && tempC !== null && tempC <= 0 && tempC >= -20;
        const cuDepthM = cuLayer?.depthM ?? 0;
        const inCuColumn =
          !useTol &&
          cuLayer !== null &&
          reading.heightM > cuLayer.baseM + 20 &&
          reading.heightM <= cuLayer.topM + 10;
        const cloudSuckRisk =
          (inConvectiveTower || inCuColumn || (useTol && Boolean(reading.cloudCapped))) &&
          cuDepthM >= 1000 &&
          (reading.peakClimbMps ?? 0) >= 1.8;
        const highCape = reading.capeJkg !== null && reading.capeJkg >= HIGH_INSTABILITY_CAPE_JKG;
        const capeRounded = highCape ? Math.round(reading.capeJkg!) : 0;
        const highShear = reading.windShear !== null && reading.windShear.perKmMps >= 6;
        if (effectiveAlert !== 'pennant' && cloudSuckRisk) {
          setAttr(back, 'class', 'wg-tile-back is-danger');
        }

        if (hasRain) {
          setAttr(rainBg, 'class', cloudSuckRisk || highCape || icingRisk ? 'wg-tile-cell-tint is-danger' : 'wg-tile-cell-tint is-rain');
          setAttr(rainIcon, 'visibility', 'visible');
          setAttr(hazardEl, 'x', '118.5');
          const rateLabel = formatQuantity(precipMm, 'rainRate', undefined, unitSystem);
          if (icingRisk && cloudSuckRisk) {
            setText(hazardEl, `${rateLabel} · ❄ Ice · Suck`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (icingRisk) {
            setText(hazardEl, `${rateLabel} · ❄ Icing risk`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (cloudSuckRisk) {
            setText(hazardEl, `${rateLabel} · ⚠ Suck`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (highCape && highShear) {
            setText(hazardEl, `${rateLabel} · CAPE ${capeRounded} · Shr`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (highCape) {
            setText(hazardEl, `${rateLabel} · CAPE ${capeRounded}`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (highShear) {
            setText(hazardEl, `${rateLabel} · Shear`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else if (reading.warmLayerAloft) {
            setText(hazardEl, `${rateLabel} · Warm aloft`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else {
            setText(hazardEl, `Precip ${rateLabel}`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-rain');
          }
        } else {
          const precipKnownZero = precipMm !== null && Number.isFinite(precipMm) && precipMm <= 0.04;
          setAttr(rainBg, 'class', 'wg-tile-cell-tint');
          setAttr(rainIcon, 'visibility', 'hidden');
          setAttr(hazardEl, 'x', '110');
          if (icingRisk && cloudSuckRisk) {
            setText(hazardEl, '❄ Ice · ⚠ Suck');
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (icingRisk) {
            setText(hazardEl, '❄ Icing risk');
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (cloudSuckRisk && highCape) {
            setText(hazardEl, `⚠ Suck · CAPE ${capeRounded}`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (cloudSuckRisk) {
            setText(hazardEl, '⚠ Cloud suck');
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (nearSurface && reading.surfaceWindShift) {
            setText(hazardEl, 'Wind shift');
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else if (highCape && highShear) {
            setText(hazardEl, `CAPE ${capeRounded} · Shear`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
          } else if (highCape) {
            setText(hazardEl, `CAPE ${capeRounded}`);
            setAttr(hazardEl, 'class', capeRounded >= 1800 ? 'wg-tile-sub is-danger' : 'wg-tile-sub is-caution');
          } else if (highShear && reading.windShear !== null) {
            const shearLabel = unitSystem === 'imperial'
              ? `Shear ${((reading.windShear.perKmMps * MPH_PER_MPS * METRES_PER_THOUSAND_FEET) / 1000).toFixed(1)} mph/kft`
              : `Shear ${reading.windShear.perKmMps.toFixed(1)}/km`;
            setText(hazardEl, shearLabel);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else if (reading.overdeveloped) {
            const coldResolvedTop = Boolean(cuLayer?.topTempC != null && cuLayer.topTempC <= -20 && cuDepthM >= 1500);
            setText(hazardEl, coldResolvedTop ? 'OD · Cold top' : 'OD spreadout');
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else if (reading.warmLayerAloft) {
            setText(hazardEl, 'Warm aloft');
            setAttr(hazardEl, 'class', 'wg-tile-sub');
          } else if (!inSaturatedCloud && displayClimbMps !== null && displayClimbMps >= 0.2 && shearedLift) {
            const raspBs = Math.max(1, Math.round(reading.buoyancyShearRatio! * 10));
            setText(hazardEl, `B/S ${raspBs} · Sheared`);
            setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
          } else if (inInversion) {
            setText(hazardEl, 'Inversion');
            setAttr(hazardEl, 'class', 'wg-tile-sub');
          } else if (layers.length >= 2) {
            setText(hazardEl, precipKnownZero ? `Dry · ${layers.length} layers` : `${layers.length} cloud layers`);
            setAttr(hazardEl, 'class', 'wg-tile-sub');
          } else {
            setText(hazardEl, precipKnownZero ? 'Dry' : 'Precip —');
            setAttr(hazardEl, 'class', 'wg-tile-sub');
          }
        }

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

// ---------------------------------------------------------------------------
// Variant 2: Classic 4-Row Text Callout ('classic')
// Kept registered so callers can switch or A/B compare with one option change.
// ---------------------------------------------------------------------------

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

const WINDGRAM_CALLOUT_RENDERERS: Readonly<Record<WindgramCalloutVariant, WindgramCalloutRenderer>> = {
  'tile-2x2': tile2x2Renderer,
  classic: classicRenderer,
};

export function getWindgramCalloutRenderer(variant?: WindgramCalloutVariant): WindgramCalloutRenderer {
  return WINDGRAM_CALLOUT_RENDERERS[variant ?? DEFAULT_WINDGRAM_CALLOUT];
}

export const windgramCalloutStyles = Object.values(WINDGRAM_CALLOUT_RENDERERS)
  .map((renderer) => renderer.stylesheet)
  .join('\n');
