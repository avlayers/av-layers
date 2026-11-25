import { LIFT_COLORS, SKY_COVER_TIERS } from '@av/contracts/layers';
import type { ThemeRecord } from './theme';
import { stone } from './stone';

export const classic: ThemeRecord<'classic'> = {
  id: 'classic',
  label: 'Classic Soaring',
  chipLabel: 'Classic',
  shortLabel: 'Classic',
  summary: 'Natural shaded relief · 22-step classic palette · sunlit cloud veil & cuffed rain',
  swatch: `linear-gradient(135deg, ${LIFT_COLORS[3]} 0%, ${LIFT_COLORS[7]} 35%, ${LIFT_COLORS[9]} 68%, ${LIFT_COLORS[13]} 100%)`,
  remap: false,
  darkChrome: false,
  liftMode: 'classic-raw',
  liftContourStepM: 0,
  rainMode: 'classic-raw',
  cloudStyle: 'sunlit-veil',
  isobar: { minorColor: 'rgba(30, 41, 59, 0.58)', majorColor: 'rgba(15, 23, 42, 0.90)', haloColor: 'rgba(255, 255, 255, 0.96)', textColor: '#0f172a', highColor: '#0c4a6e', lowColor: '#581c87' },
  cloudContours: { brokenColor: 'rgba(51, 65, 85, 0.50)', overcastColor: 'rgba(15, 23, 42, 0.82)', haloColor: 'rgba(255, 255, 255, 0.92)' },
  rainEdge: {
    haloCasingColor: 'rgba(15, 23, 42, 0.64)', dryHaloColor: 'rgba(255, 255, 255, 0.98)',
    rimStrokeColor: 'rgba(15, 23, 42, 0.88)', coreStrokeColor: 'rgba(15, 23, 42, 0.96)',
    cuffRgb: [18, 28, 44], cuffMaxAlpha: 108
  },
  liftDetail: 'Usable thermal ceiling in classic 22-step soaring palette',
  // Classic draws the published palette unchanged (remap: false); the record type
  // still requires ramps, so it carries Stone's.
  liftStops: stone.liftStops,
  rainStops: stone.rainStops,
  cloudLegend: [
    { color: 'rgba(244, 247, 252, 0.78)', label: '30% Cu' },
    { color: 'rgba(148, 163, 184, 0.48)', label: `${SKY_COVER_TIERS.broken}% BKN` },
    { color: 'rgba(51, 65, 85, 0.64)', label: `${SKY_COVER_TIERS.overcast}%+ OVC` }
  ],
  rainLegend: [
    { color: 'linear-gradient(90deg, #ffffff 0 22%, rgba(20,29,44,0.48) 55%, transparent 100%)', label: 'Dry halo + inner cuff' },
    { color: 'repeating-linear-gradient(115deg, #f8fafc 0 2px, #0f172a 2px 4px)', label: 'Falling rain' },
    { color: 'rgba(15, 23, 42, 0.96)', label: '8+ mm/h squall' }
  ],
  basemap: {
    ocean: '#a8c8df',
    relief: [
      'interpolate', ['linear'], ['elevation'],
      -1, '#a8c8df', 0, '#a8c8df', 0.5, '#cadbb8', 350, '#d4dfc0', 900, '#e1dcb9',
      1700, '#dfd0ae', 2600, '#d4bf9b', 3600, '#cab292', 4800, '#ddd6cc', 6000, '#f2efe9'
    ],
    baseShadow: '#3f443b', baseHighlight: '#fffef9', baseAccent: '#4b5045', baseExaggeration: 0.56,
    topShadow: 'rgba(34, 38, 30, 0.44)', topHighlight: 'rgba(255, 253, 246, 0.22)', topAccent: 'rgba(30, 34, 26, 0.36)', topExaggeration: 0.48,
    roadMajor: 'hsl(0, 0%, 97%)', roadMinor: 'hsl(0, 0%, 87%)', roadCase: '#dedede',
    railway: 'hsl(34, 12%, 66%)', waterway: 'hsl(205, 56%, 73%)',
    borderMajor: 'hsl(0, 0%, 40%)', borderMinor: 'hsl(0, 0%, 50%)',
    aeroText: 'hsl(209, 100%, 36%)', peakText: 'hsl(115, 100%, 20%)',
    waterText: '#2280dd', waterHalo: '#ffffff',
    placeText: '#000000', poiText: '#666666', textHalo: '#ffffff'
  },
  glyph: [
    { tag: 'path', attrs: { d: 'M2.5 9.5 12 5.5l9.5 4-9.5-1.6-9.5 1.6Z' } },
    { tag: 'path', attrs: { d: 'M4 14.5h16M6 18h12' } }
  ]
};
