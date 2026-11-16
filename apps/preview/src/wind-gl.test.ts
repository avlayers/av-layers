import { expect, it } from 'vitest';
import { WIND_PARTICLE_UPDATE, encodeWindByte, mixWindVectors, sampleEncodedWindGrid } from './wind-gl';

const decode = (byte: number) => byte / 255 * 200 - 100;

function paint(size: number, cells: ReadonlyArray<readonly [number, number, number, number]>): Uint8Array {
  const data = new Uint8Array(size * size * 4), view = new DataView(data.buffer);
  for (const [x, y, u, v] of cells) {
    const offset = (y * size + x) * 4;
    view.setUint8(offset, encodeWindByte(u));
    view.setUint8(offset + 1, encodeWindByte(v));
    view.setUint8(offset + 3, 255);
  }
  return data;
}

const uv = (texel: number, size: number) => (texel + 0.5) / size;

it('keeps a no-lift hole from decoding as a large opposite wind', () => {
  const size = 2, data = paint(size, [[0, 0, 10, -4]]);
  const encoded = encodeWindByte(10);
  const poisoned = (0.75 * (encoded / 255) + 0.25 * 0) * 200 - 100;
  expect(poisoned).toBeLessThan(-10);
  const beside = sampleEncodedWindGrid(data, uv(0.25, size), uv(0, size), size);
  expect(beside?.u).toBeCloseTo(decode(encoded), 5);
  expect(beside?.v).toBeCloseTo(decode(encodeWindByte(-4)), 5);
  const center = sampleEncodedWindGrid(data, uv(0, size), uv(0, size), size);
  expect(center?.u).toBeCloseTo(decode(encoded), 5);
  const edge = sampleEncodedWindGrid(data, 0, uv(0, size), size);
  expect(edge?.u).toBeCloseTo(decode(encoded), 5);
});

it('interpolates two valid wind texels and rejects an empty neighborhood', () => {
  const size = 2, data = paint(size, [[0, 0, 10, 0], [1, 0, 30, 0]]);
  const blended = sampleEncodedWindGrid(data, uv(0.25, size), uv(0, size), size);
  const expected = 0.75 * decode(encodeWindByte(10)) + 0.25 * decode(encodeWindByte(30));
  expect(blended?.u).toBeCloseTo(expected, 5);
  expect(blended?.v).toBeCloseTo(decode(encodeWindByte(0)), 5);
  expect(sampleEncodedWindGrid(new Uint8Array(size * size * 4), uv(0, size), uv(0, size), size)).toBeNull();
});

it('uses the one reconstructed field during a frame blend', () => {
  const from = { u: 10, v: 0 }, to = { u: 2, v: 6 };
  expect(mixWindVectors(from, to, 0.25)).toEqual({ u: 8, v: 1.5 });
  expect(mixWindVectors(from, to, 1)).toEqual(to);
  expect(mixWindVectors(from, null, 0.25)).toEqual(from);
  expect(mixWindVectors(from, null, 1)).toBeNull();
  expect(mixWindVectors(null, to, 0.25)).toEqual(to);
  expect(mixWindVectors(null, null, 1)).toBeNull();
});

it('samples wind texels with floor and rejects zero alpha before decoding', () => {
  const alpha = WIND_PARTICLE_UPDATE.indexOf('s.a>0.5'), scale = WIND_PARTICLE_UPDATE.indexOf('*200.0');
  expect(alpha).toBeGreaterThan(-1);
  expect(scale).toBeGreaterThan(alpha);
  expect(WIND_PARTICLE_UPDATE).toContain('texelFetch');
  expect(WIND_PARTICLE_UPDATE).toContain('floor');
  expect(WIND_PARTICLE_UPDATE).toContain('uv*float(128)-0.5');
  expect(WIND_PARTICLE_UPDATE).toContain('ivec2(127)');
  expect(WIND_PARTICLE_UPDATE).toContain('u_mix>=1.0?b.xy');
  expect(WIND_PARTICLE_UPDATE).toContain('mix(a.xy,b.xy,u_mix)');
  expect(WIND_PARTICLE_UPDATE).toContain('vb?b.xy:a.xy');
  expect(WIND_PARTICLE_UPDATE).not.toMatch(/texture\(u_[ab]/);
});
