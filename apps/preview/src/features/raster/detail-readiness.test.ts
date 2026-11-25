import { expect, it } from 'vitest';
import { classifyDetail, coveredTileKeys, DetailTracker, tileKey } from './detail-readiness';

const set = (...keys: string[]) => new Set(keys);
const still = { stationary: true, sourceLoaded: true, sourceErrored: false };

it('keys tiles by canonical z/x/y', () => {
  expect(tileKey({ tileID: { canonical: { z: 3, x: 1, y: 2 } } })).toBe('3/1/2');
  expect(tileKey({ tileID: { canonical: { z: 3, x: Number.NaN, y: 2 } } })).toBeNull();
  expect(tileKey({})).toBeNull();
});

it('keeps covering tiles that intersect the build bounds', () => {
  const covering = [{ canonical: { z: 1, x: 0, y: 0 } }, { canonical: { z: 1, x: 1, y: 0 } }, { canonical: { z: 1, x: 1, y: 1 } }, {}, undefined];
  expect(coveredTileKeys(covering, [0, 0, 10, 10])).toEqual(['1/1/0']);
  expect(coveredTileKeys(covering, undefined)).toEqual(['1/0/0', '1/1/0', '1/1/1']);
  expect(coveredTileKeys({ length: 2 }, undefined)).toEqual([]);
});

it('classifies required, loaded, pending and errored tiles', () => {
  const none = set();
  expect(classifyDetail({ ...still, stationary: false }, set('a'), set('a'), none, none)).toBe('idle');
  expect(classifyDetail(still, none, none, none, none)).toBe('valid-empty');
  expect(classifyDetail(still, set('a', 'b'), set('a', 'b'), none, none)).toBe('complete');
  expect(classifyDetail(still, set('a', 'b'), set('a'), set('b'), none)).toBe('idle');
  expect(classifyDetail(still, set('a', 'b'), set('a'), none, set('b'))).toBe('partial');
  expect(classifyDetail({ ...still, sourceErrored: true }, set('a', 'b'), set('a'), none, none)).toBe('partial');
  expect(classifyDetail(still, set('a'), none, none, set('a'))).toBe('failed');
  expect(classifyDetail({ ...still, sourceLoaded: false, sourceErrored: true }, none, none, none, none)).toBe('failed');
  expect(classifyDetail({ ...still, sourceLoaded: false }, set('a'), set('a'), none, none)).toBe('idle');
});

it('tracks tile events against the required set', () => {
  const tracker = new DetailTracker();
  tracker.require(['a', 'b']);
  tracker.loading('a'); tracker.loading('b');
  tracker.refresh(still);
  expect(tracker.state).toBe('idle');
  tracker.load('a'); tracker.error('b');
  tracker.refresh(still);
  expect(tracker.state).toBe('partial');
  expect(tracker.counts()).toEqual({ requiredTiles: 2, loadedTiles: 1, pendingTiles: 0, erroredTiles: 1 });
  tracker.load('b');
  tracker.refresh(still);
  expect(tracker.state).toBe('complete');
  tracker.invalidate();
  expect(tracker.state).toBe('idle');
  expect(tracker.counts()).toEqual({ requiredTiles: 0, loadedTiles: 2, pendingTiles: 0, erroredTiles: 0 });
  tracker.loading('c'); tracker.abort('c');
  tracker.reset();
  expect(tracker.counts()).toEqual({ requiredTiles: 0, loadedTiles: 0, pendingTiles: 0, erroredTiles: 0 });
});
