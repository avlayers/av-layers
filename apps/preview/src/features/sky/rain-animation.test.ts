import { describe, expect, it, vi } from 'vitest';
import { RAIN_COLORS } from '@av/contracts/layers';
import { rainContourStrokePair, resolveChannelStyles } from '../map/channel-styles';
import { MAP_THEMES, THEME_OPTIONS } from '../map/visual-theme';
import { buildCloudContourGeoJson, renderSmoothCloudRgba } from './cloud-layer';
import {
  buildRainContourGeoJson,
  buildViewportSpawnDistribution,
  decodePrecipRgbaToField,
  RainAnimator,
  rainVisualProfileForMmh,
  renderRainInnerVignetteRgba,
  samplePrecipMmh
} from './rain-animation';
import {
  cloudRasterBeforeId,
  OwnedImageBitmapRetirer,
  rainCuffBeforeId,
  weatherContourBeforeId
} from './sky-layer-order';
import { scaleAdaptiveSampleBox, synopticFieldCoversView, type SynopticField } from './synoptic-sampler';

function hexPixel(hex: string, alpha = 255): [number, number, number, number] {
  const clean = hex.slice(1);
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
    alpha
  ];
}

describe('decoupled rain-edge (#1 inner vignette cuff + dry halo), smooth cloud cover & adversarial lifecycle guards', () => {
  it('returns zero active wet cells, no cuff, and an empty contour set when the viewport is dry', () => {
    const dryPixels = new Uint8ClampedArray(16 * 16 * 4);
    const field = decodePrecipRgbaToField(dryPixels, 16, 16, { west: -60, south: -25, east: -45, north: -10 }, 'dry');
    const cuff = new Uint8ClampedArray(16 * 16 * 4);
    const styles = resolveChannelStyles('xcskies');

    expect(field.maxMmh).toBe(0);
    expect(field.wetIndices.length).toBe(0);
    expect(samplePrecipMmh(field, -52, -16)).toBe(0);
    expect(renderRainInnerVignetteRgba(field, styles, cuff)).toBe(false);
    expect(buildRainContourGeoJson(field, 'vignette-cuff', 15).features).toHaveLength(0);
  });

  it('short-circuits cuff upload when 100% of crop cells are uniformly inside a rain shield (no dry edge)', () => {
    const size = 24;
    const pixels = new Uint8ClampedArray(size * size * 4);
    const squall = hexPixel(RAIN_COLORS[5]!);
    for (let i = 0; i < size * size; i++) pixels.set(squall, i * 4);

    const field = decodePrecipRgbaToField(pixels, size, size, { west: 43, south: 39, east: 46, north: 42 }, 'all-wet');
    const cuff = new Uint8ClampedArray(size * size * 4);
    expect(renderRainInnerVignetteRgba(field, resolveChannelStyles('xcskies'), cuff)).toBe(false);
  });

  it('never closes an ImageBitmap while MapLibre ImageSource still has _imageDirty = true (preventing black-screen crash)', () => {
    const retirer = new OwnedImageBitmapRetirer();
    const closeA = vi.fn();
    const closeB = vi.fn();
    const bmpA = { close: closeA } as unknown as ImageBitmap;
    const bmpB = { close: closeB } as unknown as ImageBitmap;

    const imageSource = { image: bmpA as unknown, _imageDirty: true };
    const renderCbs: Array<() => void> = [];
    const fakeMap = {
      getSource: () => imageSource,
      once: (_event: string, cb: () => void) => { renderCbs.push(cb); }
    };

    // Presenting bmpA must NOT close bmpA while MapLibre awaits gl.texImage2D!
    retirer.present(fakeMap as never, 'av-rain-cuff', bmpA);
    expect(closeA).not.toHaveBeenCalled();

    // Replacing with bmpB before render finishes: if source still points to bmpB with _imageDirty=true, bmpA is safe to close once source.image !== bmpA!
    imageSource.image = bmpB;
    imageSource._imageDirty = true;
    retirer.present(fakeMap as never, 'av-rain-cuff', bmpB);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();

    // Even after render fires, currently displayed bmpB stays alive until source removal!
    imageSource._imageDirty = false;
    for (const cb of renderCbs) cb();
    expect(closeB).not.toHaveBeenCalled();

    retirer.releaseAllAfterSourceRemoved();
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it('anchors clouds & rain cuffs strictly above av-hillshade-top (never buried by lift) and below vector roads & labels', () => {
    const layers = new Set(['av-hillshade-top', 'coastline', 'road_major', 'aero-strip', 'place-city']);
    const fakeMap = { getLayer: (id: string) => (layers.has(id) ? { id } : undefined) };

    expect(cloudRasterBeforeId(fakeMap as never)).toBe('coastline');
    expect(rainCuffBeforeId(fakeMap as never)).toBe('coastline');
    expect(weatherContourBeforeId(fakeMap as never)).toBe('aero-strip');

    // Once av-rain-cuff is mounted, clouds insert directly below av-rain-cuff (still above av-hillshade-top!)
    layers.add('av-rain-cuff');
    expect(cloudRasterBeforeId(fakeMap as never)).toBe('av-rain-cuff');
  });

  it('preserves dual-polarity outer casing + inner rim contrast across all 8 views and all 4 rain styles', () => {
    for (const theme of MAP_THEMES) {
      for (const rainStyle of ['vignette-cuff', 'sigwx-scallop', 'inward-comb', 'wet-lens'] as const) {
        const styles = resolveChannelStyles(theme, { rainStyle });
        const pair = rainContourStrokePair(styles);
        // Outer halo casing and inner shower stroke must never collapse to identical colors!
        expect(pair.haloColor).not.toBe(pair.showerColor);
      }
    }
  });

  it('scales droplet tier, streak size, fall speed, and opacity monotonically with rainfall mm/h', () => {
    const drizzle = rainVisualProfileForMmh(0.4);
    const shower = rainVisualProfileForMmh(2.5);
    const downpour = rainVisualProfileForMmh(7.0);
    const squall = rainVisualProfileForMmh(18.0);

    expect([drizzle.tier, shower.tier, downpour.tier, squall.tier]).toEqual([0, 1, 2, 3]);
    expect(drizzle.speedPxPerSec).toBeLessThan(shower.speedPxPerSec);
    expect(shower.speedPxPerSec).toBeLessThan(downpour.speedPxPerSec);
    expect(downpour.speedPxPerSec).toBeLessThan(squall.speedPxPerSec);
    expect(drizzle.scale).toBeLessThan(shower.scale);
    expect(shower.scale).toBeLessThan(downpour.scale);
    expect(downpour.scale).toBeLessThan(squall.scale);
    expect(drizzle.alpha).toBeLessThan(squall.alpha);
  });

  it('renders #1 Asymmetric Inner Vignette Cuff strictly inside wet cells while fading to 0% in the storm interior', () => {
    const size = 48;
    const pixels = new Uint8ClampedArray(size * size * 4);
    const squall = hexPixel(RAIN_COLORS[5]!); // ~15 mm/h
    for (let y = 8; y < 40; y++) {
      for (let x = 8; x < 40; x++) {
        pixels.set(squall, (y * size + x) * 4);
      }
    }

    const bounds = { west: -60, south: -26, east: -44, north: -10 };
    const field = decodePrecipRgbaToField(pixels, size, size, bounds, 'storm');
    const cuff = new Uint8ClampedArray(size * size * 4);
    const styles = resolveChannelStyles('xcskies');

    expect(renderRainInnerVignetteRgba(field, styles, cuff)).toBe(true);
    expect(cuff[(2 * size + 2) * 4 + 3]).toBe(0);
    const rimAlpha = cuff[(9 * size + 24) * 4 + 3]!;
    expect(rimAlpha).toBeGreaterThan(45);
    expect(cuff[(24 * size + 24) * 4 + 3]).toBe(0);

    expect(buildRainContourGeoJson(field, 'vignette-cuff', 16).features.length).toBeGreaterThan(0);
    expect(buildRainContourGeoJson(field, 'sigwx-scallop', 16).features.length).toBeGreaterThan(0);
    const tickFeatures = buildRainContourGeoJson(field, 'inward-comb', 16).features;
    expect(tickFeatures.some(f => f.properties.tier === 'tick')).toBe(true);
  });

  it('concentrates viewport spawn weight onto heavy convective cores and extracts shower/squall contours', () => {
    const size = 32;
    const pixels = new Uint8ClampedArray(size * size * 4);
    const light = hexPixel(RAIN_COLORS[0]!);
    const squall = hexPixel(RAIN_COLORS[5]!);

    for (let y = 6; y < 26; y++) {
      for (let x = 6; x < 26; x++) {
        const px = x >= 13 && x < 19 && y >= 13 && y < 19 ? squall : light;
        pixels.set(px, (y * size + x) * 4);
      }
    }

    const bounds = { west: -60, south: -26, east: -44, north: -10 };
    const field = decodePrecipRgbaToField(pixels, size, size, bounds, 'storm');
    const dist = buildViewportSpawnDistribution(field, bounds);
    expect(dist.peakVisibleMmh).toBeGreaterThan(10);
    expect(dist.visibleWetFraction).toBeGreaterThan(0.2);
    expect(dist.cdf[dist.cdf.length - 1]).toBeCloseTo(1, 5);

    const contours = buildRainContourGeoJson(field, 'vignette-cuff', 16);
    const tiers = new Set(contours.features.map(f => f.properties.tier));
    expect(tiers.has('shower')).toBe(true);
    expect(tiers.has('squall')).toBe(true);
  });

  it('renders low overcast as neutral shadow while keeping 100% high thin cirrus airy and bright over XC Skies lift', () => {
    const cols = 16, rows = 16;
    const total = new Float32Array(cols * rows);
    const low = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const dx = (x - 7.5) / 5, dy = (y - 7.5) / 5;
        const cover = Math.max(0, 0.94 - (dx * dx + dy * dy) * 0.45);
        total[y * cols + x] = cover;
        low[y * cols + x] = cover * 0.88;
      }
    }
    const lowOvcField: SynopticField = {
      id: 'yerevan-low-ovc',
      buildId: 'b1',
      frame: 'f0',
      west: 44.3,
      south: 40.0,
      east: 44.8,
      north: 40.5,
      cols,
      rows,
      total,
      low,
      mslp: new Float32Array(cols * rows),
      hasClouds: true,
      hasMslp: false
    };

    const w = 64, h = 48;
    const rgba = new Uint8ClampedArray(w * h * 4);
    renderSmoothCloudRgba(lowOvcField, 'sunlit-veil', false, rgba, w, h);

    const cx = 32, cy = 24;
    const centerOff = (cy * w + cx) * 4;
    expect(rgba[centerOff + 3]!).toBeGreaterThan(60);
    expect(Math.abs(rgba[centerOff + 3]! - rgba[centerOff + 7]!)).toBeLessThan(25);

    // High-only cirrus (total = 95%, low = 0%): bright white-silver veil capped <= 54 alpha (never dark grey!)
    const cirrusField: SynopticField = {
      ...lowOvcField,
      id: 'yerevan-high-cirrus',
      total: new Float32Array(cols * rows).fill(0.95),
      low: new Float32Array(cols * rows).fill(0)
    };
    const cirrusRgba = new Uint8ClampedArray(w * h * 4);
    renderSmoothCloudRgba(cirrusField, 'sunlit-veil', false, cirrusRgba, w, h);
    expect(cirrusRgba[centerOff]!).toBeGreaterThan(215);
    expect(cirrusRgba[centerOff + 3]!).toBeLessThanOrEqual(54);

    const neph = buildCloudContourGeoJson(lowOvcField, 'nephanalysis');
    expect(neph.features.some(f => f.properties.tier === 'broken')).toBe(true);
    expect(neph.features.some(f => f.properties.tier === 'overcast')).toBe(true);
  });

  it('uses scale-adaptive viewport quantization so zoomed-in local views (e.g. Yerevan 2 mi) resample crisp local grids', () => {
    const regional = { west: 38, south: 35, east: 50, north: 45 };
    const yerevanLocal = { west: 44.42, south: 40.12, east: 44.72, north: 40.48 };
    const localBox = scaleAdaptiveSampleBox(yerevanLocal);

    expect(localBox.east - localBox.west).toBeLessThan(1.0);
    expect(synopticFieldCoversView(regional, yerevanLocal)).toBe(false);
  });

  it('keeps RainAnimator completely idle when dry or hidden', () => {
    const rafSpy = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', rafSpy);
    try {
      const fakeMap = {
        on: vi.fn(),
        off: vi.fn(),
        getCenter: () => ({ lng: -52, lat: -16 })
      };
      const animator = new RainAnimator(fakeMap as never, { darkChrome: false, opacity: 0.6, visible: true });
      const dry = decodePrecipRgbaToField(new Uint8ClampedArray(8 * 8 * 4), 8, 8, { west: -60, south: -20, east: -50, north: -10 });
      animator.setField(dry);
      expect(rafSpy).not.toHaveBeenCalled();
      animator.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('deconflicts isobar low centers from crimson thermal lift and separates Chart Topo isobars from purple borders', () => {
    const chart = THEME_OPTIONS.find(t => t.id === 'chart')!;
    expect(chart.isobar.majorColor).toContain('11, 56, 68');
    for (const opt of THEME_OPTIONS) {
      if (!opt.darkChrome) {
        expect(opt.isobar.lowColor).not.toMatch(/#9f1239|#b91c1c|#991b1b/i);
      }
    }
  });
});
