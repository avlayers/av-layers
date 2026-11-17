import { expect, it } from 'vitest';
import { correlatePointerActions, measureWindCall, type PointerAction } from './preview-observe';

it('attributes delayed and stale commits within selection lifetimes across A-B-A', () => {
  const trace = (epochMs: number, playhead: number) => ({ epochMs, playhead, scene: null, sceneCount: 0 });
  const actions: PointerAction[] = [0, 1, 0].map((index, i) => ({ kind: 'scrub', requested: index, before: trace(i * 100, index), after: trace(i * 100 + 20, index) }));
  const inputs = [0, 1, 0].map((index, i) => ({ index, targetFrame: ['A', 'B'][index], inputEpochMs: i * 100 + 10, outcome: 'superseded' }));
  const commits = [{ index: 0, frame: 'A', epochMs: 50 }, { index: 0, frame: 'A', epochMs: 150 }, { index: 1, frame: 'B', epochMs: 160 }, { index: 0, frame: 'A', epochMs: 250 }];
  const result = correlatePointerActions(actions, inputs, commits, 300, ['A', 'B']);
  expect(result.map(action => action.status)).toEqual(['delivered', 'delivered', 'delivered']);
  expect(result.map(action => action.delivered.map(commit => commit.epochMs))).toEqual([[50], [160], [250]]);
  expect(result[1].staleCommits.map(commit => commit.epochMs)).toEqual([150]);
  expect(result.map(action => action.selectionUntilEpochMs)).toEqual([110, 210, 300]);
});

it('counts only successful retained wind builds and separates null and errors', () => {
  const recorded: string[] = [], record = (name: string) => { recorded.push(name); };
  expect(measureWindCall('grid', false, () => null, () => false, record)).toBeNull();
  expect(() => measureWindCall('grid', false, () => { throw new Error('failed'); }, () => false, record)).toThrow('failed');
  expect(measureWindCall('grid', false, () => ({}), () => true, record)).toEqual({});
  expect(measureWindCall('sampler', false, () => ({}), () => false, record)).toEqual({});
  expect(measureWindCall('sampler', null, () => ({}), () => null, record)).toEqual({});
  expect(recorded).toEqual(['wind-grid-uncached-null', 'wind-grid-uncached-failed', 'wind-grid-uncached-success', 'wind-grid-build', 'wind-sampler-uncached-success', 'wind-sampler-unknown-success']);
});
