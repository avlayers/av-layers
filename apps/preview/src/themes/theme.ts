import { LIFT_EDGES } from '@av/contracts/layers';

/** Top of the lift palette, the last stop of every lift ramp. */
export const MAX_LIFT_M = LIFT_EDGES[LIFT_EDGES.length - 1] ?? 6700;

type LiftEncodingMode = 'smooth' | 'stepped-contour' | 'classic-raw';
type RainEncodingMode = 'smooth-iso' | 'radar-glow' | 'hatch' | 'classic-raw';
export type CloudStyleId = 'sunlit-veil' | 'nephanalysis' | 'satellite-ir';

export interface RgbaStop {
  readonly at: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

interface MiniScaleStop {
  readonly color: string;
  readonly label: string;
}

export interface IsobarThemeTokens {
  readonly minorColor: string;
  readonly majorColor: string;
  readonly haloColor: string;
  readonly textColor: string;
  readonly highColor: string;
  readonly lowColor: string;
}

/** Rain cell edge strokes and the inner cuff drawn by the rain animation. */
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

/** Paint tokens for the DEM relief, hillshade and OpenFreeMap vector layers. */
export interface BasemapTokens {
  readonly ocean: string;
  readonly relief: unknown[];
  readonly baseShadow: string;
  readonly baseHighlight: string;
  readonly baseAccent: string;
  readonly baseExaggeration: number;
  readonly topShadow: string;
  readonly topHighlight: string;
  readonly topAccent: string;
  readonly topExaggeration: number;
  readonly roadMajor: string;
  readonly roadMinor: string;
  readonly roadCase: string;
  readonly railway: string;
  readonly waterway: string;
  readonly borderMajor: string;
  readonly borderMinor: string;
  readonly aeroText: string;
  readonly peakText: string;
  readonly waterText: string;
  readonly waterHalo: string;
  readonly placeText: string;
  readonly poiText: string;
  readonly textHalo: string;
}

/** One SVG element of the 24×24 theme glyph shown in the theme picker. */
interface GlyphShape {
  readonly tag: 'circle' | 'ellipse' | 'path' | 'rect';
  readonly attrs: Readonly<Record<string, string>>;
}

/**
 * Everything that makes a map theme look the way it does. A theme is data: code
 * outside `themes/` reads these fields and never branches on a theme id.
 */
export interface ThemeRecord<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  /** Short name on the theme picker chip and tiles. */
  readonly chipLabel: string;
  readonly shortLabel: string;
  readonly summary: string;
  readonly swatch: string;
  /** False draws lift and rain tiles in the published server palette, unchanged. */
  readonly remap: boolean;
  readonly darkChrome: boolean;
  readonly liftMode: LiftEncodingMode;
  readonly liftContourStepM: number;
  readonly rainMode: RainEncodingMode;
  readonly cloudStyle: CloudStyleId;
  readonly isobar: IsobarThemeTokens;
  readonly cloudContours: CloudContourTokens;
  readonly rainEdge: RainEdgeTokens;
  /** Lift channel description in the dock. */
  readonly liftDetail: string;
  readonly liftStops: readonly RgbaStop[];
  readonly rainStops: readonly RgbaStop[];
  readonly cloudLegend: readonly MiniScaleStop[];
  readonly rainLegend: readonly MiniScaleStop[];
  readonly basemap: BasemapTokens;
  readonly glyph: readonly GlyphShape[];
}
