import { describe, expect, it } from 'vitest';
import { contourLines, type GeoPt } from './contours';

// Row 0 is north: grid y grows southward, latitude northward.
const toGeo = (gx: number, gy: number): GeoPt => [gx, -gy];
const signedArea = (ring: GeoPt[]) => ring.reduce((sum, [x0, y0], i) => {
  const [x1, y1] = ring[(i + 1) % ring.length]!;
  return sum + x0 * y1 - x1 * y0;
}, 0) / 2;
const isClosed = (line: GeoPt[]) => line[0]![0] === line.at(-1)![0] && line[0]![1] === line.at(-1)![1];

// Two high cells touching only at a corner: the shared cell is a saddle.
const diagonal = [
  0, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 0
];
const antiDiagonal = [
  0, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 0
];

describe('contourLines', () => {
  it.each([['mask 10', diagonal], ['mask 5', antiDiagonal]])('joins the high corners of a %s saddle when the centre is high', (_, grid) => {
    const lines = contourLines(grid, 4, 4, 0.4, toGeo);
    expect(lines).toHaveLength(1);
    expect(isClosed(lines[0]!)).toBe(true);
  });

  it.each([['mask 10', diagonal], ['mask 5', antiDiagonal]])('separates the high corners of a %s saddle when the centre is low', (_, grid) => {
    const lines = contourLines(grid, 4, 4, 0.6, toGeo);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(isClosed(line)).toBe(true);
  });

  it('keeps the high side on the left, so rings around high cells wind counter-clockwise', () => {
    for (const level of [0.4, 0.6]) {
      for (const ring of [...contourLines(diagonal, 4, 4, level, toGeo), ...contourLines(antiDiagonal, 4, 4, level, toGeo)]) {
        expect(signedArea(ring)).toBeGreaterThan(0);
      }
    }
  });

  it('skips cells with an invalid corner', () => {
    const valid = diagonal.map((_, i) => (i === 5 ? 0 : 1));
    const lines = contourLines(diagonal, 4, 4, 0.6, toGeo, { valid });
    expect(lines).toHaveLength(1);
  });
});
