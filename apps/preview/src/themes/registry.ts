import { chart } from './chart';
import { classic } from './classic';
import { slate } from './slate';
import { stone } from './stone';

/** Every map theme in picker order. The first is the default. */
export const THEME_OPTIONS = [stone, slate, chart, classic] as const;

export type MapTheme = (typeof THEME_OPTIONS)[number]['id'];
type ThemeOption = (typeof THEME_OPTIONS)[number];

export const MAP_THEMES: readonly MapTheme[] = THEME_OPTIONS.map(theme => theme.id);
export const DEFAULT_THEME: MapTheme = THEME_OPTIONS[0].id;

const BY_ID: ReadonlyMap<string, ThemeOption> = new Map(THEME_OPTIONS.map(theme => [theme.id, theme]));

/** Retired theme ids still found in shared links and saved preferences. */
const RETIRED_THEMES: ReadonlyMap<string, MapTheme> = new Map([
  ['alabaster', 'stone'], ['convergence', 'stone'], ['blueprint', 'chart'], ['cockpit', 'chart']
]);

export function isMapTheme(value: string | null | undefined): value is MapTheme {
  return typeof value === 'string' && BY_ID.has(value);
}

/** Reads a theme id from a URL or preference, mapping retired ids to their nearest kept theme. */
export function parseMapTheme(value: string | null | undefined): MapTheme | null {
  if (isMapTheme(value)) return value;
  return value ? RETIRED_THEMES.get(value) ?? null : null;
}

/** The theme `step` places from `theme` in picker order, wrapping at either end. */
export function stepTheme(theme: MapTheme, step: -1 | 1): MapTheme {
  const index = Math.max(0, THEME_OPTIONS.findIndex(option => option.id === theme));
  return THEME_OPTIONS[(index + step + THEME_OPTIONS.length) % THEME_OPTIONS.length]!.id;
}

export function themeOption(theme: MapTheme): ThemeOption {
  return BY_ID.get(theme) ?? THEME_OPTIONS[0];
}
