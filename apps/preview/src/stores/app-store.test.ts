import { describe, expect, it } from 'vitest';
import { createPreviewStore, emptyOverlay, preparedAxisReadiness, type PreviewInitialState } from './app-store';
import { fixtureBuild } from '../../../../tests/forecast-fixture';

function initial(): PreviewInitialState {
  return {
    intent: {
      model: 'gfs', reference: 'agl', customLayer: null, opacity: 0.5, units: 'metric',
      windStyle: 'trails', windVisible: true, windVisibleOverride: null, windPaused: false,
      windHeight: 'surface', fixedWindHeight: 0, pointHorizon: 'day', requestedTime: null
    },
    forecast: {
      build: null, selectedFrame: null, pendingModel: null, expired: false, mapReady: false, mapFailed: false, layers: [],
      offsetMinutes: 0, mapCenter: null, playing: false
    },
    overlay: emptyOverlay,
    wind: { status: 'unavailable', overview: false, displayed: false, supported: false },
    point: { open: false, location: '', horizonSelectable: false, horizonLabel: '24 hours', busy: false, status: '', wind: '' },
    location: { message: '', detail: '', busy: false },
    notices: { error: '', tileError: '', horizon: '', freshness: '', frameStatus: '', overviewReady: 0, overviewTotal: 0, overviewFailed: 0, detailReady: 0, preparationLimited: false, scaleWidth: 1, scaleText: '' }
  };
}

describe('preparedAxisReadiness', () => {
  const frames = ['day1-am', 'day2-noon', 'day3-pm', 'day4-am'].map(id => ({ id }));

  it('intersects exact retained identities across every rendered day', () => {
    expect(preparedAxisReadiness(frames, new Set(['day1-am', 'day2-noon']), new Set(), new Set(['day2-noon', 'day3-pm'])))
      .toEqual({ overviewReady: 1, overviewTotal: 4, detailReady: 0 });
  });

  it('counts native images as usable previews and counts detail independently', () => {
    expect(preparedAxisReadiness(frames, new Set(['day1-am']), new Set(['day3-pm']), new Set(['day3-pm'])))
      .toEqual({ overviewReady: 1, overviewTotal: 4, detailReady: 1 });
  });

  it('counts raster alone when wind is hidden and excludes identities outside the axis', () => {
    expect(preparedAxisReadiness(frames, new Set(['day1-am', 'unpublished']), new Set(['day4-am', 'unpublished']), null))
      .toEqual({ overviewReady: 2, overviewTotal: 4, detailReady: 1 });
  });

  it('keeps the full denominator when selected-height wind or raster is missing', () => {
    expect(preparedAxisReadiness(frames, new Set(frames.map(frame => frame.id)), new Set(), new Set()))
      .toEqual({ overviewReady: 0, overviewTotal: 4, detailReady: 0 });
    expect(preparedAxisReadiness(frames, new Set(), new Set(), new Set(frames.map(frame => frame.id))))
      .toEqual({ overviewReady: 0, overviewTotal: 4, detailReady: 0 });
  });
});

describe('createPreviewStore', () => {
  it('creates independent instances', () => {
    const first = createPreviewStore(initial()), second = createPreviewStore(initial());
    first.writer.intent({ units: 'imperial' });
    expect(first.view.intent.value.units).toBe('imperial');
    expect(second.view.intent.value.units).toBe('metric');
  });

  it('replaces immutable intent objects and preserves unchanged references', () => {
    const store = createPreviewStore(initial());
    const before = store.view.intent.value;
    store.writer.intent({ opacity: 0.4 });
    expect(store.view.intent.value).not.toBe(before);
    expect(before.opacity).toBe(0.5);
    expect(Object.isFrozen(store.view.intent.value)).toBe(true);
  });

  it('keeps the pinned build instance when publishing status', () => {
    const store = createPreviewStore(initial());
    const build = fixtureBuild();
    store.writer.forecast({ build });
    store.writer.wind({ status: 'loading' });
    expect(store.view.forecast.value.build).toBe(build);
  });
});
