import type { LegendStop } from './legend-model';

const DOCK_VIEW_IDS = ['capsule'] as const;
export type DockViewId = (typeof DOCK_VIEW_IDS)[number];
export const DEFAULT_DOCK_VIEW: DockViewId = 'capsule';

export interface DockViewOption {
  readonly id: DockViewId;
  readonly label: string;
  readonly shortLabel: string;
  readonly summary: string;
  readonly showSteppers: boolean;
  readonly showLoupe: boolean;
}

export const DOCK_VIEW_OPTIONS: readonly DockViewOption[] = [
  {
    id: 'capsule',
    label: 'Slim capsule',
    shortLabel: 'Capsule',
    summary: '54 px unified dock with top spectrum hairline, inline day tabs, scrub loupe, and thumb steppers',
    showSteppers: true,
    showLoupe: true
  }
];

export function isDockViewId(value: string | null | undefined): value is DockViewId {
  return value !== null && value !== undefined && (DOCK_VIEW_IDS as readonly string[]).includes(value);
}

export function dockViewOption(id: DockViewId): DockViewOption {
  return DOCK_VIEW_OPTIONS.find(option => option.id === id) ?? DOCK_VIEW_OPTIONS[0]!;
}

export function spectrumGradientCss(stops: readonly LegendStop[]): string {
  if (!stops.length) return 'transparent';
  if (stops.length === 1) return stops[0]!.color;
  const parts = stops.map((stop, index) => {
    const pct = Math.round((index / (stops.length - 1)) * 1000) / 10;
    return `${stop.color} ${pct}%`;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

export function legendRangeSummary(stops: readonly LegendStop[]): string {
  const labeled = stops.map(stop => stop.label.trim()).filter(Boolean);
  if (labeled.length >= 2) return `${labeled[0]}–${labeled.at(-1)}`;
  return labeled[0] ?? '';
}
