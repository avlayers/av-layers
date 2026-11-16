import { describe, expect, it } from 'vitest';
import { renderedFrames } from '@av/contracts/publication';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { committedFrame, resumeModelFor, restoredCustomLayer, validatedCustomLayer } from './forecast-model';

describe('committedFrame', () => {
  it('selects the nearest frame and commits its valid time', () => {
    const build = fixtureBuild();
    const frames = renderedFrames(build.manifest);
    const committed = committedFrame(build, frames[1]!.validTime, Date.now());
    expect(committed.id).toBe(frames[1]!.id);
    expect(committed.validTime).toBe(frames[1]!.validTime);
  });

  it('keeps the committed time when a replacement model has a different grid', () => {
    const first = fixtureBuild();
    const committed = committedFrame(first, '2026-10-30T04:40:00.000Z', Date.now());
    expect(committed.validTime).toBe('2026-10-30T06:00:00.000Z');
    const base = first.manifest.frames[0]!;
    const frames = ['04', '05', '06'].map((hour, index) => {
      const validTime = `2026-10-30T${hour}:00:00.000Z`, end = Date.parse(validTime);
      return { ...base, id: `b${index}`, intervalStart: new Date(end - 3_600_000).toISOString(), intervalEnd: validTime, validTime };
    });
    const second = fixtureBuild({ buildId: `20260101T000000Z-${'b'.repeat(36)}`, frames });
    const again = committedFrame(second, committed.validTime, Date.now());
    expect(again.validTime).toBe('2026-10-30T06:00:00.000Z');
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


describe('restoredCustomLayer', () => {
  it('preserves a layer while a different model is resolving', () => {
    expect(restoredCustomLayer(fixtureBuild(), 'cloud-cover-total', true)).toBe('cloud-cover-total');
  });

  it('clears an unavailable layer on a same-model restore', () => {
    expect(restoredCustomLayer(fixtureBuild(), 'cloud-cover-total', false)).toBeNull();
  });

  it('keeps a supported layer on a same-model restore', () => {
    expect(restoredCustomLayer(fixtureBuild(), 'usable-lift-agl', false)).toBe('usable-lift-agl');
  });
});
