import { expect, it } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { sameOverlayState, type OverlayState } from './overlay-state';

const build = fixtureBuild();
const state = (overrides: Partial<OverlayState> = {}): OverlayState => ({
  displayed: { build, layer: 'usable-lift-msl', frame: 'f003' }, requested: { build, layer: 'usable-lift-msl', frame: 'f003' },
  quality: 'detail', viewLoading: false, overviewReady: 0, overviewTotal: 0, overviewFailed: 0, incomplete: false, replacementFailed: false,
  previewReadyFrames: ['f003'], detailBytesReadyFrames: [], ...overrides
});

it('treats equal selections and frame lists as unchanged', () => {
  expect(sameOverlayState(null, state())).toBe(false);
  expect(sameOverlayState(state(), state())).toBe(true);
  expect(sameOverlayState(state({ displayed: null, requested: null }), state({ displayed: null, requested: null }))).toBe(true);
});

it('reports any changed field', () => {
  expect(sameOverlayState(state(), state({ requested: { build, layer: 'usable-lift-msl', frame: 'f006' } }))).toBe(false);
  expect(sameOverlayState(state(), state({ previewReadyFrames: ['f003', 'f006'] }))).toBe(false);
  expect(sameOverlayState(state(), state({ detailBytesReadyFrames: undefined }))).toBe(false);
  expect(sameOverlayState(state(), state({ pendingTiles: 1 }))).toBe(false);
  expect(sameOverlayState(state(), state({ detailState: 'complete' }))).toBe(false);
});
