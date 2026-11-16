import { describe, expect, it, vi } from 'vitest';
import { createHistoryController } from './history-controller';
import { previewUrl } from './url-state';

const state = { model: 'gfs' as const, reference: 'agl' as const, layer: null, opacity: 0.5, lat: 40, lon: -100, zoom: 5, units: 'metric' as const };

function harness() {
  const push = vi.fn(), replace = vi.fn();
  const history = createHistoryController({ pathname: () => '/', search: () => '', push, replace }, false);
  return { history, push, replace };
}

describe('history controller', () => {
  it('writes push and replace modes', () => {
    const test = harness();
    test.history.write(state, 'push', true);
    test.history.write({ ...state, zoom: 6 }, 'replace', true);
    expect(test.push).toHaveBeenCalledTimes(1);
    expect(test.replace).toHaveBeenCalledTimes(1);
  });

  it('suppresses writes while a restoration owns the generation', () => {
    const test = harness();
    const generation = test.history.beginRestore();
    test.history.write(state, 'push', true);
    expect(test.push).not.toHaveBeenCalled();
    test.history.endRestore(generation);
    test.history.write(state, 'push', true);
    expect(test.push).toHaveBeenCalledTimes(1);
  });

  it('ignores an older restoration completion', () => {
    const test = harness();
    const first = test.history.beginRestore(), second = test.history.beginRestore();
    test.history.endRestore(first);
    expect(test.history.restoring()).toBe(true);
    test.history.endRestore(second);
    expect(test.history.restoring()).toBe(false);
  });

  it('honors the caller write guard and deduplicates the current URL', () => {
    const test = harness();
    test.history.write(state, 'push', false);
    expect(test.push).not.toHaveBeenCalled();
    const url = previewUrl('/', state), search = url.slice(url.indexOf('?'));
    const same = createHistoryController({ pathname: () => '/', search: () => search, push: test.push, replace: test.replace }, false);
    same.write(state, 'push', true);
    expect(test.push).not.toHaveBeenCalled();
  });
});
