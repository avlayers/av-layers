import { themeOption, type MapTheme } from '../../themes/registry';
import type { CloudContourTokens, CloudStyleId, IsobarThemeTokens, RainEdgeTokens } from '../../themes/theme';

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
  return {
    theme,
    darkChrome: opt.darkChrome,
    cloudStyle: opt.cloudStyle,
    cloudContours: opt.cloudContours,
    rainEdge: opt.rainEdge,
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
