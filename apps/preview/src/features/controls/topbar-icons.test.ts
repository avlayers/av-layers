import { describe, expect, it } from 'vitest';
import {
  cleanModelDisplayLabel,
  DOCK_CHANNELS,
  formatModelResolutionKm,
  formatWindLevelLabel,
  modelApproxKm,
  THEME_CHIP_LABELS,
  WIND_ENCODING_OPTIONS
} from './topbar-model';
import { resolveChannelStyles } from '../map/channel-styles';
import { MAP_THEMES, THEME_OPTIONS } from '../map/visual-theme';

describe('topbar icon controls, model km resolution badges & composable per-channel style resolution', () => {
  it('defines compact unnumbered labels and chip names for all 8 soaring map styles', () => {
    expect(THEME_OPTIONS).toHaveLength(MAP_THEMES.length);
    for (const option of THEME_OPTIONS) {
      expect(option.label).not.toMatch(/^\d+\s*·/);
      expect(option.summary.length).toBeGreaterThan(20);
      expect(THEME_CHIP_LABELS[option.id].length).toBeGreaterThan(2);
      expect(THEME_CHIP_LABELS[option.id].length).toBeLessThanOrEqual(10);
    }
  });

  it('computes approximate horizontal resolution in km for every configured NWP model', () => {
    expect(modelApproxKm('gfs')).toBe(28);
    expect(formatModelResolutionKm('gfs')).toBe('28 km');
    expect(formatModelResolutionKm('icon-eu')).toBe('7 km');
    expect(formatModelResolutionKm('rrfs')).toBe('3 km');
    expect(formatModelResolutionKm('av-wrf')).toBe('3 km');
    expect(formatModelResolutionKm('wrf-va-1km')).toBe('1 km');
    expect(formatModelResolutionKm(null)).toBeNull();
    expect(cleanModelDisplayLabel('WRF northern Virginia 1 km (RRFS)')).toBe('WRF northern Virginia (RRFS)');
  });

  it('normalizes lift, wind, clouds, rain, isobars, and peek in the unified channel dock', () => {
    expect(DOCK_CHANNELS.map(c => c.key)).toEqual(['lift', 'wind', 'clouds', 'rain', 'isobars', 'peek']);
    expect(DOCK_CHANNELS.filter(c => c.hasStyles).map(c => c.key)).toEqual(['wind', 'clouds', 'rain']);
    expect(WIND_ENCODING_OPTIONS.map(opt => opt.id)).toEqual(['trails', 'barbs', 'hybrid']);
    expect(formatWindLevelLabel('surface', 'metric')).toBe('SFC');
    expect(formatWindLevelLabel('lift', 'imperial')).toBe('TOL');
    expect(formatWindLevelLabel(1000, 'metric')).toBe('1,000 m AGL');
    expect(formatWindLevelLabel(1000, 'imperial')).toBe('3,000 ft AGL');
    for (const channel of DOCK_CHANNELS) {
      for (const theme of MAP_THEMES) {
        expect(channel.detail(theme).length).toBeGreaterThan(15);
      }
    }
  });

  it('resolves curated auto per-theme defaults while allowing independent cloudStyle and rainStyle overrides', () => {
    expect(resolveChannelStyles('xcskies').cloudStyle).toBe('sunlit-veil');
    expect(resolveChannelStyles('xcskies').rainStyle).toBe('vignette-cuff');
    expect(resolveChannelStyles('slate').cloudStyle).toBe('satellite-ir');
    expect(resolveChannelStyles('chart').cloudStyle).toBe('nephanalysis');
    expect(resolveChannelStyles('convergence').cloudStyle).toBe('cu-overcast');

    const overridden = resolveChannelStyles('xcskies', {
      cloudStyle: 'nephanalysis',
      rainStyle: 'sigwx-scallop'
    });
    expect(overridden.cloudStyle).toBe('nephanalysis');
    expect(overridden.rainStyle).toBe('sigwx-scallop');
  });
});
