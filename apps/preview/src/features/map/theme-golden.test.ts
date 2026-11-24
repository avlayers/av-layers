import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIFT_COLORS, RAIN_COLORS } from '@av/contracts/layers';
import { compositeBasemapStyle } from './basemap';
import { resolveChannelStyles } from './channel-styles';
import { themeLiftLegendColors } from '../../themes/palette';
import { MAP_THEMES, themeOption, type MapTheme } from '../../themes/registry';
import { remapRgbaInPlace } from '../raster/tile-remap-core';

/**
 * Rendering-level fingerprint of each kept theme: basemap style, channel tokens, palettes,
 * legends and the remapped pixels of a tile that contains every server palette colour.
 * Structural refactors must leave it unchanged; regenerate with UPDATE_THEME_GOLDEN=1
 * only for an intended visual change.
 */
const GOLDEN = fileURLToPath(new URL('./theme-golden.json', import.meta.url));

function paletteTile(colors: readonly string[]): Uint8ClampedArray {
  const size = 64, pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const hex = colors[Math.floor(i / 7) % colors.length]!;
    pixels[i * 4] = Number.parseInt(hex.slice(1, 3), 16);
    pixels[i * 4 + 1] = Number.parseInt(hex.slice(3, 5), 16);
    pixels[i * 4 + 2] = Number.parseInt(hex.slice(5, 7), 16);
    pixels[i * 4 + 3] = i % 11 === 0 ? 0 : 255;
  }
  return pixels;
}

function remapHash(kind: 'lift' | 'rain', theme: MapTheme): string {
  const pixels = paletteTile(kind === 'lift' ? LIFT_COLORS : RAIN_COLORS);
  remapRgbaInPlace(pixels, 64, 64, kind, theme);
  return createHash('sha256').update(pixels).digest('hex');
}

function fingerprint(theme: MapTheme): unknown {
  const option = themeOption(theme);
  const styles = resolveChannelStyles(theme);
  return {
    darkChrome: option.darkChrome,
    basemap: createHash('sha256').update(JSON.stringify(compositeBasemapStyle(theme))).digest('hex'),
    channels: { cloudContours: styles.cloudContours, rainEdge: styles.rainEdge, isobar: styles.isobar },
    liftStops: themeOption(theme).liftStops,
    rainStops: themeOption(theme).rainStops,
    legends: { lift: themeLiftLegendColors(theme), rain: themeOption(theme).rainLegend, cloud: themeOption(theme).cloudLegend },
    remap: { lift: remapHash('lift', theme), rain: remapHash('rain', theme) }
  };
}

describe('theme golden', () => {
  it('keeps every kept theme rendering identical', () => {
    const actual = Object.fromEntries(MAP_THEMES.map(theme => [theme, fingerprint(theme)]));
    if (process.env.UPDATE_THEME_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    expect(JSON.parse(JSON.stringify(actual))).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
