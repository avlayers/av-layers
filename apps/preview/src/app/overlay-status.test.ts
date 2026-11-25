import { describe, expect, it } from 'vitest';
import { skyStatusText } from './overlay-status';

describe('skyStatusText', () => {
  it('is empty when every visible sky channel draws the selected hour', () => {
    expect(skyStatusText({ clouds: 'ready', rain: 'ready' })).toBe('');
    expect(skyStatusText({})).toBe('');
  });

  it('names waiting and missing channels separately', () => {
    expect(skyStatusText({ clouds: 'loading', isobars: 'unavailable', rain: 'loading' })).toBe('Clouds, rain loading… · Pressure unavailable');
  });
});
