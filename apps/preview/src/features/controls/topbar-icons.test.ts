import { describe, expect, it } from 'vitest';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import {
  cleanModelDisplayLabel,
  formatModelResolutionKm,
  modelApproxKm,
  modelRegionSubtitle,
  WIND_ENCODING_OPTIONS
} from './topbar-model';
import { DOCK_CHANNELS, formatWindLevelLabel } from '../../layers/channels';
import { resolveChannelStyles } from '../map/channel-styles';
import { MAP_THEMES, THEME_OPTIONS } from '../../themes/registry';

describe('topbar icon controls, model km resolution badges & composable per-channel style resolution', () => {
  it('defines compact unnumbered labels and chip names for all 8 soaring map styles', () => {
    expect(THEME_OPTIONS).toHaveLength(MAP_THEMES.length);
    for (const option of THEME_OPTIONS) {
      expect(option.label).not.toMatch(/^\d+\s*·/);
      expect(option.summary.length).toBeGreaterThan(20);
      expect(option.chipLabel.length).toBeGreaterThan(2);
      expect(option.chipLabel.length).toBeLessThanOrEqual(10);
    }
  });

  it('computes approximate horizontal resolution in km for every configured NWP model', () => {
    expect(modelApproxKm('gfs')).toBe(28);
    expect(formatModelResolutionKm('gfs')).toBe('28 km');
    expect(formatModelResolutionKm('icon-eu')).toBe('7 km');
    expect(formatModelResolutionKm('rrfs')).toBe('3 km');
    expect(formatModelResolutionKm('hrdps')).toBe('2.5 km');
    expect(formatModelResolutionKm('av-wrf')).toBe('3 km');
    expect(formatModelResolutionKm('wrf-va-1km')).toBe('1 km');
    expect(formatModelResolutionKm(null)).toBeNull();
    expect(cleanModelDisplayLabel('RRFS (CONUS)')).toBe('RRFS');
    expect(cleanModelDisplayLabel('WRF-NOVA 1 km (RRFS)')).toBe('WRF-NOVA');
    expect(cleanModelDisplayLabel('WRF-NOVA')).toBe('WRF-NOVA');
    for (const option of MODEL_OPTIONS) {
      expect(modelRegionSubtitle(option.modelId)?.length).toBeGreaterThan(3);
    }
  });

  it('normalizes lift, wind, clouds, rain, isobars, and peek in the unified channel dock', () => {
    expect(DOCK_CHANNELS.map(c => c.key)).toEqual(['lift', 'wind', 'clouds', 'rain', 'isobars', 'peek']);
    expect(DOCK_CHANNELS.filter(c => c.hasStyles).map(c => c.key)).toEqual(['wind']);
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

  it('binds the cloud style to the theme', () => {
    expect(resolveChannelStyles('classic').cloudStyle).toBe('sunlit-veil');
    expect(resolveChannelStyles('stone').cloudStyle).toBe('sunlit-veil');
    expect(resolveChannelStyles('slate').cloudStyle).toBe('satellite-ir');
    expect(resolveChannelStyles('chart').cloudStyle).toBe('nephanalysis');
  });
});
