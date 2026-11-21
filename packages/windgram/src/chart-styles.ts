import { WINDGRAM_CLIMB_BANDS, WINDGRAM_INVERSION_BANDS } from './windgram-atmosphere.ts';
import { windgramCalloutStyles } from './windgram-callout.ts';
import { WINDGRAM_STABILITY } from './windgram-stability.ts';

/* White/yellow chart text sits on fills ranging from bright cloud decks and golden
   climb cores to #4f5c87/#7777dd slate sky. A dark halo keeps every label legible
   across both 'hybrid-climb' and classic 'lapse' modes, while dual-halo inspector
   crosshairs stay crisp over both dark indigo inversions and white OVC decks. */
export const chartStyles = `
.windgram { display: block; width: 100%; height: auto; font-family: Arial, Helvetica, sans-serif; touch-action: none; user-select: none; -webkit-user-select: none; }
.windgram text { fill: #fff; font-size: 12px; paint-order: stroke; stroke: #1a142e; stroke-width: 3px; stroke-linejoin: round; }
.windgram .wg-axis { fill: #f5f3ff; font-size: 12px; }
.windgram .wg-axis-feet { font-size: 12px; font-weight: 650; }
.windgram .wg-axis-unit { fill: #eceaff; font-size: 11px; letter-spacing: .04em; }
.windgram .wg-grid { stroke: #f7f1ff; stroke-width: 0.6; opacity: .34; }
.windgram .wg-hourline { stroke: #fff; stroke-width: .6; opacity: .15; }
.windgram .wg-lift { fill: #ffff7c; font-size: 14px; font-weight: 700; }
.windgram .wg-hour { font-size: 12px; font-weight: 600; }
.windgram .wg-surface-temp { fill: #fff0d4; font-size: 12px; }
.windgram .wg-isotherm { fill: none; stroke: #4c3b63; stroke-width: 0.72; opacity: .68; }
.windgram.windgram-hybrid .wg-isotherm { stroke: #cbd5e1; stroke-width: 0.78; opacity: .44; }
.windgram .wg-isotherm-freezing { fill: none; stroke: #67e8f9; stroke-width: 1.45; stroke-dasharray: 6 4; opacity: .95; }
.windgram .wg-temperature { font-size: 12px; font-weight: 650; fill: #fff; }
.windgram .wg-temperature-back { fill: #4f549c; stroke: #fff; stroke-opacity: .18; stroke-width: .65; }
.windgram .wg-temperature-freezing { fill: #d4ffff; }
.windgram .wg-unavailable { fill: #fff; font-size: 11px; font-weight: 650; paint-order: stroke; stroke: #77758f; stroke-width: 3px; }
.windgram .wg-barb { fill: none; stroke: currentColor; stroke-width: 1.15; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-barb-native { opacity: 1; }
.windgram .wg-barb-interpolated { opacity: .72; }
.windgram .wg-barb-rim { fill: none; stroke: #14192d; stroke-opacity: .86; stroke-width: 2.35; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-cloud { fill: #fff; stroke: #eef0ff; stroke-width: .7; }
.windgram .wg-cloud-cu { fill: #f8fafc; fill-opacity: .95; stroke: #475569; stroke-opacity: .85; stroke-width: 1.35; }
.windgram .wg-cloud-cu-base { stroke: #64748b; stroke-width: 2.2; stroke-linecap: round; opacity: .82; }
.windgram .wg-cloud-od { fill: #64748b; fill-opacity: .96; stroke: #0f172a; stroke-opacity: .95; stroke-width: 1.65; }
.windgram .wg-cloud-od-base { stroke: #0f172a; stroke-width: 3.1; stroke-linecap: round; opacity: .96; }
.windgram .wg-cloud-potential { fill: #b4abe8; fill-opacity: .14; stroke: #fff; stroke-width: 1.35; stroke-dasharray: 3 2; }
.windgram .wg-cu-tower { fill: #f8fafc; fill-opacity: .24; stroke: #e2e8f0; stroke-opacity: .46; stroke-width: .8; stroke-dasharray: 2.5 2; }
.windgram .wg-od-tower { fill: #64748b; fill-opacity: .38; stroke: #1e293b; stroke-opacity: .56; stroke-width: .9; }
.windgram .wg-cloud-deck-sct { stroke: #cbd5e1; stroke-opacity: .24; stroke-width: .55; stroke-dasharray: 4 3; }
.windgram .wg-cloud-deck-bkn { stroke: #cbd5e1; stroke-opacity: .34; stroke-width: .65; stroke-dasharray: 6 2.5; }
.windgram .wg-cloud-deck-ovc { fill: #f8fafc; fill-opacity: .60; stroke: #94a3b8; stroke-opacity: .52; stroke-width: .85; }
.windgram .wg-sky-bkn { fill: #cbd5e1; fill-opacity: .52; }
.windgram .wg-sky-ovc { fill: #94a3b8; fill-opacity: .84; }
.windgram .wg-sky-high { fill: #cbd5e1; fill-opacity: .34; }
.windgram .wg-sky-ovc-edge { stroke: #475569; stroke-opacity: .75; stroke-width: .9; }
.windgram .wg-sky-high-edge { stroke: #e2e8f0; stroke-opacity: .62; stroke-width: .85; stroke-dasharray: 4 3; }
.windgram .wg-sky-label-back { fill: #1e293b; fill-opacity: .86; stroke: #cbd5e1; stroke-opacity: .42; stroke-width: .55; }
.windgram .wg-sky-label { fill: #f8fafc; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 7.4px; font-weight: 750; letter-spacing: .06em; stroke: none; }
.windgram .wg-inversion-weak { fill: ${WINDGRAM_INVERSION_BANDS[0].color}; fill-opacity: .56; }
.windgram .wg-inversion-strong { fill: ${WINDGRAM_INVERSION_BANDS[1].color}; fill-opacity: .74; }
.windgram .wg-wave-lift { fill: #22d3ee; fill-opacity: .19; stroke: none; }
.windgram .wg-wave-strong { fill: #38bdf8; fill-opacity: .34; stroke: none; }
.windgram .wg-tol-halo { fill: none; stroke: #f8fafc; stroke-opacity: .92; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-tol-core { fill: none; stroke: #0f3a6d; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-tol-native { fill: none; stroke: #7dd3fc; stroke-width: 1.65; stroke-dasharray: 5 3; stroke-linecap: round; opacity: .92; }
.windgram .wg-tol-native-node { fill: #0f172a; stroke: #7dd3fc; stroke-width: 1.45; }
.windgram .wg-tol-node { fill: #0284c7; stroke: #ffffff; stroke-width: 1.5; }
.windgram .wg-freezing-mark { fill: #4f549c; stroke: #80fffa; stroke-width: 1.2; }
.windgram .wg-night-seam-fill { fill: #353778; fill-opacity: .94; }
.windgram .wg-night-seam-line { stroke: #c7d2fe; stroke-width: .9; stroke-dasharray: 2 2.5; stroke-opacity: .72; }
.windgram .wg-night-seam-moon { fill: #e0e7ff; stroke: none; font-size: 6.5px; font-weight: 700; }
.windgram .wg-day-banner { cursor: pointer; }
.windgram .wg-day-banner-pill { fill: #585ac0; stroke: #a5b4fc; stroke-opacity: .65; stroke-width: .75; transition: fill .12s ease; }
.windgram .wg-day-banner:hover .wg-day-banner-pill { fill: #4346a8; stroke-opacity: .95; }
.windgram .wg-day-banner.is-selected .wg-day-banner-pill { fill: #16324f; stroke: #fde68a; stroke-opacity: .9; stroke-width: .95; }
.windgram .wg-day-banner-label { fill: #f8fafc; stroke: none; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 9.5px; font-weight: 750; letter-spacing: .01em; }
.windgram .wg-day-banner.is-selected .wg-day-banner-label, .windgram .wg-day-banner.is-best .wg-day-banner-label { fill: #fde68a; }
.windgram .wg-hour.wg-hour-stitched { font-size: 10.5px; }
.windgram .wg-lift.wg-lift-stitched { font-size: 12px; }
.windgram .wg-inspector { pointer-events: none; }
.windgram .wg-inspector text { stroke: none; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
.windgram .wg-inspector line[data-cursor-vertical-halo], .windgram .wg-inspector line[data-cursor-horizontal-halo] { stroke: #f8fafc; stroke-opacity: .72; stroke-width: 2.5; stroke-dasharray: 3 4; }
.windgram .wg-inspector line[data-cursor-vertical], .windgram .wg-inspector line[data-cursor-horizontal] { stroke: #0f172a; stroke-width: 1.1; stroke-dasharray: 3 4; }
.windgram .wg-inspector circle[data-cursor-point-halo] { fill: none; stroke: #f8fafc; stroke-opacity: .85; stroke-width: 3.4; }
.windgram .wg-inspector circle[data-cursor-point] { fill: none; stroke: #0f172a; stroke-width: 1.85; }
.windgram .wg-inspector circle[data-cursor-tol-ring] { fill: #38bdf826; stroke: #38bdf8; stroke-width: 1.6; stroke-dasharray: 2.5 2; }
${windgramCalloutStyles}
${WINDGRAM_CLIMB_BANDS.map(({ className, color }) => `.windgram .${className} { fill: ${color}; }`).join('\n')}
${WINDGRAM_STABILITY.map(({ className, color }) => `.windgram .meteo-gram-stab-${className} { fill: ${color}; }`).join('\n')}
`;
