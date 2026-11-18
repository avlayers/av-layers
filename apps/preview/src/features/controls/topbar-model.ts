import { MODEL_OPTIONS } from '@av/contracts/model-options';
import {
  CLOUD_STYLE_OPTIONS,
  RAIN_STYLE_OPTIONS,
  resolveChannelStyles,
  type CloudStyleChoice,
  type RainStyleChoice
} from '../map/channel-styles';
import { themeOption, type MapTheme } from '../map/visual-theme';

export type WeatherChannelKey = 'lift' | 'clouds' | 'rain' | 'isobars';
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
  xcskies: 'XC Skies'
};

/** Returns the approximate horizontal grid spacing in integer kilometers for a configured model. */
export function modelApproxKm(modelId: string | null | undefined): number | null {
  if (!modelId) return null;
  const option = MODEL_OPTIONS.find(item => item.modelId === modelId);
  if (!option || !Number.isFinite(option.nominalDxMeters) || option.nominalDxMeters <= 0) return null;
  return Math.max(1, Math.round(option.nominalDxMeters / 1000));
}

/** Formats a compact horizontal resolution badge such as `'28 km'`, `'7 km'`, `'3 km'`, or `'1 km'`. */
export function formatModelResolutionKm(modelId: string | null | undefined): string | null {
  const km = modelApproxKm(modelId);
  return km !== null ? `${km} km` : null;
}

/** Strips inline `'1 km'` style duplicates from long model labels when paired with a dedicated km badge. */
export function cleanModelDisplayLabel(label: string): string {
  return label.replace(/\s+\d+(?:\.\d+)?\s*km\b/i, '').trim();
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
    detail: theme => theme === 'xcskies'
      ? 'Usable thermal ceiling in classic 22-step XC Skies duckies'
      : `Usable thermal ceiling (${themeOption(theme).shortLabel} palette)`
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
