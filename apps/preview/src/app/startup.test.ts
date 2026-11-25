import { describe, expect, it } from 'vitest';
import { previewQuery } from '../features/navigation/url-state';
import { WIND_STORAGE_KEY } from '../features/wind/wind-model';
import { createStartup, resolveDisplay } from './startup';

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}

const stored = memoryStorage({
  'preview-units': 'imperial',
  'preview-lift-opacity': '0.4',
  'preview-theme': 'slate',
  [WIND_STORAGE_KEY]: JSON.stringify({ style: 'barbs', visible: false, height: 'surface', fixedHeight: 500 })
});

describe('resolveDisplay', () => {
  it('prefers the URL, then the stored preference, then the default', () => {
    const { preferences } = createStartup('', stored, true);
    expect(resolveDisplay(previewQuery('?units=metric&wstyle=hybrid', true), preferences)).toMatchObject({ units: 'metric', windStyle: 'hybrid' });
    expect(resolveDisplay(previewQuery('', true), preferences)).toMatchObject({ units: 'imperial', opacity: 0.4, theme: 'slate', windStyle: 'barbs', windVisible: false });
    const { preferences: empty } = createStartup('', memoryStorage({}), true);
    expect(resolveDisplay(previewQuery('', true), empty)).toMatchObject({ units: 'metric', opacity: 0.72, windStyle: 'trails', windVisible: true, windHeight: 'surface' });
  });

  it('gives history restore the same display a fresh load of that URL gets', () => {
    for (const search of ['', '?units=metric', '?wstyle=hybrid&isobars=1']) {
      const startup = createStartup(search, stored, true);
      const restored = resolveDisplay(previewQuery(search, true), startup.preferences);
      for (const [key, value] of Object.entries(restored)) {
        expect(startup.initial.intent[key as keyof typeof restored], `${search} ${key}`).toEqual(value);
      }
    }
  });
});
