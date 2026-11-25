import { expect, it } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { predictSelections, timelineFrames } from './raster-prefetch';
import type { RasterSelection } from './raster-slots';

const build = fixtureBuild();
const at = (layer: RasterSelection['layer'], frame: string): RasterSelection => ({ build, layer, frame });
const ids = (selections: RasterSelection[]) => selections.map(s => `${s.layer}@${s.frame}`);

it('predicts the paired lift layer, then nearby frames, then siblings before any scrub', () => {
  expect(ids(predictSelections(at('usable-lift-msl', 'f009'), null, undefined))).toEqual([
    'usable-lift-agl@f009', 'usable-lift-msl@f012', 'usable-lift-msl@f006', 'usable-lift-msl@f015', 'precip-rate@f009'
  ]);
});

it('follows the scrub direction and turns back at the last frame', () => {
  expect(ids(predictSelections(at('usable-lift-msl', 'f009'), null, -1))).toEqual([
    'usable-lift-msl@f006', 'usable-lift-msl@f003', 'usable-lift-msl@f012', 'usable-lift-agl@f009', 'precip-rate@f009'
  ]);
  expect(ids(predictSelections(at('usable-lift-msl', 'f024'), null, 1))).toEqual([
    'usable-lift-msl@f021', 'usable-lift-msl@f018', 'usable-lift-agl@f024', 'precip-rate@f024'
  ]);
});

it('puts a preferred selection from the same build first', () => {
  expect(ids(predictSelections(at('usable-lift-msl', 'f009'), at('precip-rate', 'f003'), 1))[0]).toBe('precip-rate@f003');
  expect(ids(predictSelections(at('usable-lift-msl', 'f009'), { ...at('precip-rate', 'f003'), build: fixtureBuild() }, 1))[0]).toBe('usable-lift-msl@f012');
  expect(predictSelections(null, null, undefined)).toEqual([]);
});

it('orders the timeline by direction, nearest first', () => {
  expect(timelineFrames(at('usable-lift-msl', 'f009'), undefined)).toEqual(['f012', 'f015', 'f018', 'f021', 'f024', 'f006', 'f003']);
  expect(timelineFrames(at('usable-lift-msl', 'f009'), -1)).toEqual(['f006', 'f003', 'f012', 'f015', 'f018', 'f021', 'f024']);
});
