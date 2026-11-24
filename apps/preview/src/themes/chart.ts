import { MAX_LIFT_M, type ThemeRecord } from './theme';
import { stone } from './stone';

export const chart: ThemeRecord<'chart'> = {
  id: 'chart',
  label: 'Chart-Crisp Topo',
  chipLabel: 'Chart',
  shortLabel: 'Chart Topo',
  summary: '500 m lift terraces · dot-stipple clouds · teal isobars & animated rain',
  swatch: 'linear-gradient(135deg, #f3efe6 0%, #d97724 55%, #0f4c5c 100%)',
  remap: true,
  darkChrome: false,
  liftMode: 'stepped-contour',
  liftContourStepM: 500,
  rainMode: 'hatch',
  cloudStyle: 'nephanalysis',
  isobar: { minorColor: 'rgba(15, 76, 92, 0.56)', majorColor: 'rgba(11, 56, 68, 0.88)', haloColor: 'rgba(250, 247, 240, 0.96)', textColor: '#0b3844', highColor: '#0c4a6e', lowColor: '#581c87' },
  rainPerimeter: { showerColor: 'rgba(15, 23, 42, 0.74)', squallColor: 'rgba(15, 23, 42, 0.95)', haloColor: 'rgba(255, 255, 255, 0.94)' },
  liftDetail: 'Usable thermal ceiling (Chart Topo palette)',
  liftStops: [
    { at: 0, r: 248, g: 231, b: 180, a: 34 },
    { at: 500, r: 244, g: 199, b: 112, a: 108 },
    { at: 1000, r: 236, g: 155, b: 66, a: 154 },
    { at: 1800, r: 221, g: 106, b: 44, a: 188 },
    { at: 2800, r: 194, g: 58, b: 40, a: 212 },
    { at: 4000, r: 150, g: 28, b: 42, a: 230 },
    { at: 5400, r: 106, g: 18, b: 45, a: 242 },
    { at: MAX_LIFT_M, r: 78, g: 12, b: 38, a: 248 }
  ],
  rainStops: stone.rainStops,
  cloudLegend: [
    { color: 'rgba(244, 247, 252, 0.78)', label: '30% Cu' },
    { color: 'rgba(148, 163, 184, 0.48)', label: '60% BKN' },
    { color: 'rgba(51, 65, 85, 0.64)', label: '85%+ OVC' }
  ],
  rainCuffMaxAlpha: 96,
  basemap: {
    ocean: '#9ec2d8',
    relief: [
      'interpolate', ['linear'], ['elevation'],
      -1, '#9ec2d8', 0, '#9ec2d8', 0.5, '#dde5d0', 250, '#e5e7d3', 700, '#ece6d8',
      1400, '#e6dccb', 2200, '#dfd0bc', 3200, '#d8c5ae', 4500, '#e2d8ca'
    ],
    baseShadow: '#5b5346', baseHighlight: '#fffdf7', baseAccent: '#695f50', baseExaggeration: 0.48,
    topShadow: 'rgba(52, 46, 38, 0.44)', topHighlight: 'rgba(255, 252, 244, 0.25)', topAccent: 'rgba(46, 40, 32, 0.36)', topExaggeration: 0.50,
    roadMajor: 'rgba(255, 254, 250, 0.72)', roadMinor: 'rgba(245, 241, 232, 0.50)', roadCase: 'rgba(168, 158, 142, 0.45)',
    railway: 'rgba(124, 114, 100, 0.50)', waterway: '#699bc2',
    borderMajor: 'rgba(92, 76, 108, 0.76)', borderMinor: 'rgba(116, 102, 128, 0.52)',
    aeroText: '#134074', peakText: '#1b4332', waterText: '#1d6396', waterHalo: 'rgba(250, 248, 242, 0.90)',
    placeText: '#1c1917', poiText: '#57534e', textHalo: 'rgba(253, 251, 246, 0.92)'
  },
  glyph: [
    { tag: 'ellipse', attrs: { cx: '12', cy: '13', rx: '9.2', ry: '6.4' } },
    { tag: 'ellipse', attrs: { cx: '12.4', cy: '12.6', rx: '5.8', ry: '3.8' } },
    { tag: 'ellipse', attrs: { cx: '12.8', cy: '12.2', rx: '2.4', ry: '1.5' } }
  ]
};
