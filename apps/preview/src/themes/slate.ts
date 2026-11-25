import { SKY_COVER_TIERS } from '@av/contracts/layers';
import { MAX_LIFT_M, type ThemeRecord } from './theme';

export const slate: ThemeRecord<'slate'> = {
  id: 'slate',
  label: 'Dark Slate Radar',
  chipLabel: 'Slate',
  shortLabel: 'Dark Slate',
  summary: 'Charcoal relief · bronze–gold lift glow · satellite mist & animated rain',
  swatch: 'linear-gradient(135deg, #1b222c 0%, #c67e2a 55%, #38bdf8 100%)',
  remap: true,
  darkChrome: true,
  liftMode: 'smooth',
  liftContourStepM: 0,
  rainMode: 'radar-glow',
  cloudStyle: 'satellite-ir',
  isobar: { minorColor: 'rgba(186, 204, 226, 0.44)', majorColor: 'rgba(226, 238, 252, 0.84)', haloColor: 'rgba(11, 16, 24, 0.94)', textColor: '#e2e8f0', highColor: '#7dd3fc', lowColor: '#d8b4fe' },
  cloudContours: { brokenColor: 'rgba(186, 214, 242, 0.56)', overcastColor: 'rgba(226, 240, 253, 0.88)', haloColor: 'rgba(6, 12, 22, 0.90)' },
  rainEdge: {
    haloCasingColor: 'rgba(4, 10, 20, 0.94)', dryHaloColor: 'rgba(4, 10, 20, 0.94)',
    rimStrokeColor: 'rgba(224, 242, 254, 0.96)', coreStrokeColor: 'rgba(255, 255, 255, 0.99)',
    cuffRgb: [186, 224, 248], cuffMaxAlpha: 88
  },
  liftDetail: 'Usable thermal ceiling (Dark Slate palette)',
  liftStops: [
    { at: 0, r: 78, g: 48, b: 24, a: 16 },
    { at: 300, r: 112, g: 67, b: 30, a: 56 },
    { at: 650, r: 158, g: 94, b: 36, a: 126 },
    { at: 1200, r: 198, g: 126, b: 42, a: 176 },
    { at: 2000, r: 224, g: 158, b: 56, a: 206 },
    { at: 3050, r: 240, g: 190, b: 82, a: 226 },
    { at: 4250, r: 247, g: 215, b: 122, a: 240 },
    { at: 5500, r: 251, g: 231, b: 158, a: 246 },
    { at: MAX_LIFT_M, r: 253, g: 240, b: 184, a: 250 }
  ],
  rainStops: [
    { at: 0.1, r: 34, g: 211, b: 238, a: 112 },
    { at: 0.6, r: 56, g: 189, b: 248, a: 158 },
    { at: 2, r: 59, g: 130, b: 246, a: 196 },
    { at: 6, r: 99, g: 102, b: 241, a: 222 },
    { at: 15, r: 129, g: 82, b: 245, a: 238 },
    { at: 35, r: 168, g: 85, b: 247, a: 248 },
    { at: 55, r: 192, g: 132, b: 252, a: 252 }
  ],
  cloudLegend: [
    { color: 'rgba(186, 214, 242, 0.30)', label: '30% Cu' },
    { color: 'rgba(210, 228, 246, 0.52)', label: `${SKY_COVER_TIERS.broken}% BKN` },
    { color: 'rgba(228, 240, 252, 0.78)', label: `${SKY_COVER_TIERS.overcast}%+ OVC` }
  ],
  rainLegend: [
    { color: 'linear-gradient(90deg, #e0f2fe 0 22%, rgba(186,224,248,0.42) 55%, transparent 100%)', label: 'Dry halo + inner cuff' },
    { color: 'repeating-linear-gradient(115deg, #e0f2fe 0 2px, #020814 2px 4px)', label: 'Falling rain' },
    { color: 'rgba(224, 242, 254, 0.96)', label: '8+ mm/h squall' }
  ],
  basemap: {
    ocean: '#0d1520',
    relief: [
      'interpolate', ['linear'], ['elevation'],
      -1, '#0d1520', 0, '#0d1520', 0.5, '#1a222d', 300, '#1e2733', 900, '#242e3b',
      1800, '#2b3644', 2800, '#323f4e', 4000, '#3b4959', 5500, '#465668'
    ],
    baseShadow: '#05080d', baseHighlight: '#506073', baseAccent: '#090e16', baseExaggeration: 0.46,
    topShadow: 'rgba(4, 7, 12, 0.52)', topHighlight: 'rgba(148, 170, 196, 0.22)', topAccent: 'rgba(5, 9, 15, 0.42)', topExaggeration: 0.48,
    roadMajor: 'rgba(116, 134, 156, 0.34)', roadMinor: 'rgba(92, 108, 128, 0.22)', roadCase: 'rgba(20, 28, 38, 0.42)',
    railway: 'rgba(100, 114, 132, 0.28)', waterway: '#244563',
    borderMajor: 'rgba(148, 163, 184, 0.55)', borderMinor: 'rgba(100, 116, 139, 0.36)',
    aeroText: '#7cc4fa', peakText: '#86efac', waterText: '#60a5fa', waterHalo: 'rgba(10, 16, 24, 0.92)',
    placeText: '#e2e8f0', poiText: '#94a3b8', textHalo: 'rgba(10, 15, 23, 0.92)'
  },
  glyph: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '8.5' } },
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '4', 'stroke-dasharray': '2.5 2.5' } },
    { tag: 'path', attrs: { d: 'M12 12 18 6.5' } },
    { tag: 'circle', attrs: { cx: '15.5', cy: '14.5', r: '1.2', fill: 'currentColor', stroke: 'none' } }
  ]
};
