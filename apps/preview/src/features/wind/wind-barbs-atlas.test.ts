import { afterEach, expect, it, vi } from 'vitest';
import { DISPLAY_KNOTS_PER_MPS } from '@av/contracts/units';
import { WindBarbAtlas } from './wind-barbs-atlas';

const context = {
  lineCap: '', lineJoin: '', lineWidth: 1, strokeStyle: '', fillStyle: '',
  save() {}, restore() {}, translate() {}, beginPath() {}, arc() {}, stroke() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {}
};
const canvas = () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,' });

afterEach(() => { vi.unstubAllGlobals(); });

it('builds calm, hemisphere, and full-range WMO barb icons without clamping', () => {
  vi.stubGlobal('document', { createElement: canvas });
  vi.stubGlobal('Path2D', class {});
  const atlas = new WindBarbAtlas();
  expect(Object.keys(atlas.mapping)).toHaveLength(113);
  expect(atlas.key(0, false)).toBe('calm');
  expect(atlas.key(2.4, false)).toBe('calm');
  expect(atlas.key(2.5, false)).toBe('n5');
  expect(atlas.key(3, false)).toBe('n5');
  expect(atlas.key(8, false)).toBe('n10');
  expect(atlas.key(80 * DISPLAY_KNOTS_PER_MPS, false)).toBe('n155');
  expect(atlas.key(10, true)).toBe('s10');
  const dynamic = atlas.key(300, false);
  expect(dynamic).toBe('dn300');
  expect(atlas.dynamicMapping[dynamic]).toBeDefined();
});
