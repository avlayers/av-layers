import { describe, expect, it } from 'vitest';
import { RAIN_COLORS, RAIN_EDGES } from '@av/contracts/layers';
import { mercY } from './mercator';
import { decodePrecipRgbaToField, samplePrecipMmh } from './precip-field';

const BOUNDS = { west: 10, south: 40, east: 12, north: 42 };

function filled(width: number, height: number, hex: string, alpha = 255): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  const rgb = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16));
  for (let i = 0; i < width * height; i++) px.set([rgb[0]!, rgb[1]!, rgb[2]!, alpha], i * 4);
  return px;
}

// Colour 3 spans RAIN_EDGES[3]..RAIN_EDGES[4]; the decoder reads its band midpoint.
const BAND3_MMH = (RAIN_EDGES[3] + RAIN_EDGES[4]) / 2;

describe('decodePrecipRgbaToField', () => {
  it('decodes a uniform palette colour to its band midpoint with a normalised wet CDF', () => {
    const field = decodePrecipRgbaToField(filled(16, 16, RAIN_COLORS[3]), 16, 16, BOUNDS, 'k');
    expect(field.key).toBe('k');
    expect([field.cols, field.rows]).toEqual([16, 16]);
    expect(field.maxMmh).toBeCloseTo(BAND3_MMH, 5);
    expect(field.wetFraction).toBe(1);
    expect(field.wetIndices.length).toBe(256);
    expect(field.wetCdf[255]).toBe(1);
    for (let i = 1; i < 256; i++) expect(field.wetCdf[i]!).toBeGreaterThanOrEqual(field.wetCdf[i - 1]!);
    expect(field.yNorth).toBeCloseTo(mercY(42), 12);
    expect(field.ySouth).toBeCloseTo(mercY(40), 12);
  });

  it('reads transparent and off-palette pixels as dry', () => {
    for (const pixels of [filled(8, 8, RAIN_COLORS[5], 10), filled(8, 8, '#000000')]) {
      const field = decodePrecipRgbaToField(pixels, 8, 8, BOUNDS);
      expect(field.maxMmh).toBe(0);
      expect(field.wetIndices.length).toBe(0);
      expect(field.wetFraction).toBe(0);
    }
  });

  it('scales decoded rate by pixel alpha', () => {
    const field = decodePrecipRgbaToField(filled(8, 8, RAIN_COLORS[3], 102), 8, 8, BOUNDS);
    expect(field.maxMmh).toBeCloseTo(BAND3_MMH * (102 / 255), 5);
  });

  it('caps the grid at 224 cells per axis and keeps at least 2', () => {
    const wide = decodePrecipRgbaToField(filled(300, 1, RAIN_COLORS[0]), 300, 1, BOUNDS);
    expect([wide.cols, wide.rows]).toEqual([224, 2]);
  });

  it('smooths a single wet pixel into its neighbours', () => {
    const pixels = new Uint8ClampedArray(9 * 9 * 4);
    pixels.set(filled(1, 1, RAIN_COLORS[6]), (4 * 9 + 4) * 4);
    const field = decodePrecipRgbaToField(pixels, 9, 9, BOUNDS);
    const centre = field.mmh[4 * 9 + 4]!;
    expect(centre).toBeGreaterThan(field.mmh[4 * 9 + 5]!);
    expect(field.mmh[4 * 9 + 5]!).toBeGreaterThan(0);
    expect(field.mmh[0]).toBe(0);
  });
});

describe('samplePrecipMmh', () => {
  const field = decodePrecipRgbaToField(filled(16, 16, RAIN_COLORS[3]), 16, 16, BOUNDS);

  it('returns the field rate inside the bounds, wrapping longitude', () => {
    expect(samplePrecipMmh(field, 11, 41)).toBeCloseTo(BAND3_MMH, 5);
    expect(samplePrecipMmh(field, 11 + 360, 41)).toBeCloseTo(BAND3_MMH, 5);
  });

  it('returns 0 outside the bounds', () => {
    expect(samplePrecipMmh(field, 11, 43)).toBe(0);
    expect(samplePrecipMmh(field, 13, 41)).toBe(0);
  });
});
