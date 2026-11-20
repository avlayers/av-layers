// Pluggable point forecast view modes and pure multi-day window helpers.
// Adding a future view mode (e.g. 'scorecard' or 'horizon-strip') only requires
// registering its ID here and wiring its renderer in point-windgram.ts.

export const POINT_VIEW_MODES = ['1d', '3d'] as const;
export type PointViewMode = (typeof POINT_VIEW_MODES)[number];
export const DEFAULT_POINT_VIEW_MODE: PointViewMode = '3d';
export const DEFAULT_MULTI_DAY_SPAN = 3;

export interface PointViewModeSpec {
  readonly id: PointViewMode;
  readonly label: string;
  readonly ariaLabel: string;
}

export const POINT_VIEW_MODE_SPECS: readonly PointViewModeSpec[] = [
  { id: '1d', label: '1-Day', ariaLabel: '1-day detailed windgram' },
  { id: '3d', label: '3-Day', ariaLabel: '3-day daylight comparison windgram' },
];

export function isPointViewMode(value: string | null | undefined): value is PointViewMode {
  return value === '1d' || value === '3d';
}

export function resolvePointViewMode(value: string | null | undefined): PointViewMode {
  return isPointViewMode(value) ? value : DEFAULT_POINT_VIEW_MODE;
}

const SHORT_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });

/** Formats 'YYYY-MM-DD' into 'Sat 21'. */
export function formatShortDayLabel(dateKey: string): string {
  const ms = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return dateKey;
  const weekday = SHORT_WEEKDAY.format(new Date(ms));
  const dayNum = Number(dateKey.slice(8, 10));
  return Number.isFinite(dayNum) && dayNum > 0 ? `${weekday} ${dayNum}` : weekday;
}

/** Formats a multi-day window ['2026-11-20', ..., '2026-11-22'] into 'Fri 20 – Sun 22'. */
export function formatDayWindowLabel(windowDays: readonly string[]): string {
  if (!windowDays.length) return '';
  if (windowDays.length === 1) return formatShortDayLabel(windowDays[0]!);
  return `${formatShortDayLabel(windowDays[0]!)}–${formatShortDayLabel(windowDays.at(-1)!)}`;
}

export interface StitchedDayWindow {
  readonly windowDays: readonly string[];
  readonly startIndex: number;
  readonly canStepPrev: boolean;
  readonly canStepNext: boolean;
}

/**
 * Resolves a contiguous N-day window from sorted `dayKeys`.
 * If `anchorStartKey` is provided and still contains `focusDayKey` (or `keepAnchor` is true),
 * preserves that window; otherwise centers/clamps a window containing `focusDayKey`.
 */
export function resolveStitchedDayWindow(
  dayKeys: readonly string[],
  options: {
    focusDayKey?: string | null;
    anchorStartKey?: string | null;
    keepAnchor?: boolean;
    span?: number;
  } = {},
): StitchedDayWindow {
  const total = dayKeys.length;
  const span = Math.max(1, Math.min(options.span ?? DEFAULT_MULTI_DAY_SPAN, total || 1));
  if (total === 0) {
    return { windowDays: [], startIndex: 0, canStepPrev: false, canStepNext: false };
  }
  const maxStart = Math.max(0, total - span);
  const focusIdx = options.focusDayKey ? dayKeys.indexOf(options.focusDayKey) : -1;
  let startIndex = options.anchorStartKey ? dayKeys.indexOf(options.anchorStartKey) : -1;

  if (startIndex >= 0) {
    startIndex = Math.min(maxStart, startIndex);
    if (!options.keepAnchor && focusIdx >= 0 && (focusIdx < startIndex || focusIdx >= startIndex + span)) {
      startIndex = focusIdx < startIndex ? focusIdx : Math.min(maxStart, focusIdx - span + 1);
    }
  } else if (focusIdx >= 0) {
    // Prefer starting at focusIdx when on Day 0, or keeping focus inside a natural 3-day lookahead.
    startIndex = Math.min(maxStart, Math.max(0, focusIdx));
  } else {
    startIndex = 0;
  }

  return {
    windowDays: dayKeys.slice(startIndex, startIndex + span),
    startIndex,
    canStepPrev: startIndex > 0,
    canStepNext: startIndex < maxStart,
  };
}

/**
 * Resolves the starting day for a newly opened multi-day Windgram:
 * starts on `todayLocalKey` when present in `dayKeys`, otherwise `dayKeys[0]`.
 */
export function resolveInitialWindowStartKey(
  dayKeys: readonly string[],
  todayLocalKey?: string | null,
): string | null {
  if (!dayKeys.length) return null;
  if (todayLocalKey && dayKeys.includes(todayLocalKey)) return todayLocalKey;
  return dayKeys[0]!;
}

/**
 * Identifies the strongest soaring day among candidate `dayKeys` (only when >= 2 days exist
 * and at least one day has positive usable lift or convective velocity w* >= 0.4 m/s).
 */
export function findBestSoaringDayKey(
  dayKeys: readonly string[],
  hoursByDay: ReadonlyMap<string, readonly { validAt: string }[]>,
  forecastHourByValidAt: ReadonlyMap<
    string,
    {
      usableLiftTopM: number | null;
      terrainM: number | null;
      thermalVelocityMps: number | null;
      surfaceWindMps?: number | null;
    }
  >,
): string | null {
  if (dayKeys.length < 2) return null;
  let bestKey: string | null = null;
  let bestScore = 0;
  for (const key of dayKeys) {
    const hours = hoursByDay.get(key);
    if (!hours?.length) continue;
    let bestHourScore = 0;
    let rawMaxAgl = 0;
    let rawMaxWStar = 0;
    for (const h of hours) {
      const fh = forecastHourByValidAt.get(h.validAt);
      if (!fh) continue;
      const agl = fh.usableLiftTopM !== null
        ? (fh.terrainM !== null ? Math.max(0, fh.usableLiftTopM - fh.terrainM) : fh.usableLiftTopM)
        : 0;
      const wStar = fh.thermalVelocityMps !== null ? Math.max(0, fh.thermalVelocityMps) : 0;
      if (agl > rawMaxAgl) rawMaxAgl = agl;
      if (wStar > rawMaxWStar) rawMaxWStar = wStar;
      const sfcWind = fh.surfaceWindMps ?? null;
      const windFactor = sfcWind === null || sfcWind <= 5.6 ? 1 : sfcWind <= 8.4 ? 0.8 : 0.35;
      const hourScore = (agl + wStar * 320) * windFactor;
      if (hourScore > bestHourScore) bestHourScore = hourScore;
    }
    if ((rawMaxAgl >= 150 || rawMaxWStar >= 0.4) && bestHourScore > bestScore) {
      bestScore = bestHourScore;
      bestKey = key;
    }
  }
  return bestKey;
}
