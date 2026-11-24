import { LIFT_COLORS, LIFT_EDGES } from '@av/contracts/layers';

export const MAP_THEMES = [
  'stone',
  'slate',
  'chart',
  'alabaster',
  'convergence',
  'blueprint',
  'cockpit',
  'classic'
] as const;

export type MapTheme = (typeof MAP_THEMES)[number];

const THEME_SET: ReadonlySet<string> = new Set(MAP_THEMES);
export function isMapTheme(value: string | null | undefined): value is MapTheme {
  return typeof value === 'string' && THEME_SET.has(value);
}

export type LiftEncodingMode = 'smooth' | 'stepped-contour' | 'isoline-wash' | 'core-rim' | 'ink-outline' | 'classic-raw';
export type RainEncodingMode = 'smooth-iso' | 'radar-glow' | 'hatch' | 'concentric-rings' | 'slant-streaks' | 'blueprint-hatch' | 'ink-hatch' | 'classic-raw';

export interface RgbaStop {
  readonly at: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface MiniScaleStop {
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

export interface RainPerimeterTokens {
  readonly showerColor: string;
  readonly squallColor: string;
  readonly haloColor: string;
}

export interface ThemeOption {
  readonly id: MapTheme;
  readonly label: string;
  readonly shortLabel: string;
  readonly summary: string;
  readonly swatch: string;
  readonly darkChrome: boolean;
  readonly liftMode: LiftEncodingMode;
  readonly liftContourStepM: number;
  readonly rainMode: RainEncodingMode;
  readonly isobar: IsobarThemeTokens;
  readonly rainPerimeter: RainPerimeterTokens;
}

const MAX_LIFT_M = LIFT_EDGES[LIFT_EDGES.length - 1] ?? 6700;

export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: 'stone',
    label: 'Daylight Stone',
    shortLabel: 'Daylight Stone',
    summary: 'Warm stone relief · amber–garnet lift · neutral cloud veil & animated rain',
    swatch: 'linear-gradient(135deg, #e5dfd3 0%, #ea7b36 55%, #8e1428 100%)',
    darkChrome: false,
    liftMode: 'smooth',
    liftContourStepM: 0,
    rainMode: 'smooth-iso',
    isobar: { minorColor: 'rgba(51, 65, 85, 0.56)', majorColor: 'rgba(15, 23, 42, 0.86)', haloColor: 'rgba(250, 248, 243, 0.95)', textColor: '#0f172a', highColor: '#0c4a6e', lowColor: '#581c87' },
    rainPerimeter: { showerColor: 'rgba(15, 23, 42, 0.72)', squallColor: 'rgba(15, 23, 42, 0.94)', haloColor: 'rgba(240, 249, 255, 0.92)' }
  },
  {
    id: 'slate',
    label: 'Dark Slate Radar',
    shortLabel: 'Dark Slate',
    summary: 'Charcoal relief · bronze–gold lift glow · satellite mist & animated rain',
    swatch: 'linear-gradient(135deg, #1b222c 0%, #c67e2a 55%, #38bdf8 100%)',
    darkChrome: true,
    liftMode: 'smooth',
    liftContourStepM: 0,
    rainMode: 'radar-glow',
    isobar: { minorColor: 'rgba(186, 204, 226, 0.44)', majorColor: 'rgba(226, 238, 252, 0.84)', haloColor: 'rgba(11, 16, 24, 0.94)', textColor: '#e2e8f0', highColor: '#7dd3fc', lowColor: '#d8b4fe' },
    rainPerimeter: { showerColor: 'rgba(125, 211, 252, 0.76)', squallColor: 'rgba(224, 242, 254, 0.96)', haloColor: 'rgba(8, 15, 26, 0.92)' }
  },
  {
    id: 'chart',
    label: 'Chart-Crisp Topo',
    shortLabel: 'Chart Topo',
    summary: '500 m lift terraces · dot-stipple clouds · teal isobars & animated rain',
    swatch: 'linear-gradient(135deg, #f3efe6 0%, #d97724 55%, #0f4c5c 100%)',
    darkChrome: false,
    liftMode: 'stepped-contour',
    liftContourStepM: 500,
    rainMode: 'hatch',
    isobar: { minorColor: 'rgba(15, 76, 92, 0.56)', majorColor: 'rgba(11, 56, 68, 0.88)', haloColor: 'rgba(250, 247, 240, 0.96)', textColor: '#0b3844', highColor: '#0c4a6e', lowColor: '#581c87' },
    rainPerimeter: { showerColor: 'rgba(15, 23, 42, 0.74)', squallColor: 'rgba(15, 23, 42, 0.95)', haloColor: 'rgba(255, 255, 255, 0.94)' }
  },
  {
    id: 'alabaster',
    label: 'Alabaster Isoline',
    shortLabel: 'Alabaster Isoline',
    summary: 'Airy terrain · bold 750 m lift rings · nephanalysis clouds & animated rain',
    swatch: 'linear-gradient(135deg, #f6f5f2 0%, #e0533c 55%, #334155 100%)',
    darkChrome: false,
    liftMode: 'isoline-wash',
    liftContourStepM: 750,
    rainMode: 'concentric-rings',
    isobar: { minorColor: 'rgba(71, 85, 105, 0.50)', majorColor: 'rgba(30, 41, 59, 0.84)', haloColor: 'rgba(255, 255, 255, 0.96)', textColor: '#1e293b', highColor: '#0369a1', lowColor: '#6b21a8' },
    rainPerimeter: { showerColor: 'rgba(30, 41, 59, 0.72)', squallColor: 'rgba(15, 23, 42, 0.94)', haloColor: 'rgba(255, 255, 255, 0.94)' }
  },
  {
    id: 'convergence',
    label: 'Cool-Stone Convergence',
    shortLabel: 'Convergence',
    summary: 'Cool dove relief · core-rimmed streets · rimmed Cu puffs & animated rain',
    swatch: 'linear-gradient(135deg, #dce3ea 0%, #f97316 55%, #be185d 100%)',
    darkChrome: false,
    liftMode: 'core-rim',
    liftContourStepM: 1250,
    rainMode: 'slant-streaks',
    isobar: { minorColor: 'rgba(51, 65, 85, 0.52)', majorColor: 'rgba(15, 23, 42, 0.86)', haloColor: 'rgba(241, 245, 249, 0.95)', textColor: '#0f172a', highColor: '#0f766e', lowColor: '#581c87' },
    rainPerimeter: { showerColor: 'rgba(15, 23, 42, 0.74)', squallColor: 'rgba(15, 23, 42, 0.95)', haloColor: 'rgba(248, 250, 252, 0.94)' }
  },
  {
    id: 'blueprint',
    label: 'Blueprint Synoptic',
    shortLabel: 'Blueprint',
    summary: 'Prussian blueprint · copper–gold contours · chalk stipple & animated rain',
    swatch: 'linear-gradient(135deg, #0e2238 0%, #ea580c 55%, #22d3ee 100%)',
    darkChrome: true,
    liftMode: 'ink-outline',
    liftContourStepM: 1000,
    rainMode: 'blueprint-hatch',
    isobar: { minorColor: 'rgba(125, 211, 252, 0.46)', majorColor: 'rgba(224, 242, 254, 0.88)', haloColor: 'rgba(8, 21, 36, 0.95)', textColor: '#e0f2fe', highColor: '#67e8f9', lowColor: '#e9d5ff' },
    rainPerimeter: { showerColor: 'rgba(165, 243, 252, 0.78)', squallColor: 'rgba(236, 254, 255, 0.96)', haloColor: 'rgba(6, 17, 30, 0.92)' }
  },
  {
    id: 'cockpit',
    label: 'High-Sun Cockpit',
    shortLabel: 'High-Sun Cockpit',
    summary: 'Glare-proof paper · ink-outlined lift · graphic clouds & animated rain',
    swatch: 'linear-gradient(135deg, #ffffff 0%, #dc2626 55%, #0f172a 100%)',
    darkChrome: false,
    liftMode: 'ink-outline',
    liftContourStepM: 1000,
    rainMode: 'ink-hatch',
    isobar: { minorColor: 'rgba(15, 23, 42, 0.62)', majorColor: 'rgba(0, 0, 0, 0.92)', haloColor: 'rgba(255, 255, 255, 0.97)', textColor: '#000000', highColor: '#1e3a8a', lowColor: '#581c87' },
    rainPerimeter: { showerColor: 'rgba(0, 0, 0, 0.78)', squallColor: 'rgba(0, 0, 0, 0.96)', haloColor: 'rgba(255, 255, 255, 0.96)' }
  },
  {
    id: 'classic',
    label: 'Classic Soaring',
    shortLabel: 'Classic',
    summary: 'Natural shaded relief · 22-step classic palette · sunlit cloud veil & cuffed rain',
    swatch: `linear-gradient(135deg, ${LIFT_COLORS[3]} 0%, ${LIFT_COLORS[7]} 35%, ${LIFT_COLORS[9]} 68%, ${LIFT_COLORS[13]} 100%)`,
    darkChrome: false,
    liftMode: 'classic-raw',
    liftContourStepM: 0,
    rainMode: 'classic-raw',
    isobar: { minorColor: 'rgba(30, 41, 59, 0.58)', majorColor: 'rgba(15, 23, 42, 0.90)', haloColor: 'rgba(255, 255, 255, 0.96)', textColor: '#0f172a', highColor: '#0c4a6e', lowColor: '#581c87' },
    rainPerimeter: { showerColor: 'rgba(15, 23, 42, 0.80)', squallColor: 'rgba(15, 23, 42, 0.96)', haloColor: 'rgba(255, 255, 255, 0.95)' }
  }
];

export function themeOption(theme: MapTheme): ThemeOption {
  return THEME_OPTIONS.find(item => item.id === theme) ?? THEME_OPTIONS[0]!;
}

const STONE_LIFT_STOPS: readonly RgbaStop[] = [
  { at: 0, r: 245, g: 222, b: 174, a: 18 },
  { at: 300, r: 243, g: 206, b: 132, a: 58 },
  { at: 650, r: 240, g: 176, b: 86, a: 128 },
  { at: 1200, r: 236, g: 136, b: 56, a: 178 },
  { at: 2000, r: 226, g: 92, b: 44, a: 206 },
  { at: 3050, r: 199, g: 45, b: 42, a: 226 },
  { at: 4250, r: 142, g: 20, b: 40, a: 240 },
  { at: 5500, r: 98, g: 11, b: 33, a: 246 },
  { at: MAX_LIFT_M, r: 72, g: 7, b: 26, a: 250 }
];

const SLATE_LIFT_STOPS: readonly RgbaStop[] = [
  { at: 0, r: 78, g: 48, b: 24, a: 16 },
  { at: 300, r: 112, g: 67, b: 30, a: 56 },
  { at: 650, r: 158, g: 94, b: 36, a: 126 },
  { at: 1200, r: 198, g: 126, b: 42, a: 176 },
  { at: 2000, r: 224, g: 158, b: 56, a: 206 },
  { at: 3050, r: 240, g: 190, b: 82, a: 226 },
  { at: 4250, r: 247, g: 215, b: 122, a: 240 },
  { at: 5500, r: 251, g: 231, b: 158, a: 246 },
  { at: MAX_LIFT_M, r: 253, g: 240, b: 184, a: 250 }
];

const CHART_LIFT_STOPS: readonly RgbaStop[] = [
  { at: 0, r: 248, g: 231, b: 180, a: 34 },
  { at: 500, r: 244, g: 199, b: 112, a: 108 },
  { at: 1000, r: 236, g: 155, b: 66, a: 154 },
  { at: 1800, r: 221, g: 106, b: 44, a: 188 },
  { at: 2800, r: 194, g: 58, b: 40, a: 212 },
  { at: 4000, r: 150, g: 28, b: 42, a: 230 },
  { at: 5400, r: 106, g: 18, b: 45, a: 242 },
  { at: MAX_LIFT_M, r: 78, g: 12, b: 38, a: 248 }
];

const ALABASTER_LIFT_STOPS: readonly RgbaStop[] = [
  { at: 0, r: 252, g: 228, b: 190, a: 12 },
  { at: 500, r: 249, g: 196, b: 132, a: 44 },
  { at: 1200, r: 242, g: 148, b: 84, a: 76 },
  { at: 2200, r: 228, g: 94, b: 62, a: 104 },
  { at: 3400, r: 198, g: 46, b: 54, a: 128 },
  { at: 4800, r: 154, g: 22, b: 56, a: 148 },
  { at: MAX_LIFT_M, r: 116, g: 14, b: 48, a: 162 }
];

const CONVERGENCE_LIFT_STOPS: readonly RgbaStop[] = [
  { at: 0, r: 253, g: 230, b: 138, a: 22 },
  { at: 350, r: 251, g: 191, b: 36, a: 76 },
  { at: 800, r: 249, g: 138, b: 24, a: 144 },
  { at: 1600, r: 239, g: 83, b: 39, a: 190 },
  { at: 2600, r: 214, g: 36, b: 74, a: 218 },
  { at: 3800, r: 166, g: 18, b: 92, a: 236 },
  { at: 5200, r: 118, g: 14, b: 84, a: 246 },
  { at: MAX_LIFT_M, r: 86, g: 10, b: 66, a: 252 }
];

const BLUEPRINT_LIFT_STOPS: readonly RgbaStop[] = [
  { at: 0, r: 124, g: 45, b: 18, a: 22 },
  { at: 400, r: 168, g: 62, b: 22, a: 78 },
  { at: 900, r: 214, g: 92, b: 28, a: 146 },
  { at: 1700, r: 242, g: 132, b: 40, a: 192 },
  { at: 2800, r: 251, g: 176, b: 68, a: 220 },
  { at: 4100, r: 253, g: 214, b: 118, a: 238 },
  { at: 5400, r: 254, g: 238, b: 176, a: 248 },
  { at: MAX_LIFT_M, r: 255, g: 249, b: 214, a: 252 }
];

const COCKPIT_LIFT_STOPS: readonly RgbaStop[] = [
  { at: 0, r: 254, g: 215, b: 102, a: 54 },
  { at: 400, r: 248, g: 178, b: 42, a: 132 },
  { at: 1000, r: 238, g: 118, b: 24, a: 188 },
  { at: 1900, r: 220, g: 52, b: 30, a: 218 },
  { at: 3000, r: 176, g: 18, b: 42, a: 238 },
  { at: 4300, r: 122, g: 14, b: 58, a: 248 },
  { at: 5600, r: 78, g: 12, b: 64, a: 252 },
  { at: MAX_LIFT_M, r: 52, g: 8, b: 48, a: 255 }
];

const STONE_RAIN_STOPS: readonly RgbaStop[] = [
  { at: 0.1, r: 103, g: 232, b: 249, a: 96 },
  { at: 0.6, r: 56, g: 196, b: 242, a: 146 },
  { at: 2, r: 37, g: 132, b: 235, a: 186 },
  { at: 6, r: 37, g: 84, b: 224, a: 214 },
  { at: 15, r: 49, g: 46, b: 145, a: 234 },
  { at: 35, r: 76, g: 29, b: 149, a: 246 },
  { at: 55, r: 59, g: 14, b: 118, a: 252 }
];

const SLATE_RAIN_STOPS: readonly RgbaStop[] = [
  { at: 0.1, r: 34, g: 211, b: 238, a: 112 },
  { at: 0.6, r: 56, g: 189, b: 248, a: 158 },
  { at: 2, r: 59, g: 130, b: 246, a: 196 },
  { at: 6, r: 99, g: 102, b: 241, a: 222 },
  { at: 15, r: 129, g: 82, b: 245, a: 238 },
  { at: 35, r: 168, g: 85, b: 247, a: 248 },
  { at: 55, r: 192, g: 132, b: 252, a: 252 }
];

const BLUEPRINT_RAIN_STOPS: readonly RgbaStop[] = [
  { at: 0.1, r: 103, g: 232, b: 249, a: 138 },
  { at: 1, r: 34, g: 211, b: 238, a: 186 },
  { at: 4, r: 56, g: 189, b: 248, a: 218 },
  { at: 12, r: 125, g: 211, b: 252, a: 242 },
  { at: 35, r: 224, g: 242, b: 254, a: 252 }
];

export function sampleStops(stops: readonly RgbaStop[], value: number, out: Uint8Array | Uint8ClampedArray, offset = 0): void {
  if (value <= stops[0]!.at) {
    const first = stops[0]!;
    out[offset] = first.r; out[offset + 1] = first.g; out[offset + 2] = first.b; out[offset + 3] = first.a;
    return;
  }
  const last = stops[stops.length - 1]!;
  if (value >= last.at) {
    out[offset] = last.r; out[offset + 1] = last.g; out[offset + 2] = last.b; out[offset + 3] = last.a;
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    const right = stops[i]!;
    if (value <= right.at) {
      const left = stops[i - 1]!;
      const t = (value - left.at) / Math.max(1e-6, right.at - left.at);
      out[offset] = Math.round(left.r + (right.r - left.r) * t);
      out[offset + 1] = Math.round(left.g + (right.g - left.g) * t);
      out[offset + 2] = Math.round(left.b + (right.b - left.b) * t);
      out[offset + 3] = Math.round(left.a + (right.a - left.a) * t);
      return;
    }
  }
}

export function liftStopsForTheme(theme: MapTheme): readonly RgbaStop[] {
  switch (theme) {
    case 'slate': return SLATE_LIFT_STOPS;
    case 'chart': return CHART_LIFT_STOPS;
    case 'alabaster': return ALABASTER_LIFT_STOPS;
    case 'convergence': return CONVERGENCE_LIFT_STOPS;
    case 'blueprint': return BLUEPRINT_LIFT_STOPS;
    case 'cockpit': return COCKPIT_LIFT_STOPS;
    default: return STONE_LIFT_STOPS;
  }
}

export function rainStopsForTheme(theme: MapTheme): readonly RgbaStop[] {
  if (theme === 'slate') return SLATE_RAIN_STOPS;
  if (theme === 'blueprint') return BLUEPRINT_RAIN_STOPS;
  return STONE_RAIN_STOPS;
}

function rgbaCss(r: number, g: number, b: number, a = 255): string {
  return a >= 254 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}

export function themeLiftLegendColors(theme: MapTheme, edges: readonly number[] = LIFT_EDGES, count = 22): string[] {
  if (theme === 'classic') return LIFT_COLORS.slice(0, count);
  const stops = liftStopsForTheme(theme);
  const opt = themeOption(theme);
  const pixel = new Uint8Array(4);
  const colors: string[] = [];
  for (let i = 0; i < count; i++) {
    const lo = edges[i] ?? 0;
    const hi = edges[i + 1] ?? (lo + 300);
    const mid = (lo + hi) * 0.5;
    const sampleAt = opt.liftMode === 'stepped-contour' && opt.liftContourStepM > 0
      ? Math.floor(mid / opt.liftContourStepM) * opt.liftContourStepM + opt.liftContourStepM * 0.5
      : mid;
    sampleStops(stops, sampleAt, pixel, 0);
    colors.push(rgbaCss(pixel[0]!, pixel[1]!, pixel[2]!, Math.max(96, pixel[3]!)));
  }
  return colors;
}

export function themeRainLegendStops(theme: MapTheme): readonly MiniScaleStop[] {
  const opt = themeOption(theme);
  const cuffBg = opt.darkChrome
    ? 'linear-gradient(90deg, #e0f2fe 0 22%, rgba(186,224,248,0.42) 55%, transparent 100%)'
    : 'linear-gradient(90deg, #ffffff 0 22%, rgba(20,29,44,0.48) 55%, transparent 100%)';
  const streakBg = opt.darkChrome
    ? 'repeating-linear-gradient(115deg, #e0f2fe 0 2px, #020814 2px 4px)'
    : 'repeating-linear-gradient(115deg, #f8fafc 0 2px, #0f172a 2px 4px)';
  return [
    { color: cuffBg, label: 'Dry halo + inner cuff' },
    { color: streakBg, label: 'Falling rain' },
    { color: opt.rainPerimeter.squallColor, label: '8+ mm/h squall' }
  ];
}

export function themeCloudLegendStops(theme: MapTheme): readonly MiniScaleStop[] {
  if (theme === 'slate' || theme === 'blueprint') {
    return [
      { color: 'rgba(186, 214, 242, 0.30)', label: '30% Cu' },
      { color: 'rgba(210, 228, 246, 0.52)', label: '60% BKN' },
      { color: 'rgba(228, 240, 252, 0.78)', label: '85%+ OVC' }
    ];
  }
  return [
    { color: 'rgba(244, 247, 252, 0.78)', label: '30% Cu' },
    { color: 'rgba(148, 163, 184, 0.48)', label: '60% BKN' },
    { color: 'rgba(51, 65, 85, 0.64)', label: '85%+ OVC' }
  ];
}
