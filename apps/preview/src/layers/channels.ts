import { SKY_COVER_TIERS } from '@av/contracts/layers';
import type { UnitSystem } from '@av/client';
import type { ChannelView } from '../channels/channel';
import { themeOption, type MapTheme } from '../themes/registry';
import type { CloudStyleId, ThemeRecord } from '../themes/theme';
import { WIND_STYLE_LABELS, windStopLabel, type WindHeight, type WindStyle } from '../features/wind/wind-model';

export type WeatherChannelKey = 'lift' | 'wind' | 'clouds' | 'rain' | 'isobars';
export type DockChannelKey = WeatherChannelKey | 'peek';
type GlyphShape = ThemeRecord['glyph'][number];

interface ChannelDetailContext {
  readonly windStyle?: WindStyle;
  readonly windHeight?: WindHeight;
  readonly units?: UnitSystem;
}

/** A dock button: copy, shortcut and 24×24 stroked glyph. */
interface ChannelRecord<Key extends DockChannelKey = DockChannelKey> {
  readonly key: Key;
  readonly id: string;
  readonly shortLabel: string;
  readonly title: string;
  readonly hasStyles?: boolean;
  readonly shortcut?: string;
  readonly detail: (theme: MapTheme, ctx?: ChannelDetailContext) => string;
  readonly glyph: readonly GlyphShape[];
  /** Glyphs that replace `glyph` for a wind style. */
  readonly styleGlyphs?: Partial<Record<WindStyle, readonly GlyphShape[]>>;
}

/** A weather overlay toggled by the preview intent field `visibility`. */
interface WeatherChannelRecord extends ChannelRecord<WeatherChannelKey> {
  readonly visibility: keyof Pick<ChannelView, 'liftVisible' | 'windVisible' | 'cloudsVisible' | 'rainVisible' | 'isobarsVisible'>;
  /** Shown only when the build publishes wind data. */
  readonly needsWindData?: true;
}

export function formatWindLevelLabel(height: WindHeight, units: UnitSystem = 'metric'): string {
  if (height === 'surface') return 'SFC';
  if (height === 'lift') return 'TOL';
  return `${windStopLabel(height, units)} ${units === 'imperial' ? 'ft' : 'm'} AGL`;
}

const CLOUD_STYLE_SUMMARIES: Readonly<Record<CloudStyleId, string>> = {
  'sunlit-veil': 'Billowy sunlit Cu + neutral overcast ground shadow',
  nephanalysis: `Crisp vector ${SKY_COVER_TIERS.broken} / ${SKY_COVER_TIERS.overcast}% total cloud isolines + airy veil`,
  'satellite-ir': 'Simulated IR deck (bright upper tops, gray low cloud)'
};

const path = (d: string, strokeWidth?: string): GlyphShape => ({ tag: 'path', attrs: strokeWidth ? { d, 'stroke-width': strokeWidth } : { d } });
const circle = (cx: string, cy: string, r: string): GlyphShape => ({ tag: 'circle', attrs: { cx, cy, r } });

/** Weather overlays in dock order. */
export const WEATHER_CHANNELS: readonly WeatherChannelRecord[] = [
  {
    key: 'lift',
    id: 'toggle-lift',
    shortLabel: 'Lift',
    title: 'Thermal Lift',
    visibility: 'liftVisible',
    detail: theme => themeOption(theme).liftDetail,
    glyph: [
      path('M12 19.5V4.8m0 0L8.2 8.6M12 4.8l3.8 3.8'),
      path('M5.8 18c1.5-2.1 1.5-4.2 0-6.3M18.2 18c-1.5-2.1-1.5-4.2 0-6.3', '1.6')
    ]
  },
  {
    key: 'wind',
    id: 'toggle-wind',
    shortLabel: 'Wind',
    title: 'Wind',
    hasStyles: true,
    shortcut: 'W',
    visibility: 'windVisible',
    needsWindData: true,
    detail: (_theme, ctx) => {
      const styleLabel = WIND_STYLE_LABELS[ctx?.windStyle ?? 'trails'];
      const level = formatWindLevelLabel(ctx?.windHeight ?? 'surface', ctx?.units ?? 'metric');
      return `${styleLabel} at ${level} · adjust height on the right WIND rail`;
    },
    glyph: [path('M3 7.2h12.2a2.4 2.4 0 1 0-2.1-3.5M3 12h15.2a2.4 2.4 0 1 1-2.1 3.5M3 16.8h8.8')],
    styleGlyphs: {
      barbs: [circle('5.5', '17.5', '1.7'), path('M6.8 16.2 17.8 4.8m0 0 3.7 3m-6.8 0 3 2.5')],
      hybrid: [path('M3 7c3.2-2.4 5.8 2.4 9.2 0s4.8-1.8 7.3.4M3 13c2.8-2 5 1.8 8 0'), path('M13.5 18.2 19.5 9.5m0 0 2.5 2.2')]
    }
  },
  {
    key: 'clouds',
    id: 'toggle-clouds',
    shortLabel: 'Clouds',
    title: 'Cloud Cover',
    visibility: 'cloudsVisible',
    detail: theme => CLOUD_STYLE_SUMMARIES[themeOption(theme).cloudStyle],
    glyph: [path('M6.4 17.8h11.1a3.8 3.8 0 0 0 .5-7.56A5.3 5.3 0 0 0 7.5 8.9a3.6 3.6 0 0 0-1.1 8.9Z')]
  },
  {
    key: 'rain',
    id: 'toggle-rain',
    shortLabel: 'Rain',
    title: 'Precipitation',
    visibility: 'rainVisible',
    detail: () => 'Asymmetric inner storm cuff + crisp dry halo & falling rain',
    glyph: [
      path('M6.4 13h10.9a3.3 3.3 0 0 0 .4-6.56A4.6 4.6 0 0 0 8.2 5.2 3.2 3.2 0 0 0 6.4 13Z'),
      path('m8.6 15.8-1.5 3.9M12.6 15.8l-1.5 3.9M16.6 15.8l-1.5 3.9')
    ]
  },
  {
    key: 'isobars',
    id: 'toggle-isobars',
    shortLabel: 'Isobars',
    title: 'Pressure Isobars',
    shortcut: 'I',
    visibility: 'isobarsVisible',
    detail: () => 'Sea-level contours every 2 hPa (bold 4 hPa) with H / L centers',
    glyph: [
      path('M2.6 13.8C3.5 7 8.4 3.2 16 3.4c2.3.1 4.1.7 5.4 1.8'),
      path('M5.2 19C6.2 11.8 10.4 8.2 17.2 8.4c1.6.1 2.9.5 4 1.3', '1.65'),
      path('M14.2 13.5v6.4M19.2 13.5v6.4M14.2 16.7h5', '2.0')
    ]
  }
];

export const PEEK_CHANNEL: ChannelRecord<'peek'> = {
  key: 'peek',
  id: 'peek-toggle',
  shortLabel: 'Peek',
  title: 'Bare Terrain Peek',
  shortcut: 'Space / P',
  detail: () => 'Hold to inspect bare terrain & relief, or click to latch',
  glyph: [path('M2.2 12s3.6-6.3 9.8-6.3 9.8 6.3 9.8 6.3-3.6 6.3-9.8 6.3S2.2 12 2.2 12Z'), circle('12', '12', '2.8')]
};

/** Every dock button in order: the weather overlays, then peek. */
export const DOCK_CHANNELS: readonly ChannelRecord[] = [...WEATHER_CHANNELS, PEEK_CHANNEL];

export const weatherChannel = (key: WeatherChannelKey): WeatherChannelRecord => WEATHER_CHANNELS.find(channel => channel.key === key)!;
