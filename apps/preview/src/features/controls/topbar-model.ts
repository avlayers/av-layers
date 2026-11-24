import { MODEL_OPTIONS } from '@av/contracts/model-options';
import type { UnitSystem } from '@av/client';
import {
  CLOUD_STYLE_OPTIONS,
  RAIN_STYLE_OPTIONS,
  resolveChannelStyles,
  type CloudStyleChoice,
  type RainStyleChoice
} from '../map/channel-styles';
import { themeOption, type MapTheme } from '../map/visual-theme';
import { WIND_STYLE_LABELS, windStopLabel, type WindHeight, type WindStyle } from '../wind/wind-model';

export type WeatherChannelKey = 'lift' | 'wind' | 'clouds' | 'rain' | 'isobars';
export type DockChannelKey = WeatherChannelKey | 'peek';

const THEME_INFO_STORAGE_KEY = 'av.preview.themeInfoOpen';

export const THEME_CHIP_LABELS: Readonly<Record<MapTheme, string>> = {
  stone: 'Stone',
  slate: 'Slate',
  chart: 'Chart',
  alabaster: 'Alabaster',
  convergence: 'Converge',
  blueprint: 'Blueprint',
  cockpit: 'Cockpit',
  classic: 'Classic'
};

export const WIND_ENCODING_OPTIONS: ReadonlyArray<{ readonly id: WindStyle; readonly label: string; readonly summary: string }> = [
  { id: 'trails', label: 'Flow', summary: WIND_STYLE_LABELS.trails },
  { id: 'barbs', label: 'Barbs', summary: WIND_STYLE_LABELS.barbs },
  { id: 'hybrid', label: 'Mix', summary: WIND_STYLE_LABELS.hybrid }
];

export function formatWindLevelLabel(height: WindHeight, units: UnitSystem = 'metric'): string {
  if (height === 'surface') return 'SFC';
  if (height === 'lift') return 'TOL';
  return `${windStopLabel(height, units)} ${units === 'imperial' ? 'ft' : 'm'} AGL`;
}

export function modelApproxKm(modelId: string | null | undefined): number | null {
  if (!modelId) return null;
  const option = MODEL_OPTIONS.find(item => item.modelId === modelId);
  if (!option || !Number.isFinite(option.nominalDxMeters) || option.nominalDxMeters <= 0) return null;
  return Math.max(1, Math.round(option.nominalDxMeters / 1000));
}

export function formatModelResolutionKm(modelId: string | null | undefined): string | null {
  const km = modelApproxKm(modelId);
  return km !== null ? `${km} km` : null;
}

type ConfiguredModelId = (typeof MODEL_OPTIONS)[number]['modelId'];

const MODEL_REGION_SUBTITLES: Readonly<Record<ConfiguredModelId, string>> = {
  gfs: 'Global',
  'icon-eu': 'Europe',
  rrfs: 'North America',
  'av-wrf': 'Caucasus',
  'wrf-va-1km': 'Northern Virginia'
};

export function modelRegionSubtitle(modelId: string | null | undefined): string | undefined {
  return modelId && modelId in MODEL_REGION_SUBTITLES ? MODEL_REGION_SUBTITLES[modelId as ConfiguredModelId] : undefined;
}

export function cleanModelDisplayLabel(label: string): string {
  return label
    .replace(/\s+\d+(?:\.\d+)?\s*km\b/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

export function readThemeInfoOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(THEME_INFO_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeThemeInfoOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(THEME_INFO_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Ignore restricted storage environments.
  }
}

export interface ChannelDetailContext {
  readonly cloudStyle?: CloudStyleChoice;
  readonly rainStyle?: RainStyleChoice;
  readonly windStyle?: WindStyle;
  readonly windHeight?: WindHeight;
  readonly units?: UnitSystem;
}

export interface ChannelDescriptor {
  readonly key: DockChannelKey;
  readonly id: string;
  readonly shortLabel: string;
  readonly title: string;
  readonly hasStyles?: boolean;
  readonly shortcut?: string;
  readonly detail: (theme: MapTheme, ctx?: ChannelDetailContext) => string;
}

export const DOCK_CHANNELS: readonly ChannelDescriptor[] = [
  {
    key: 'lift',
    id: 'toggle-lift',
    shortLabel: 'Lift',
    title: 'Thermal Lift',
    detail: theme => theme === 'classic'
      ? 'Usable thermal ceiling in classic 22-step soaring palette'
      : `Usable thermal ceiling (${themeOption(theme).shortLabel} palette)`
  },
  {
    key: 'wind',
    id: 'toggle-wind',
    shortLabel: 'Wind',
    title: 'Wind',
    hasStyles: true,
    shortcut: 'W',
    detail: (_theme, ctx) => {
      const styleLabel = WIND_STYLE_LABELS[ctx?.windStyle ?? 'trails'];
      const level = formatWindLevelLabel(ctx?.windHeight ?? 'surface', ctx?.units ?? 'metric');
      return `${styleLabel} at ${level} · adjust height on the right WIND rail`;
    }
  },
  {
    key: 'clouds',
    id: 'toggle-clouds',
    shortLabel: 'Clouds',
    title: 'Cloud Cover',
    hasStyles: true,
    detail: (theme, ctx) => {
      const resolved = resolveChannelStyles(theme, ctx);
      const found = CLOUD_STYLE_OPTIONS.find(opt => opt.id === resolved.cloudStyle);
      return found?.summary ?? 'Smooth cumulus billows & neutral overcast ground shadow';
    }
  },
  {
    key: 'rain',
    id: 'toggle-rain',
    shortLabel: 'Rain',
    title: 'Precipitation',
    hasStyles: true,
    detail: (theme, ctx) => {
      const resolved = resolveChannelStyles(theme, ctx);
      const found = RAIN_STYLE_OPTIONS.find(opt => opt.id === resolved.rainStyle);
      return found?.summary ?? 'Asymmetric inner storm cuff + crisp dry halo & falling rain';
    }
  },
  {
    key: 'isobars',
    id: 'toggle-isobars',
    shortLabel: 'Isobars',
    title: 'Pressure Isobars',
    shortcut: 'I',
    detail: () => 'Sea-level contours every 2 hPa (bold 4 hPa) with H / L centers'
  },
  {
    key: 'peek',
    id: 'peek-toggle',
    shortLabel: 'Peek',
    title: 'Bare Terrain Peek',
    shortcut: 'Space / P',
    detail: () => 'Hold to inspect bare terrain & relief, or click to latch'
  }
];
