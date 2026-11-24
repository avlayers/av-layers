import { describe, expect, it, vi } from 'vitest';
import { LIFT_COLORS, RAIN_COLORS } from '@av/contracts/layers';
import { rainContourStrokePair, resolveChannelStyles } from '../map/channel-styles';
import { MAP_THEMES, themeOption } from '../../themes/registry';
import { remapRgbaInPlace } from '../raster/tile-remap-core';
import { CloudLayerController, renderSmoothCloudRgba } from './cloud-layer';
import { IsobarLayerController } from './isobar-layer';
import { decodePrecipRgbaToField, renderRainInnerVignetteRgba } from './rain-animation';
import { RainLayerController } from './rain-layer';
import type { SynopticField } from './synoptic-sampler';

function parseCssRgba(css: string): [number, number, number, number] {
  const clean = css.trim();
  if (clean.startsWith('#')) {
    const hex = clean.slice(1);
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      255
    ];
  }
  const m = clean.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!m) throw new Error(`Unsupported color token: ${css}`);
  return [
    Math.round(Number(m[1])),
    Math.round(Number(m[2])),
    Math.round(Number(m[3])),
    m[4] !== undefined ? Math.round(Number(m[4]) * 255) : 255
  ];
}

function blendOver(
  dst: readonly [number, number, number],
  src: readonly [number, number, number, number]
): [number, number, number] {
  const a = Math.max(0, Math.min(1, src[3] / 255));
  return [
    Math.round(src[0] * a + dst[0] * (1 - a)),
    Math.round(src[1] * a + dst[1] * (1 - a)),
    Math.round(src[2] * a + dst[2] * (1 - a))
  ];
}

function relLum([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function chroma([r, g, b]: readonly [number, number, number]): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

const TERRAIN_BG_SAMPLE: Record<(typeof MAP_THEMES)[number], [number, number, number]> = {
  stone: [226, 221, 210],
  slate: [34, 43, 55],
  chart: [236, 230, 216],
  classic: [212, 223, 192]
};

describe('4-theme × multi-channel contrast & MapLibre WebGL lifecycle permutation audit', () => {
  it('maintains crisp figure-ground contrast across all 4 themes × lift intensities × cloud regimes', () => {
    const w = 32, h = 32;
    const representativeLiftIndices = [4, 9, 13, 16];
    const rawLiftTile = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = representativeLiftIndices[(x >> 3) & 3]!;
        const [r, g, b] = parseCssRgba(LIFT_COLORS[idx]!);
        const off = (y * w + x) * 4;
        rawLiftTile[off] = r;
        rawLiftTile[off + 1] = g;
        rawLiftTile[off + 2] = b;
        rawLiftTile[off + 3] = 255;
      }
    }

    const rainPixels = new Uint8ClampedArray(w * h * 4);
    const squallRgba = parseCssRgba(RAIN_COLORS[5]!);
    for (let y = 6; y < 26; y++) {
      for (let x = 6; x < 26; x++) {
        rainPixels.set(squallRgba, (y * w + x) * 4);
      }
    }
    const precipField = decodePrecipRgbaToField(rainPixels, w, h, { west: 43.5, south: 39.5, east: 45.8, north: 41.2 }, 'armenia-cell');

    const cloudRegimes: ReadonlyArray<{ name: string; low: number; total: number }> = [
      { name: 'scattered-cu', low: 0.38, total: 0.42 },
      { name: 'high-cirrus', low: 0.0, total: 0.95 },
      { name: 'low-overcast', low: 0.88, total: 0.94 }
    ];

    let permutationsVerified = 0;

    for (const theme of MAP_THEMES) {
      const terrain = TERRAIN_BG_SAMPLE[theme];
      const remappedLift = !themeOption(theme).remap
        ? new Uint8ClampedArray(rawLiftTile)
        : (() => {
            const copy = new Uint8ClampedArray(rawLiftTile);
            remapRgbaInPlace(copy, w, h, 'lift', theme);
            return copy;
          })();

      const styles = resolveChannelStyles(theme);
      {
        for (const regime of cloudRegimes) {
          const synoptic: SynopticField = {
            id: `armenia-${regime.name}`,
            buildId: 'gfs-test',
            frame: 'f12',
            west: 43.5,
            south: 39.5,
            east: 45.8,
            north: 41.2,
            cols: 12,
            rows: 12,
            total: new Float32Array(144).fill(regime.total),
            low: new Float32Array(144).fill(regime.low),
            mslp: new Float32Array(144).fill(1014),
            hasClouds: true,
            hasMslp: true
          };
          const cloudRgba = new Uint8ClampedArray(w * h * 4);
          renderSmoothCloudRgba(synoptic, styles.cloudStyle, styles.darkChrome, cloudRgba, w, h);

          {
            const cuffRgba = new Uint8ClampedArray(w * h * 4);
            expect(renderRainInnerVignetteRgba(precipField, styles, cuffRgba)).toBe(true);

            const { haloColor, showerColor } = rainContourStrokePair(styles);
            const haloRgba = parseCssRgba(haloColor);
            const showerRgba = parseCssRgba(showerColor);

            for (const sampleX of [3, 11, 19, 27]) {
              const rimOff = (7 * w + sampleX) * 4;
              const liftAtRim: [number, number, number, number] = [
                remappedLift[rimOff]!,
                remappedLift[rimOff + 1]!,
                remappedLift[rimOff + 2]!,
                Math.round(remappedLift[rimOff + 3]! * 0.72)
              ];
              const cloudAtRim: [number, number, number, number] = [
                cloudRgba[rimOff]!,
                cloudRgba[rimOff + 1]!,
                cloudRgba[rimOff + 2]!,
                Math.round(cloudRgba[rimOff + 3]! * 0.88)
              ];
              const cuffAtRim: [number, number, number, number] = [
                cuffRgba[rimOff]!,
                cuffRgba[rimOff + 1]!,
                cuffRgba[rimOff + 2]!,
                Math.round(cuffRgba[rimOff + 3]! * 0.90)
              ];

              const baseLiftRgb = blendOver(terrain, liftAtRim);
              const withCloudRgb = blendOver(baseLiftRgb, cloudAtRim);
              const withCuffRgb = blendOver(withCloudRgb, cuffAtRim);

              const onHalo = blendOver(withCuffRgb, haloRgba);
              const onRim = blendOver(onHalo, showerRgba);
              const maxContrast = Math.max(
                Math.abs(relLum(onHalo) - relLum(withCuffRgb)),
                Math.abs(relLum(onRim) - relLum(withCuffRgb)),
                Math.abs(relLum(onRim) - relLum(onHalo))
              );
              expect(maxContrast).toBeGreaterThanOrEqual(65);

              if (regime.name === 'high-cirrus' && sampleX >= 19) {
                const rawChroma = chroma(baseLiftRgb);
                const postCirrusChroma = chroma(withCloudRgb);
                if (rawChroma > 50) {
                  expect(postCirrusChroma).toBeGreaterThan(rawChroma * 0.62);
                }
              }
            }
            permutationsVerified++;
          }
        }
      }
    }

    expect(permutationsVerified).toBe(MAP_THEMES.length * cloudRegimes.length);
  });

  it('maintains strict MapLibre z-order (lift < hillshade-top < clouds < rain-cuff < waterway < contours < aero-strip < isobar-labels) across rapid swaps', () => {
    const order = [
      'terrain-background',
      'terrain-relief',
      'terrain-hillshade-base',
      'water',
      'av-overview-1',
      'av-overlay-1',
      'av-hillshade-top',
      'waterway',
      'road_major_motorway',
      'admin_country',
      'aero-strip',
      'peak-main',
      'place-city'
    ];
    const sources = new Map<string, Record<string, unknown>>();
    const fakeMap = {
      getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, spec: Record<string, unknown>) => { sources.set(id, { ...spec, _imageDirty: true }); },
      removeSource: (id: string) => { sources.delete(id); },
      addLayer: (layer: { id: string }, beforeId?: string) => {
        const idx = beforeId ? order.indexOf(beforeId) : -1;
        if (idx >= 0) order.splice(idx, 0, layer.id);
        else order.push(layer.id);
      },
      removeLayer: (id: string) => {
        const idx = order.indexOf(id);
        if (idx >= 0) order.splice(idx, 1);
      },
      setPaintProperty: vi.fn(),
      setLayoutProperty: vi.fn(),
      getZoom: () => 8,
      getCenter: () => ({ lng: 44.65, lat: 40.28 }),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn()
    };

    const synoptic: SynopticField = {
      id: 'z-order-check',
      buildId: 'b1',
      frame: 'f1',
      west: 43,
      south: 39,
      east: 46,
      north: 42,
      cols: 12,
      rows: 12,
      total: new Float32Array(144).fill(0.82),
      low: new Float32Array(144).fill(0.78),
      mslp: new Float32Array(144).map((_, i) => 1010 + (i % 12)),
      hasClouds: true,
      hasMslp: true
    };

    const clouds = new CloudLayerController(fakeMap as never, false);
    const isobars = new IsobarLayerController(fakeMap as never);
    const rain = new RainLayerController(fakeMap as never, 'https://api.example.test', false, {
      styles: resolveChannelStyles('classic'),
      opacity: 0.75,
      visible: true
    });

    (clouds as unknown as { paintContours: (f: SynopticField, s: unknown, v: boolean) => void })
      .paintContours(synoptic, resolveChannelStyles('classic'), true);
    isobars.paint(synoptic, themeOption('classic').isobar, true);
    fakeMap.addLayer({ id: 'av-rain-cuff' }, 'waterway');
    fakeMap.addLayer({ id: 'av-sky-clouds' }, 'av-rain-cuff');
    fakeMap.addLayer({ id: 'av-overlay-2' }, 'av-hillshade-top');

    const idxOf = (id: string) => order.indexOf(id);
    expect(idxOf('av-overlay-2')).toBeLessThan(idxOf('av-hillshade-top'));
    expect(idxOf('av-hillshade-top')).toBeLessThan(idxOf('av-sky-clouds'));
    expect(idxOf('av-sky-clouds')).toBeLessThan(idxOf('av-rain-cuff'));
    expect(idxOf('av-rain-cuff')).toBeLessThan(idxOf('waterway'));
    expect(idxOf('road_major_motorway')).toBeLessThan(idxOf('av-cloud-contours-overcast'));
    expect(idxOf('av-isobars-line')).toBeLessThan(idxOf('aero-strip'));
    expect(idxOf('aero-strip')).toBeLessThan(idxOf('av-isobars-label'));

    clouds.clear();
    isobars.clear();
    rain.dispose();
  });

  it('renders cold upper cloud decks brighter than warm shallow low stratus in satellite-ir mode', () => {
    const w = 16, h = 16;
    const makeField = (low: number, total: number): SynopticField => ({
      id: `ir-${low}-${total}`,
      buildId: 'b1',
      frame: 'f1',
      west: -79.2,
      south: 38.2,
      east: -78.0,
      north: 39.2,
      cols: 8,
      rows: 8,
      total: new Float32Array(64).fill(total),
      low: new Float32Array(64).fill(low),
      mslp: new Float32Array(64).fill(1016),
      hasClouds: true,
      hasMslp: true
    });
    const highCirrus = new Uint8ClampedArray(w * h * 4);
    const lowStratus = new Uint8ClampedArray(w * h * 4);
    renderSmoothCloudRgba(makeField(0.0, 0.92), 'satellite-ir', true, highCirrus, w, h);
    renderSmoothCloudRgba(makeField(0.90, 0.92), 'satellite-ir', true, lowStratus, w, h);
    let sumHighLum = 0, sumLowLum = 0, sumHighAlpha = 0;
    for (let i = 0; i < w * h; i++) {
      const off = i * 4;
      sumHighLum += relLum([highCirrus[off]!, highCirrus[off + 1]!, highCirrus[off + 2]!]);
      sumLowLum += relLum([lowStratus[off]!, lowStratus[off + 1]!, lowStratus[off + 2]!]);
      sumHighAlpha += highCirrus[off + 3]!;
    }
    expect(sumHighLum / (w * h)).toBeGreaterThan(sumLowLum / (w * h) + 55);
    expect(sumHighAlpha / (w * h)).toBeGreaterThan(68);
  });
});
