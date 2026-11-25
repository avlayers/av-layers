// Maps chart coordinates and event targets onto an inspectable hour and height.

import { clamp } from './windgram-format.ts';
import { panelContainingX } from './windgram-panels.ts';
import { heightToY, yToHeight } from './windgram-vertical.ts';
import type { WindgramView } from './windgram-view.ts';

export type WindgramInspectionMode = 'magnetic' | 'lift' | 'height';

export const TOL_SNAP_PX = 16;

/** Lowest inspectable height: 10 m above site or model ground, inside the scale. */
export function minInspectHeightM(view: WindgramView, hourIndex: number): number {
  const source = view.sourceHours[hourIndex];
  const groundM = source?.fineTerrainM ?? source?.modelTerrainM ?? view.floorM;
  const modelFloor10M = source?.modelTerrainM !== null && source?.modelTerrainM !== undefined
    ? source.modelTerrainM + 10
    : -Infinity;
  return Math.min(view.topM, Math.max(view.floorM, groundM + 10, modelFloor10M));
}

/** The hour's Top of Lift when it lies inside the scale. */
export function visibleTolM(view: WindgramView, hourIndex: number): number | null {
  const tol = view.hours[hourIndex]?.usableLiftTopM ?? null;
  return tol !== null && tol >= view.floorM && tol <= view.topM ? tol : null;
}

export function dayBannerKey(target: EventTarget | null): string | null {
  if (!target || typeof (target as Element).closest !== 'function') return null;
  const banner = (target as Element).closest('[data-windgram-day]');
  return banner?.getAttribute('data-windgram-day') ?? null;
}

export function resolveChartPointer(
  view: WindgramView,
  visibleHours: readonly number[],
  position: { readonly x: number; readonly y: number },
  mode: WindgramInspectionMode,
): { hourIndex: number; heightM?: number; snapTol: boolean } | null {
  const heightMode = mode === 'height';
  const magneticMode = mode === 'magnetic';
  if (position.x < view.left || position.x > view.left + view.plotWidth) return null;
  let candidateHours = visibleHours;
  if (view.dayPanels?.length) {
    const panel = panelContainingX(view.dayPanels, position.x);
    if (!panel || panel.endHourIndex < panel.startHourIndex) return null;
    if (panel.uncoveredSpans.some(span => position.x >= span.x && position.x <= span.x + span.width)) {
      return null;
    }
    candidateHours = visibleHours.filter(idx => idx >= panel.startHourIndex && idx <= panel.endHourIndex);
    if (!candidateHours.length) return null;
    const dataLeft = view.hours[candidateHours[0]!].x - panel.columnWidth / 2;
    const dataRight = view.hours[candidateHours.at(-1)!].x + panel.columnWidth / 2;
    if (position.x < dataLeft || position.x > dataRight) return null;
  } else {
    const dataLeft = view.hours[0].x - view.columnWidth / 2;
    const dataRight = view.hours.at(-1)!.x + view.columnWidth / 2;
    if (position.x < dataLeft || position.x > dataRight) return null;
  }
  const hourIndex = candidateHours.reduce((best, index) =>
    Math.abs(view.hours[index].x - position.x) < Math.abs(view.hours[best].x - position.x) ? index : best);
  if (position.y < view.top || position.y > view.bottom) {
    if (magneticMode && position.y >= 0 && position.y <= view.height) {
      return { hourIndex, snapTol: true };
    }
    return null;
  }
  if (magneticMode) {
    const tolM = visibleTolM(view, hourIndex);
    if (tolM !== null && Math.abs(position.y - heightToY(view, tolM)) <= TOL_SNAP_PX) {
      return { hourIndex, heightM: tolM, snapTol: true };
    }
    const minFloorM = minInspectHeightM(view, hourIndex);
    const rawM = yToHeight(view, position.y);
    const heightM = rawM <= minFloorM
      ? minFloorM
      : clamp(Math.round(rawM / 2) * 2, minFloorM, view.topM);
    return { hourIndex, heightM, snapTol: false };
  }
  const minFloorM = heightMode ? minInspectHeightM(view, hourIndex) : view.floorM;
  return { hourIndex, heightM: clamp(yToHeight(view, position.y), minFloorM, view.topM), snapTol: !heightMode };
}
