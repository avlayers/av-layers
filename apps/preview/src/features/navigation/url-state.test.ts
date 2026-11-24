import { describe, expect, it } from 'vitest';
import { previewQuery, previewUrl } from './url-state';

const deepLink = '?model=auto&ref=agl&opacity=0.5&lat=35.6323&lon=46.1730&z=4.68&units=imperial';

describe('previewQuery', () => {
  it('parses the supplied deep link', () => {
    const state = previewQuery(deepLink, false);
    expect(state).toMatchObject({ model: 'auto', reference: 'agl', opacity: 0.5, units: 'imperial', camera: { center: [46.173, 35.6323], zoom: 4.68 } });
  });

  it('drops invalid and unknown values', () => {
    const state = previewQuery('?model=nope&lat=200&lon=x&z=4&opacity=9&wstyle=nope&wheight=1&dock=classic', false);
    expect(state.model).toBeNull();
    expect(state.camera).toBeNull();
    expect(state.opacity).toBe(1);
    expect(state.windStyle).toBeNull();
    expect(state.dockView).toBeNull();
    expect(state.windHeight).not.toBeNull();
  });

  it('uses stored preferences only when the URL omits them', () => {
    expect(previewQuery('', false).units).toBeNull();
    expect(previewQuery('?units=metric', false).units).toBe('metric');
    expect(previewQuery('', false).dockView).toBeNull();
    expect(previewQuery('?dock=capsule', false).dockView).toBe('capsule');
    expect(previewQuery('?theme=classic', false).theme).toBe('classic');
  });

  it('maps retired theme ids to kept themes and ignores retired style params', () => {
    expect(previewQuery('?theme=alabaster', false).theme).toBe('stone');
    expect(previewQuery('?theme=convergence', false).theme).toBe('stone');
    expect(previewQuery('?theme=blueprint', false).theme).toBe('chart');
    expect(previewQuery('?theme=cockpit', false).theme).toBe('chart');
    expect(previewQuery('?theme=toString', false).theme).toBeNull();
    expect(previewQuery('?cstyle=cu-overcast&rstyle=wet-lens', false)).toEqual(previewQuery('', false));
  });
});

describe('previewUrl', () => {
  it('round-trips the deep link meaning under the serializer', () => {
    const parsed = previewQuery(deepLink, false);
    const url = previewUrl('/', {
      model: parsed.model!, reference: parsed.reference, layer: parsed.layer, opacity: parsed.opacity!,
      lat: parsed.camera!.center[1], lon: parsed.camera!.center[0], zoom: parsed.camera!.zoom, units: parsed.units!
    });
    const again = previewQuery(url.slice(url.indexOf('?')), false);
    expect(again.model).toBe(parsed.model);
    expect(again.reference).toBe(parsed.reference);
    expect(again.opacity).toBe(parsed.opacity);
    expect(again.camera).toEqual(parsed.camera);
    expect(again.units).toBe(parsed.units);
  });

  it('omits default options and keeps two-decimal precision', () => {
    const url = previewUrl('/', { model: 'gfs', reference: 'agl', opacity: 0.5, lat: 1.23456, lon: 2.34567, zoom: 4.678, units: 'metric', dockView: 'capsule', windStyle: 'trails', windHeight: 'surface' });
    expect(url).toBe('/?model=gfs&ref=agl&opacity=0.5&lat=1.2346&lon=2.3457&z=4.68');
  });
});
