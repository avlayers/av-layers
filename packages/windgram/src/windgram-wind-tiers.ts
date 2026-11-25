// WMO 5-knot wind-speed tiers shared by chart barbs, the key, and the hover tile.

import { mpsToKnots } from './windgram-format.ts';

export type ParagliderWindLevel = 'missing' | 'calm' | 'ok' | 'moderate' | 'caution' | 'danger' | 'pennant';

/**
 * Aviation WMO 5-knot rounding boundaries (`2.5 + 5n` kt) shared by chart barbs and hover tile
 * so every WMO feather/pennant glyph maps deterministically to a single color across all altitudes.
 */
export const WIND_SPEED_KNOT_THRESHOLDS = {
  calmKt: 2.5,
  greenMaxKt: 12.5,
  whiteMaxKt: 17.5,
  yellowMaxKt: 27.5,
  redMaxKt: 47.5,
} as const;

/** WMO-aligned wind-barb speed coloring (knots -> hex color). */
export function windBarbSpeedColor(speedKt: number): string {
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.greenMaxKt) return '#78ff78';   // < 12.5 kt (calm, 5 kt & 10 kt barbs)
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt) return '#ffffff';   // 12.5–17.5 kt (15 kt barb)
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt) return '#fde047';  // 17.5–27.5 kt (20 kt & 25 kt barbs)
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.redMaxKt) return '#fca5a5';     // 27.5–47.5 kt (30–45 kt barbs)
  return '#e879f9';                                                        // >= 47.5 kt (50+ kt WMO pennant flag)
}

/** Chart barb CSS tier; lapse mode keeps the two-tone 9 kt split. */
export function windBarbTierClass(speedKt: number, hybrid: boolean): string {
  if (!hybrid) return speedKt < 9 ? 'wg-barb-ok' : 'wg-barb-mod';
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.greenMaxKt) return 'wg-barb-ok';
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt) return 'wg-barb-mod';
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt) return 'wg-barb-caution';
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.redMaxKt) return 'wg-barb-danger';
  return 'wg-barb-pennant';
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
