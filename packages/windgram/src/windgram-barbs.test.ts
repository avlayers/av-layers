import { expect, it } from 'vitest';
import { barbGeometry, displayedBarbSpeed, quantizedBarbSpeed } from './wind-barb.ts';
import { windBarbGlyph } from './windgram-glyphs.ts';
import { resolveWindgramPresentation } from './windgram-presentation.ts';
import { mpsToKnots } from './windgram-format.ts';

it('mirrors the pennant and feathers south of the equator without reversing the staff', () => {
  for (const [direction, x, y] of [[0, 0, -22], [90, 22, 0], [180, 0, 22], [270, -22, 0]]) {
    const north = barbGeometry(65, direction, 22, false), south = barbGeometry(65, direction, 22, true);
    expect(north.staff).toBe(south.staff);
    expect(north.points[1]?.map(value => value || 0)).toEqual([x, y]);
    for (const vertex of [3, 6, 8]) {
      const side = ([px, py]: readonly [number, number]) => Math.sign(x * py - y * px);
      expect(side(north.points[vertex]!)).toBe(1);
      expect(side(south.points[vertex]!)).toBe(-1);
    }
  }
});

it.each(['metric', 'imperial'] as const)('draws WMO/ICAO knot barbs invariantly in %s while formatting display speeds', system => {
  const presentation = resolveWindgramPresentation({ compact: true });
  for (const calmKt of [0, 0.1, 0.4, 1, 2.49]) {
    const glyph = windBarbGlyph({ x: 0, y: 0, speedKt: calmKt, directionDeg: 0, southernHemisphere: false }, presentation, system);
    expect(glyph.calm).toBe(true);
    expect(glyph.flags).toHaveLength(0);
  }
  const twentyKt = windBarbGlyph({ x: 0, y: 0, speedKt: 20, directionDeg: 0, southernHemisphere: false }, presentation, system);
  expect(twentyKt.calm).toBe(false);
  expect(twentyKt.flags).toHaveLength(2);
  expect(displayedBarbSpeed(20 / mpsToKnots(1), system)).toBe(system === 'metric' ? 37 : 23);
});

it('uses a 2.5 kt calm threshold and quantizes 2.5..7.49 kt to a half feather', () => {
  for (const calm of [0, 0.4, 1, 2.49]) {
    expect(quantizedBarbSpeed(calm)).toBe(0);
    expect(barbGeometry(calm, 0, 21, false).calm).toBe(true);
  }
  for (const speed of [2.5, 3, 4, 5, 6, 7, 7.49]) {
    expect(quantizedBarbSpeed(speed)).toBe(5);
    const geometry = barbGeometry(speed, 0, 21, false);
    expect(geometry.calm).toBe(false);
    expect(geometry.flags).toHaveLength(1);
    expect(geometry.points.some(([x]) => x === 5)).toBe(true);
  }
  for (const speed of [7.5, 8, 9, 10, 11, 12]) expect(quantizedBarbSpeed(speed)).toBe(10);
});

it('bounds geometry work for extreme finite source winds', () => {
  const geometry = barbGeometry(Math.fround(1e30), 45, 21, false);
  expect(geometry.flags.length).toBeGreaterThanOrEqual(16);
  expect(geometry.flags.length).toBeLessThanOrEqual(21);
  expect(geometry.points.every(point => point.every(Number.isFinite))).toBe(true);
});

it.each(['metric', 'imperial'] as const)('compresses extreme knot pennants identically in %s inside a mobile staff', system => {
  const presentation = resolveWindgramPresentation({ compact: true });
  for (const speedKt of [195, 200, 205, 245, 250, 255, 400]) {
    const glyph = windBarbGlyph({ x: 0, y: 0, speedKt, directionDeg: 0, southernHemisphere: false }, presentation, system);
    const quantized = Math.round(speedKt / 5) * 5;
    const pennants = Math.min(16, Math.floor(quantized / 50));
    expect(glyph.flags).toHaveLength(pennants + Math.floor(quantized % 50 / 10) + Number(quantized % 10 >= 5));
    for (const [, y] of glyph.points) expect(y).toBeGreaterThanOrEqual(-22);
    for (const [, y] of glyph.points) expect(y).toBeLessThanOrEqual(0);
  }
});
