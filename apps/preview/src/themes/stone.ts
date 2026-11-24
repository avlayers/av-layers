import { MAX_LIFT_M, type ThemeRecord } from './theme';

export const stone: ThemeRecord<'stone'> = {
  id: 'stone',
  label: 'Daylight Stone',
  chipLabel: 'Stone',
  shortLabel: 'Daylight Stone',
  summary: 'Warm stone relief · amber–garnet lift · neutral cloud veil & animated rain',
  swatch: 'linear-gradient(135deg, #e5dfd3 0%, #ea7b36 55%, #8e1428 100%)',
  remap: true,
  darkChrome: false,
  liftMode: 'smooth',
  liftContourStepM: 0,
  rainMode: 'smooth-iso',
  cloudStyle: 'sunlit-veil',
  isobar: { minorColor: 'rgba(51, 65, 85, 0.56)', majorColor: 'rgba(15, 23, 42, 0.86)', haloColor: 'rgba(250, 248, 243, 0.95)', textColor: '#0f172a', highColor: '#0c4a6e', lowColor: '#581c87' },
  cloudContours: { brokenColor: 'rgba(51, 65, 85, 0.50)', overcastColor: 'rgba(15, 23, 42, 0.82)', haloColor: 'rgba(255, 255, 255, 0.92)' },
  rainEdge: {
    haloCasingColor: 'rgba(15, 23, 42, 0.64)', dryHaloColor: 'rgba(255, 255, 255, 0.98)',
    rimStrokeColor: 'rgba(15, 23, 42, 0.88)', coreStrokeColor: 'rgba(15, 23, 42, 0.96)',
    cuffRgb: [18, 28, 44], cuffMaxAlpha: 96
  },
  liftDetail: 'Usable thermal ceiling (Daylight Stone palette)',
  liftStops: [
    { at: 0, r: 245, g: 222, b: 174, a: 18 },
    { at: 300, r: 243, g: 206, b: 132, a: 58 },
    { at: 650, r: 240, g: 176, b: 86, a: 128 },
    { at: 1200, r: 236, g: 136, b: 56, a: 178 },
    { at: 2000, r: 226, g: 92, b: 44, a: 206 },
    { at: 3050, r: 199, g: 45, b: 42, a: 226 },
    { at: 4250, r: 142, g: 20, b: 40, a: 240 },
    { at: 5500, r: 98, g: 11, b: 33, a: 246 },
    { at: MAX_LIFT_M, r: 72, g: 7, b: 26, a: 250 }
  ],
  rainStops: [
    { at: 0.1, r: 103, g: 232, b: 249, a: 96 },
    { at: 0.6, r: 56, g: 196, b: 242, a: 146 },
    { at: 2, r: 37, g: 132, b: 235, a: 186 },
    { at: 6, r: 37, g: 84, b: 224, a: 214 },
    { at: 15, r: 49, g: 46, b: 145, a: 234 },
    { at: 35, r: 76, g: 29, b: 149, a: 246 },
    { at: 55, r: 59, g: 14, b: 118, a: 252 }
  ],
  cloudLegend: [
    { color: 'rgba(244, 247, 252, 0.78)', label: '30% Cu' },
    { color: 'rgba(148, 163, 184, 0.48)', label: '60% BKN' },
    { color: 'rgba(51, 65, 85, 0.64)', label: '85%+ OVC' }
  ],
  rainLegend: [
    { color: 'linear-gradient(90deg, #ffffff 0 22%, rgba(20,29,44,0.48) 55%, transparent 100%)', label: 'Dry halo + inner cuff' },
    { color: 'repeating-linear-gradient(115deg, #f8fafc 0 2px, #0f172a 2px 4px)', label: 'Falling rain' },
    { color: 'rgba(15, 23, 42, 0.94)', label: '8+ mm/h squall' }
  ],
  basemap: {
    ocean: '#a6bacb',
    relief: [
      'interpolate', ['linear'], ['elevation'],
      -1, '#a6bacb', 0, '#a6bacb', 0.5, '#d8dfd3', 200, '#dde0d4', 600, '#e2ddd2',
      1200, '#dfd6c8', 2000, '#d8cec0', 3000, '#d2c8ba', 4200, '#dcd7cf', 5500, '#ebe8e2'
    ],
    baseShadow: '#47505c', baseHighlight: '#fffdf9', baseAccent: '#56606e', baseExaggeration: 0.45,
    topShadow: 'rgba(38, 46, 56, 0.42)', topHighlight: 'rgba(255, 253, 248, 0.24)', topAccent: 'rgba(35, 42, 52, 0.34)', topExaggeration: 0.48,
    roadMajor: 'rgba(255, 253, 249, 0.62)', roadMinor: 'rgba(244, 240, 233, 0.44)', roadCase: 'rgba(182, 176, 166, 0.38)',
    railway: 'rgba(138, 132, 122, 0.45)', waterway: '#7fa4c2',
    borderMajor: 'rgba(82, 90, 100, 0.72)', borderMinor: 'rgba(108, 116, 126, 0.50)',
    aeroText: '#144d82', peakText: '#1f5427', waterText: '#2c689e', waterHalo: 'rgba(245, 248, 250, 0.88)',
    placeText: '#1e2730', poiText: '#4f5964', textHalo: 'rgba(250, 248, 244, 0.90)'
  },
  glyph: [
    { tag: 'circle', attrs: { cx: '17.5', cy: '6.5', r: '2.6' } },
    { tag: 'path', attrs: { d: 'M2.5 19.5 9.2 9.5l4.1 5.3 3-3.8 5.2 8.5Z' } }
  ]
};
