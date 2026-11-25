// Visual chart key: climb or lapse bands, wind barb strip, and mark legend.

import { SINK_RATE_MPS } from '@av/soaring';
import { WINDGRAM_HYBRID_SKY_COLOR, WINDGRAM_INVERSION_BANDS, DEFAULT_WINDGRAM_FIELD_MODE, type WindgramFieldMode } from './windgram-atmosphere.ts';
import { climbBandRange, WINDGRAM_CLIMB_BANDS } from './windgram-climb.ts';
import { CLOUD_BKN_RH_PERCENT, CLOUD_SCT_RH_PERCENT } from './windgram-clouds.ts';
import { formatQuantity, knotsToMps, unitLabel, type UnitSystem } from './windgram-format.ts';
import { CALM_RADIUS, CLOUD_PATH, SNOWFLAKE_PATH } from './windgram-glyphs.ts';
import { escapeMarkup as escape, SVG_NS } from './windgram-markup.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import { WINDGRAM_STABILITY, WINDGRAM_STABLE_COLOR, stabilityRange } from './windgram-stability.ts';
import { barbGeometry } from './wind-barb.ts';
import { WIND_SPEED_KNOT_THRESHOLDS, windBarbSpeedColor } from './windgram-wind-tiers.ts';

function renderKeyWindStrip(fieldMode: WindgramFieldMode, southernHemisphere = false): string {
  const hybrid = fieldMode === 'hybrid-climb';
  const colorFor = (kt: number) => (hybrid ? windBarbSpeedColor(kt) : kt < 9 ? '#78ff78' : '#ffffff');
  const samples = [
    { kt: 0, x: 14, label: '0' },
    { kt: 5, x: 38, label: '5' },
    { kt: 10, x: 64, label: '10' },
    { kt: 15, x: 92, label: '15' },
    { kt: 50, x: 122, label: '50 kt' },
  ] as const;
  const glyphs = samples
    .map(({ kt, x, label }) => {
      const geo = barbGeometry(kt, 0, 14, southernHemisphere);
      const color = colorFor(kt);
      const body = geo.calm
        ? `<circle r="${CALM_RADIUS}" fill="none" stroke="${color}" stroke-width="1.35"/>`
        : `<path d="${geo.staff}" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round"/>` +
          geo.flags
            .map(flag =>
              flag.endsWith('Z')
                ? `<path d="${flag}" fill="${color}" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>`
                : `<path d="${flag}" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round"/>`,
            )
            .join('');
      return (
        `<g transform="translate(${x} 18)" data-key-barb="${kt}">${body}</g>` +
        `<text x="${x}" y="29" text-anchor="middle" fill="#cbd5e1" font-size="8.5" font-family="ui-sans-serif,system-ui,sans-serif">${label}</text>`
      );
    })
    .join('');
  // Downwind hover-dial arrow sample (wind from N = 0°: barb points up toward N source, hover arrow points down S downwind)
  const dialSample =
    '<g transform="translate(162 12)" data-key-hover-dial="">' +
    '<circle cx="0" cy="0" r="7.5" fill="#0f1b2d" stroke="#64748b" stroke-width="1"/>' +
    '<path d="M0 -4.4L2.9 3.6L0 1.8L-2.9 3.6Z" transform="rotate(180)" fill="#f8fafc"/>' +
    '</g>' +
    '<text x="162" y="29" text-anchor="middle" fill="#cbd5e1" font-size="8.5" font-family="ui-sans-serif,system-ui,sans-serif">hover</text>';
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 184 32" width="184" height="32" class="wg-key-wind-svg" aria-hidden="true">${glyphs}${dialSample}</svg>`;
}

const LAPSE_SHORT_LABELS = [
  'Strong',
  'Good',
  'Unstable',
  'Weak',
  'Marginal',
  'Stable',
  'Weak inv',
  'Inversion',
] as const;

const CLIMB_SHORT_LABELS = ['Marginal', 'Light', 'Moderate', 'Good', 'Strong', 'Booming'] as const;

export function renderWindgramKey(
  system: UnitSystem,
  usesDsm = false,
  fieldMode: WindgramFieldMode = DEFAULT_WINDGRAM_FIELD_MODE,
  southernHemisphere = false,
): string {
  const icon = (content: string, width = 32) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} 22" width="${width}" height="22" aria-hidden="true">${content}</svg>`;
  const feathers = 'half 5 / full 10 / flag 50 kt';
  const lapseGreenLimit = formatQuantity(knotsToMps(9), 'wind', undefined, system);
  const freezing = icon(
    `<path d="M1 11H31" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="5 3"/><path d="${SNOWFLAKE_PATH}" transform="translate(16 11)" fill="none" stroke="#67e8f9"/>`,
  );
  const missing = icon(
    '<rect x="2" y="2" width="28" height="18" rx="3" fill="#a7a4c0"/>' +
    '<path d="M4 19L19 4M12 19L27 4M4 11L11 4M20 19L27 12" stroke="#5b5875" stroke-width="1.2"/>',
  );
  const windStrip = renderKeyWindStrip(fieldMode, southernHemisphere);

  if (fieldMode === 'lapse') {
    const humidity = icon(
      `<rect x="2" y="2" width="28" height="18" rx="3" fill="${WINDGRAM_STABLE_COLOR}"/><path d="M4 4L20 19M12 4L28 19M4 19L20 4M12 19L28 4" stroke="#fff" stroke-width="1"/>`,
    );
    const potential = icon(`<path d="${CLOUD_PATH}" transform="translate(16 18) scale(.52)" fill="none" stroke="#93c5fd" stroke-width="1.7" stroke-dasharray="3.5 2.5"/>`);
    const lift = icon(
      '<path d="M1 11H31" stroke="#3b82f6" stroke-width="2"/>' +
      '<circle cx="9" cy="11" r="3" fill="#2563eb" stroke="#fff" stroke-width="1.2"/>' +
      '<circle cx="23" cy="11" r="3" fill="#2563eb" stroke="#fff" stroke-width="1.2"/>',
    );
    const lapseUnit = unitLabel('lapseRate', system);
    const lapseCells = WINDGRAM_STABILITY.map(({ className }, i) => {
      const range = stabilityRange(i, system);
      const shortName = LAPSE_SHORT_LABELS[i] ?? `Band ${i + 1}`;
      return (
        `<div class="wg-key-band" role="listitem" tabindex="0" aria-label="${escape(`${shortName}: ${range} ${lapseUnit}`)}">` +
        `<span class="wg-key-band-lbl">${escape(shortName)}</span>` +
        `<span class="wg-key-seg meteo-gram-stab-${escape(className)}"></span>` +
        `<span class="wg-key-band-rng">${escape(range)}</span>` +
        `</div>`
      );
    }).join('');
    return (
      `<div class="windgram-legend">` +
      `<div class="wg-key-head"><strong>Visual Chart Key</strong><span>Lapse rate · ${escape(lapseUnit)}</span></div>` +
      `<div class="wg-key-spectrum">` +
      `<div class="wg-key-bands wg-key-bands-4" role="list" aria-label="Environmental lapse rate bands">${lapseCells}</div>` +
      `</div>` +
      `<div class="wg-key-wind-box">` +
      `<div class="wg-key-wind-copy"><strong>Wind · ${feathers} (15 = 10 + 5 kt)</strong><span>Green wind is below ${escape(lapseGreenLimit)}; white ≥${escape(lapseGreenLimit)}. Barb points to wind source; hover arrow points downwind.</span></div>` +
      windStrip +
      `</div>` +
      `<div class="wg-key-grid">` +
      `<div class="wg-key-item">${lift}<div><strong>Map usable lift</strong><span>Magnetic Top-of-Lift curve</span></div></div>` +
      `<div class="wg-key-item">${potential}<div><strong>Cloud base (LCL)</strong><span>Potential cumulus base</span></div></div>` +
      `<div class="wg-key-item">${humidity}<div><strong>Moisture layer</strong><span>Inferred RH ≥${CLOUD_RH_THRESHOLD_PERCENT}%</span></div></div>` +
      `<div class="wg-key-item">${freezing}<div><strong>${escape(formatQuantity(0, 'temperature', undefined, system))} freezing</strong><span>Cyan isotherm &amp; freeze mark</span></div></div>` +
      `<div class="wg-key-item">${missing}<div><strong>Missing data</strong><span>Unavailable hours or heights</span></div></div>` +
      `</div>` +
      `<details class="wg-key-more"><summary>More chart details</summary>` +
      `<p class="wg-key-foot">Faint barbs are interpolated between native model levels. Dashed amber marks native parcel top; dashed teal marks effective cloud limit; dashed gray marks fine terrain.${usesDsm ? ' The digital surface model (DSM) includes vegetation and buildings.' : ''}</p>` +
      `</details>` +
      `</div>`
    );
  }

  const greenLimit = formatQuantity(knotsToMps(WIND_SPEED_KNOT_THRESHOLDS.greenMaxKt), 'wind', undefined, system);
  const yellowLimit = formatQuantity(knotsToMps(WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt), 'wind', 0, system);
  const redLimit = formatQuantity(knotsToMps(WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt), 'wind', 0, system);
  const pennantLimit = formatQuantity(knotsToMps(WIND_SPEED_KNOT_THRESHOLDS.redMaxKt), 'wind', 0, system);
  const liftUnit = unitLabel('lift', system);
  const sinkLabel = formatQuantity(SINK_RATE_MPS, 'lift', system === 'metric' ? 1 : 0, system);
  const climbCells = WINDGRAM_CLIMB_BANDS.map(({ className, label }, i) => {
    const range = climbBandRange(i, system);
    const shortName = CLIMB_SHORT_LABELS[i] ?? label;
    return (
      `<div class="wg-key-band" role="listitem" tabindex="0" aria-label="${escape(`${label}: ${range} ${liftUnit}`)}">` +
      `<span class="wg-key-band-lbl">${escape(shortName)}</span>` +
      `<span class="wg-key-seg ${escape(className)}"></span>` +
      `<span class="wg-key-band-rng">${escape(range)}</span>` +
      `</div>`
    );
  }).join('');

  const lift = icon(
    '<path d="M1 12H31" stroke="#f8fafc" stroke-width="3.6" stroke-linecap="round"/>' +
    '<path d="M1 12H31" stroke="#0f3a6d" stroke-width="1.9" stroke-linecap="round"/>' +
    '<circle cx="9" cy="12" r="3" fill="#0284c7" stroke="#fff" stroke-width="1.3"/>' +
    '<circle cx="23" cy="12" r="3" fill="#0284c7" stroke="#fff" stroke-width="1.3"/>',
  );
  const nativeLift = icon(
    '<path d="M1 12H31" stroke="#7dd3fc" stroke-width="1.8" stroke-dasharray="5 3" stroke-linecap="round"/>' +
    '<circle cx="16" cy="12" r="2.8" fill="#0f172a" stroke="#7dd3fc" stroke-width="1.4"/>',
  );
  const cumulus = icon(
    `<path d="${CLOUD_PATH}" transform="translate(9.5 16.5) scale(.38)" fill="#f8fafc" stroke="#475569" stroke-width="1.6"/>` +
    '<line x1="2.5" x2="17" y1="16.2" y2="16.2" stroke="#64748b" stroke-width="1.5" stroke-linecap="round"/>' +
    `<path d="${CLOUD_PATH}" transform="translate(22.5 16.5) scale(.38)" fill="#64748b" stroke="#0f172a" stroke-width="1.9"/>` +
    '<line x1="14" x2="31" y1="16.2" y2="16.2" stroke="#0f172a" stroke-width="1.8" stroke-linecap="round"/>',
  );
  const cloudDeck = icon(
    `<rect x="2" y="2" width="28" height="18" rx="3" fill="${WINDGRAM_HYBRID_SKY_COLOR}"/>` +
    '<rect x="2" y="2" width="28" height="3.8" rx="1.2" fill="#94a3b8" fill-opacity=".85"/>' +
    '<rect x="4" y="8.2" width="8" height="2" rx="1" fill="#e2e8f0" fill-opacity=".52"/>' +
    '<rect x="16" y="8.2" width="10" height="2" rx="1" fill="#e2e8f0" fill-opacity=".52"/>' +
    '<path d="M2 15C8 13.5 15 13 30 14.2L30 20L2 20Z" fill="#f8fafc" fill-opacity=".68"/>',
  );
  const ascentIcon = icon(
    `<rect x="2" y="2" width="28" height="18" rx="3" fill="${WINDGRAM_HYBRID_SKY_COLOR}"/>` +
    `<rect x="2" y="12" width="28" height="6" fill="${WINDGRAM_INVERSION_BANDS[1].color}" fill-opacity=".75"/>` +
    '<ellipse cx="16" cy="6.5" rx="10" ry="3.2" fill="#38bdf8" fill-opacity=".42" stroke="none"/>',
  );

  return (
    `<div class="windgram-legend">` +
    `<div class="wg-key-head"><strong>Visual Chart Key</strong><span>Net climb · ${escape(liftUnit)} (includes ${escape(sinkLabel)} sink)</span></div>` +
    `<div class="wg-key-spectrum">` +
    `<div class="wg-key-bands wg-key-bands-6" role="list" aria-label="Net thermal climb bands">${climbCells}</div>` +
    `<div class="wg-key-backdrops">` +
    `<span class="wg-key-chip"><i class="wg-key-sky-swatch"></i>Neutral sky</span>` +
    `<span class="wg-key-chip"><i class="wg-key-inv-swatch"></i>Inversion lid (dT/dz &gt; 0)</span>` +
    `</div>` +
    `</div>` +
    `<div class="wg-key-wind-box">` +
    `<div class="wg-key-wind-copy"><strong>Wind · ${feathers} (15 = 10 + 5 kt)</strong><span>Green wind is below ${escape(greenLimit)} · yellow ≥${escape(yellowLimit)} · red ≥${escape(redLimit)} · magenta ≥${escape(pennantLimit)}. Barb points to wind source; hover arrow points downwind.</span></div>` +
    windStrip +
    `</div>` +
    `<div class="wg-key-grid">` +
    `<div class="wg-key-item">${lift}<div><strong>Map usable lift</strong><span>Magnetic Top-of-Lift curve</span></div></div>` +
    `<div class="wg-key-item">${nativeLift}<div><strong>Native lift estimate</strong><span>Dashed ceiling beyond map hours</span></div></div>` +
    `<div class="wg-key-item">${cumulus}<div><strong>Cu &amp; OD</strong><span>Cumulus base &amp; spreadout risk</span></div></div>` +
    `<div class="wg-key-item">${cloudDeck}<div><strong>Inferred moisture</strong><span>RH ${CLOUD_SCT_RH_PERCENT}–&lt;${CLOUD_BKN_RH_PERCENT}%, ${CLOUD_BKN_RH_PERCENT}–&lt;${CLOUD_RH_THRESHOLD_PERCENT}%, ≥${CLOUD_RH_THRESHOLD_PERCENT}%</span></div></div>` +
    `<div class="wg-key-item">${ascentIcon}<div><strong>Modeled ascent aloft</strong><span>Cyan ascent; indigo inversion lid</span></div></div>` +
    `<div class="wg-key-item">${freezing}<div><strong>${escape(formatQuantity(0, 'temperature', undefined, system))} freezing</strong><span>Cyan isotherm &amp; freeze mark</span></div></div>` +
    `<div class="wg-key-item">${missing}<div><strong>Missing data</strong><span>Unavailable hours or heights</span></div></div>` +
    `</div>` +
    `<details class="wg-key-more"><summary>More chart details</summary>` +
    `<p class="wg-key-foot">Dome colors show Lenschow net thermal climb (already subtracting ${escape(sinkLabel)} glider sink). Top cap strip marks model sky cover. Faint barbs are interpolated; dashed pink marks surface LCL; dashed amber marks parcel top; dashed teal marks cloud limit; dashed slate marks model ground when above site ground.${usesDsm ? ' The digital surface model (DSM) includes vegetation and buildings.' : ''}</p>` +
    `</details>` +
    `</div>`
  );
}
