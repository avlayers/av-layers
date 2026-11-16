import { describe, expect, it } from 'vitest';
import { renderedFrames } from '@av/contracts/publication';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { committedFrame, resumeModelFor, validatedCustomLayer } from './forecast-model';

describe('committedFrame', () => {
  it('selects the nearest frame and commits its valid time', () => {
    const build = fixtureBuild();
    const frames = renderedFrames(build.manifest);
    const committed = committedFrame(build, frames[1]!.validTime, Date.now());
    expect(committed.id).toBe(frames[1]!.id);
    expect(committed.validTime).toBe(frames[1]!.validTime);
  });

  it('keeps the committed time when a replacement model has a different grid', () => {
    const build = fixtureBuild();
    const frames = renderedFrames(build.manifest);
    const committed = committedFrame(build, frames[1]!.validTime, Date.now());
    const again = committedFrame(build, committed.validTime, Date.now());
    expect(again.id).toBe(committed.id);
    expect(again.validTime).toBe(committed.validTime);
  });

  it('falls back to the latest frame at or before now when no time is requested', () => {
    const build = fixtureBuild();
    const frames = renderedFrames(build.manifest);
    const committed = committedFrame(build, null, Date.parse(frames[0]!.validTime) + 1);
    expect(committed.id).toBe(frames[0]!.id);
  });
});

describe('validatedCustomLayer', () => {
  it('preserves a requested layer while discovery is pending', () => {
    expect(validatedCustomLayer(null, 'usable-lift-agl')).toBe('usable-lift-agl');
  });

  it('keeps a layer the resolved build supports', () => {
    const build = fixtureBuild();
    expect(validatedCustomLayer(build, 'usable-lift-agl')).toBe('usable-lift-agl');
  });

  it('clears a layer the resolved build does not support', () => {
    const build = fixtureBuild();
    expect(validatedCustomLayer(build, 'cloud-cover-total')).toBeNull();
  });
});


describe('resumeModelFor', () => {
  it('resumes the interrupted model', () => {
    expect(resumeModelFor('icon-eu', 'auto')).toBe('icon-eu');
  });

  it('resumes an interrupted Auto discovery', () => {
    expect(resumeModelFor(null, 'auto')).toBe('auto');
  });

  it('does not resume an idle explicit model', () => {
    expect(resumeModelFor(null, 'gfs')).toBeNull();
  });
});
