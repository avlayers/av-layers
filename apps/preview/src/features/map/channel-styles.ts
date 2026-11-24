import { themeOption, type MapTheme } from '../../themes/registry';
import type { CloudStyleId, IsobarThemeTokens } from '../../themes/theme';

interface RainEdgeTokens {
  readonly haloCasingColor: string;
  readonly dryHaloColor: string;
  readonly rimStrokeColor: string;
  readonly coreStrokeColor: string;
  readonly cuffRgb: readonly [number, number, number];
  readonly cuffMaxAlpha: number;
}

interface CloudContourTokens {
  readonly brokenColor: string;
  readonly overcastColor: string;
  readonly haloColor: string;
}

export interface ResolvedChannelStyles {
  readonly theme: MapTheme;
  readonly darkChrome: boolean;
  readonly cloudStyle: CloudStyleId;
  readonly cloudContours: CloudContourTokens;
  readonly rainEdge: RainEdgeTokens;
  readonly isobar: IsobarThemeTokens;
}

/** Every channel token for `theme`; cloud and rain styling are part of the theme. */
export function resolveChannelStyles(theme: MapTheme): ResolvedChannelStyles {
  const opt = themeOption(theme);
  const dark = opt.darkChrome;
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
        cuffMaxAlpha: opt.rainCuffMaxAlpha
      };

  return {
    theme,
    darkChrome: dark,
    cloudStyle: opt.cloudStyle,
    cloudContours,
    rainEdge,
    isobar: opt.isobar
  };
}

/** Outer halo casing and inner perimeter stroke colours for rain cell edges. */
export function rainContourStrokePair(styles: ResolvedChannelStyles): {
  readonly haloColor: string;
  readonly showerColor: string;
} {
  const re = styles.rainEdge;
  return { haloColor: re.haloCasingColor, showerColor: styles.darkChrome ? re.rimStrokeColor : re.dryHaloColor };
}
