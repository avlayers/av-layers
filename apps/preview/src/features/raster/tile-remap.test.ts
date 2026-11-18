import { describe, expect, it } from 'vitest';
import { LIFT_COLORS, RAIN_COLORS } from '@av/contracts/layers';
import { remapRgbaInPlace } from './tile-remap';

function hexPixel(hex: string, alpha = 255): [number, number, number, number] {
  const clean = hex.slice(1);
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
    alpha
  ];
}

describe('remapRgbaInPlace', () => {
  it('leaves Classic XC Skies pixels completely unremapped so original duckies colors render verbatim', () => {
    const src = new Uint8ClampedArray([
      ...hexPixel(LIFT_COLORS[0]!),
      ...hexPixel(LIFT_COLORS[7]!),
      ...hexPixel(LIFT_COLORS[16]!)
    ]);
    const copy = new Uint8ClampedArray(src);
    remapRgbaInPlace(copy, 3, 1, 'lift', 'xcskies');
    expect([...copy]).toEqual([...src]);
  });

  it('remaps server lift bins into warm Stone and burnished Slate colors while keeping clear pixels transparent', () => {
    const src = new Uint8ClampedArray([
      0, 0, 0, 0,
      ...hexPixel(LIFT_COLORS[1]!),
      ...hexPixel(LIFT_COLORS[12]!),
      ...hexPixel(LIFT_COLORS[18]!)
    ]);
    const stone = new Uint8ClampedArray(src);
    remapRgbaInPlace(stone, 4, 1, 'lift', 'stone');
    expect(stone[3]).toBe(0);
    expect(stone[8]).toBeGreaterThan(stone[10]!);
    expect(stone[12]).toBeGreaterThan(stone[14]!);

    const slate = new Uint8ClampedArray(src);
    remapRgbaInPlace(slate, 4, 1, 'lift', 'slate');
    expect(slate[3]).toBe(0);
    expect(slate[12]).toBeGreaterThan(slate[4]!);
    expect(slate[13]).toBeGreaterThan(slate[5]!);
  });

  it('draws stepped contour lines in Chart Topo and airy isoline washes in Alabaster', () => {
    // 4x1 gradient jumping from ~450m (bin 1) to ~1950m (bin 6)
    const gradient = new Uint8ClampedArray([
      ...hexPixel(LIFT_COLORS[1]!),
      ...hexPixel(LIFT_COLORS[1]!),
      ...hexPixel(LIFT_COLORS[6]!),
      ...hexPixel(LIFT_COLORS[6]!)
    ]);
    const chart = new Uint8ClampedArray(gradient);
    remapRgbaInPlace(chart, 4, 1, 'lift', 'chart');
    // Boundary pixel crossing 500m contour step has boosted contour opacity
    expect(chart[7]).toBeGreaterThanOrEqual(195);

    const alabaster = new Uint8ClampedArray([
      ...hexPixel(LIFT_COLORS[10]!),
      ...hexPixel(LIFT_COLORS[10]!),
      ...hexPixel(LIFT_COLORS[10]!)
    ]);
    remapRgbaInPlace(alabaster, 3, 1, 'lift', 'alabaster');
    // Interior fill stays semi-transparent (<= 165) so terrain breathes underneath
    expect(alabaster[7]).toBeLessThanOrEqual(168);
  });

  it('masks usable-lift-msl ground elevation pixels where usable-lift-agl is transparent', () => {
    const mslPixels = new Uint8ClampedArray([
      ...hexPixel(LIFT_COLORS[4]!),
      ...hexPixel(LIFT_COLORS[10]!)
    ]);
    const aglMask = new Uint8ClampedArray([
      0, 0, 0, 0,
      ...hexPixel(LIFT_COLORS[6]!, 255)
    ]);
    remapRgbaInPlace(mslPixels, 2, 1, 'lift', 'stone', aglMask);
    expect(mslPixels[7]).toBeGreaterThan(100);
    expect(mslPixels[3]).toBeLessThan(mslPixels[7]!);
  });

  it('maps precipitation into cool cyan-indigo hues and diagonal hatches in Chart mode', () => {
    const rain = new Uint8ClampedArray([
      ...hexPixel(RAIN_COLORS[0]!),
      ...hexPixel(RAIN_COLORS[4]!),
      ...hexPixel(RAIN_COLORS[6]!)
    ]);
    remapRgbaInPlace(rain, 3, 1, 'rain', 'stone');
    expect(rain[2]).toBeGreaterThan(rain[0]!);
    expect(rain[6]).toBeGreaterThan(rain[4]!);
    expect(rain[10]).toBeGreaterThan(rain[8]!);

    // 8x1 uniform moderate rain strip in 'chart' hatch mode alternates opaque stripes with translucent gaps
    const strip = new Uint8ClampedArray(8 * 4);
    const px = hexPixel(RAIN_COLORS[3]!);
    for (let i = 0; i < 8; i++) strip.set(px, i * 4);
    remapRgbaInPlace(strip, 8, 1, 'rain', 'chart');
    expect(strip[3]).toBeGreaterThan(strip[6 * 4 + 3]! * 2);
  });
});
