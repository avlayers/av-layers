// Groups point frames into local forecast days and picks the hours the day controls step through.

import { timeZoneOffsetMinutesAt } from '@av/client/timezone';
import { localDateKey } from './internal-meteo.ts';
import type { SiteForecast } from './model.ts';
import { daylightForDate } from './windgram-time-axis.ts';

type FrameRef = { readonly id: string; readonly validTime: string };
export type DayHour = { readonly id: string; readonly validAt: string };

export interface Calendar {
  frames: readonly FrameRef[];
  frameIdByValidTime: ReadonlyMap<string, string>;
  days: ReadonlyMap<string, readonly DayHour[]>;
  dayKeys: readonly string[];
}

export function groupFrames(frames: readonly FrameRef[], timeZone: string): Calendar {
  const frameIdByValidTime = new Map<string, string>();
  const days = new Map<string, DayHour[]>();
  const references = frames.map(({ id, validTime }) => {
    frameIdByValidTime.set(validTime, id);
    const key = localDateKey(validTime, timeZone);
    const hour = { id, validAt: validTime };
    const hours = days.get(key);
    if (hours) hours.push(hour);
    else days.set(key, [hour]);
    return { id, validTime };
  });
  return { frames: references, frameIdByValidTime, days, dayKeys: [...days.keys()] };
}

function localMinutesOfDay(ms: number, timeZone: string): number {
  const shifted = new Date(ms + timeZoneOffsetMinutesAt(ms, timeZone) * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function pickRepresentativeFrameInDay(
  dayHours: readonly DayHour[],
  currentValidTime: string | null,
  timeZone: string,
): string | null {
  if (!dayHours.length) return null;
  const currentMs = currentValidTime ? Date.parse(currentValidTime) : NaN;
  const targetMinutes = Number.isFinite(currentMs) ? localMinutesOfDay(currentMs, timeZone) : 14 * 60;
  let best = dayHours[0]!;
  let bestDist = Infinity;
  for (const candidate of dayHours) {
    const ms = Date.parse(candidate.validAt);
    if (!Number.isFinite(ms)) continue;
    const dist = Math.abs(localMinutesOfDay(ms, timeZone) - targetMinutes);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best.id;
}

/** Days whose frames overlap local daylight; a day without a sunrise/sunset still counts. */
export function countDaylightDays(cal: Calendar, forecast: SiteForecast, timeZone: string): number {
  let count = 0;
  for (const dayKey of cal.dayKeys) {
    const hours = cal.days.get(dayKey);
    if (!hours?.length) continue;
    const daylight = daylightForDate(forecast, dayKey, timeZone);
    if (!daylight) { count++; continue; }
    const firstMs = Date.parse(hours[0]!.validAt);
    const lastMs = Date.parse(hours.at(-1)!.validAt);
    if (firstMs <= daylight.sunset && lastMs >= daylight.sunrise) count++;
  }
  return count;
}

/** Hours that hour stepping visits: daylight hours per day when at least two exist, else every frame. */
export function navigableDayHours(cal: Calendar, forecast: SiteForecast, timeZone: string): readonly DayHour[] {
  const navigable = cal.dayKeys.flatMap(dayKey => {
    const hours = cal.days.get(dayKey) ?? [];
    const daylight = daylightForDate(forecast, dayKey, timeZone);
    if (!daylight) return hours;
    const inDaylight = hours.filter(h => {
      const ms = Date.parse(h.validAt);
      return ms >= daylight.sunrise && ms <= daylight.sunset;
    });
    return inDaylight.length >= Math.min(2, hours.length) && inDaylight.length > 0 ? inDaylight : hours;
  });
  return navigable.length
    ? navigable
    : cal.frames.map(f => ({ id: f.id, validAt: f.validTime }));
}
