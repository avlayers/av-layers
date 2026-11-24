import { themeOption, type IsobarThemeTokens, type MapTheme } from './visual-theme';

export const CLOUD_STYLES = ['sunlit-veil', 'cu-overcast', 'nephanalysis', 'satellite-ir'] as const;
export type CloudStyleId = (typeof CLOUD_STYLES)[number];
export type CloudStyleChoice = 'auto' | CloudStyleId;

export const RAIN_STYLES = ['vignette-cuff', 'sigwx-scallop', 'inward-comb', 'wet-lens'] as const;
export type RainStyleId = (typeof RAIN_STYLES)[number];
export type RainStyleChoice = 'auto' | RainStyleId;

const CLOUD_SET: ReadonlySet<string> = new Set(CLOUD_STYLES);
const RAIN_SET: ReadonlySet<string> = new Set(RAIN_STYLES);

export function isCloudStyleId(value: string | null | undefined): value is CloudStyleId {
  return typeof value === 'string' && CLOUD_SET.has(value);
}

export function isRainStyleId(value: string | null | undefined): value is RainStyleId {
  return typeof value === 'string' && RAIN_SET.has(value);
}

export interface StyleChoiceOption<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly summary: string;
}

export const CLOUD_STYLE_OPTIONS: readonly StyleChoiceOption<CloudStyleChoice>[] = [
  { id: 'auto', label: 'Auto', summary: 'Matches active map layout' },
  { id: 'sunlit-veil', label: 'Veil', summary: 'Billowy sunlit Cu + neutral overcast ground shadow' },
  { id: 'cu-overcast', label: 'Cu / OD', summary: 'Bright cumulus puffs vs. overcast shadow rim' },
  { id: 'nephanalysis', label: 'Contours', summary: 'Crisp vector 40 / 75% cloud isolines + airy veil' },
  { id: 'satellite-ir', label: 'IR Deck', summary: 'Simulated IR deck (bright upper tops, gray low cloud)' }
];

export const RAIN_STYLE_OPTIONS: readonly StyleChoiceOption<RainStyleChoice>[] = [
  { id: 'auto', label: 'Auto', summary: 'Inner storm vignette cuff + crisp dry halo (#1)' },
  { id: 'vignette-cuff', label: 'Cuff', summary: 'Asymmetric inner storm cuff + crisp dry halo (#1)' },
  { id: 'sigwx-scallop', label: 'Scallop', summary: 'Aviation SIGWX scalloped storm perimeter (#2)' },
  { id: 'inward-comb', label: 'Ticks', summary: 'Inward-slanted rain-tick hachure comb (#3)' },
  { id: 'wet-lens', label: 'Bevel', summary: 'Wet-lens dark outer moat + specular inner lip (#4)' }
];

export interface RainEdgeTokens {
  readonly haloCasingColor: string;
  readonly dryHaloColor: string;
  readonly rimStrokeColor: string;
  readonly coreStrokeColor: string;
  readonly cuffRgb: readonly [number, number, number];
  readonly cuffMaxAlpha: number;
}

export interface CloudContourTokens {
  readonly brokenColor: string;
  readonly overcastColor: string;
  readonly haloColor: string;
}

export interface ResolvedChannelStyles {
  readonly theme: MapTheme;
  readonly darkChrome: boolean;
  readonly cloudStyle: CloudStyleId;
  readonly rainStyle: RainStyleId;
  readonly cloudContours: CloudContourTokens;
  readonly rainEdge: RainEdgeTokens;
  readonly isobar: IsobarThemeTokens;
}

export function defaultCloudStyleForTheme(theme: MapTheme): CloudStyleId {
  switch (theme) {
    case 'slate':
      return 'satellite-ir';
    case 'convergence':
      return 'cu-overcast';
    case 'chart':
    case 'alabaster':
    case 'blueprint':
    case 'cockpit':
      return 'nephanalysis';
    case 'stone':
    case 'classic':
    default:
      return 'sunlit-veil';
  }
}

export function defaultRainStyleForTheme(_theme: MapTheme): RainStyleId {
  return 'vignette-cuff';
}

export function resolveChannelStyles(
  theme: MapTheme,
  overrides?: { cloudStyle?: CloudStyleChoice; rainStyle?: RainStyleChoice }
): ResolvedChannelStyles {
  const opt = themeOption(theme);
  const dark = opt.darkChrome;
  const cloudStyle = overrides?.cloudStyle && overrides.cloudStyle !== 'auto'
    ? overrides.cloudStyle
    : defaultCloudStyleForTheme(theme);
  const rainStyle = overrides?.rainStyle && overrides.rainStyle !== 'auto'
    ? overrides.rainStyle
    : defaultRainStyleForTheme(theme);

  const cloudContours: CloudContourTokens = dark
    ? {
        brokenColor: 'rgba(186, 214, 242, 0.56)',
        overcastColor: 'rgba(226, 240, 253, 0.88)',
        haloColor: 'rgba(6, 12, 22, 0.90)'
      }
    : {
        brokenColor: 'rgba(51, 65, 85, 0.50)',
        overcastColor: 'rgba(15, 23, 42, 0.82)',
        haloColor: 'rgba(255, 255, 255, 0.92)'
      };

  const rainEdge: RainEdgeTokens = dark
    ? {
        haloCasingColor: 'rgba(4, 10, 20, 0.94)',
        dryHaloColor: 'rgba(4, 10, 20, 0.94)',
        rimStrokeColor: 'rgba(224, 242, 254, 0.96)',
        coreStrokeColor: 'rgba(255, 255, 255, 0.99)',
        cuffRgb: [186, 224, 248],
        cuffMaxAlpha: 88
      }
    : {
        haloCasingColor: 'rgba(15, 23, 42, 0.64)',
        dryHaloColor: 'rgba(255, 255, 255, 0.98)',
        rimStrokeColor: 'rgba(15, 23, 42, 0.88)',
        coreStrokeColor: 'rgba(15, 23, 42, 0.96)',
        cuffRgb: [18, 28, 44],
        cuffMaxAlpha: theme === 'classic' ? 108 : theme === 'cockpit' ? 102 : 96
      };

  return {
    theme,
    darkChrome: dark,
    cloudStyle,
    rainStyle,
    cloudContours,
    rainEdge,
    isobar: opt.isobar
  };
}

/** Resolves outer halo casing and inner perimeter stroke colors for the active `RainStyleId`. */
export function rainContourStrokePair(styles: ResolvedChannelStyles): {
  readonly haloColor: string;
  readonly showerColor: string;
} {
  const re = styles.rainEdge;
  if (styles.darkChrome) {
    return { haloColor: re.haloCasingColor, showerColor: re.rimStrokeColor };
  }
  if (styles.rainStyle === 'vignette-cuff' || styles.rainStyle === 'wet-lens') {
    return { haloColor: re.haloCasingColor, showerColor: re.dryHaloColor };
  }
  return { haloColor: re.dryHaloColor, showerColor: re.rimStrokeColor };
}
