// Day-panel lookups for stitched multi-day charts.

import type { WindgramDayPanel } from './windgram-view.ts';

export function panelContainingHour(panels: readonly WindgramDayPanel[] | undefined, hourIndex: number): WindgramDayPanel | null {
  if (!panels?.length) return null;
  return panels.find(p => p.endHourIndex >= p.startHourIndex && hourIndex >= p.startHourIndex && hourIndex <= p.endHourIndex) ?? null;
}

export function panelContainingX(panels: readonly WindgramDayPanel[] | undefined, x: number): WindgramDayPanel | null {
  if (!panels?.length) return null;
  return panels.find(p => x >= p.left && x <= p.left + p.width) ?? null;
}

/** True when `x` falls inside the panel with half a pixel of tolerance. */
export function panelShowsX(panel: WindgramDayPanel, x: number): boolean {
  return x >= panel.left - 0.5 && x <= panel.left + panel.width + 0.5;
}

/** Hour indices whose columns are drawn inside their panel. */
export function visiblePanelHourIndices(panels: readonly WindgramDayPanel[], hours: readonly { readonly x: number }[]): number[] {
  return panels.flatMap(panel => {
    if (panel.endHourIndex < panel.startHourIndex) return [];
    const inPanel: number[] = [];
    for (let idx = panel.startHourIndex; idx <= panel.endHourIndex; idx++) {
      if (panelShowsX(panel, hours[idx]!.x)) inPanel.push(idx);
    }
    return inPanel;
  });
}
