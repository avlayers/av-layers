import { WINDGRAM_STABILITY } from './windgram-stability.ts';

/* White/yellow chart text sits on stability fills from #ffeeee (1.1:1 on its own)
   to #7777dd (3.8:1). A dark halo keeps every label legible without recolouring
   the data fills: white on #1a142e is 17.7:1, and #1a142e against the worst fill
   (#7777dd) is 4.6:1. */
export const chartStyles = `
.windgram { display: block; width: 100%; height: auto; font-family: Arial, Helvetica, sans-serif; touch-action: none; user-select: none; -webkit-user-select: none; }
.windgram text { fill: #fff; font-size: 12px; paint-order: stroke; stroke: #1a142e; stroke-width: 3px; stroke-linejoin: round; }
.windgram .wg-axis { fill: #f5f3ff; font-size: 12px; }
.windgram .wg-axis-feet { font-size: 12px; font-weight: 650; }
.windgram .wg-axis-unit { fill: #eceaff; font-size: 11px; letter-spacing: .04em; }
.windgram .wg-grid { stroke: #f7f1ff; stroke-width: 0.6; opacity: .4; }
.windgram .wg-hourline { stroke: #fff; stroke-width: .6; opacity: .16; }
.windgram .wg-lift { fill: #ffff7c; font-size: 14px; font-weight: 700; }
.windgram .wg-hour { font-size: 12px; font-weight: 600; }
.windgram .wg-surface-temp { fill: #fff0d4; font-size: 12px; }
.windgram .wg-isotherm { fill: none; stroke: #6b5481; stroke-width: 0.7; opacity: .7; }
.windgram .wg-isotherm-freezing { fill: none; stroke: #44f3ef; stroke-width: 1.25; stroke-dasharray: 6 4; }
.windgram .wg-temperature { font-size: 12px; font-weight: 650; fill: #fff; }
.windgram .wg-temperature-back { fill: #6968bf; stroke: #fff; stroke-opacity: .12; stroke-width: .6; }
.windgram .wg-temperature-freezing { fill: #d4ffff; }
.windgram .wg-unavailable { fill: #fff; font-size: 11px; font-weight: 650; paint-order: stroke; stroke: #77758f; stroke-width: 3px; }
.windgram .wg-barb { fill: none; stroke: currentColor; stroke-width: 1.1; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-barb-native { opacity: 1; }
.windgram .wg-barb-interpolated { opacity: .72; }
.windgram .wg-barb-rim { fill: none; stroke: #51486e; stroke-opacity: .65; stroke-width: 2.1; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-cloud { fill: #fff; stroke: #eef0ff; stroke-width: .7; }
.windgram .wg-cloud-potential { fill: #b4abe8; fill-opacity: .14; stroke: #fff; stroke-width: 1.4; stroke-dasharray: 3 2; }
.windgram .wg-freezing-mark { fill: #7274bc; stroke: #80fffa; stroke-width: 1.2; }
.windgram .wg-tol-node { fill: #2563eb; stroke: #ffffff; stroke-width: 1.4; }
.windgram .wg-inspector { pointer-events: none; }
.windgram .wg-inspector text { stroke: none; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
.windgram .wg-inspector line { stroke: #14223f; stroke-width: 1; stroke-dasharray: 3 4; }
.windgram .wg-inspector circle[data-cursor-point] { fill: none; stroke: #17253e; stroke-width: 2; }
.windgram .wg-inspector circle[data-cursor-tol-ring] { fill: #38bdf826; stroke: #38bdf8; stroke-width: 1.6; stroke-dasharray: 2.5 2; }
.windgram .wg-inspector-back { fill: #122033; fill-opacity: .95; stroke: #ffffff; stroke-opacity: .55; stroke-width: .75; }
.windgram .wg-inspector-badge { fill: #fbbf24; font-size: 9px; font-weight: 750; letter-spacing: .04em; }
.windgram .wg-inspector-badge.is-free { fill: #93c5fd; font-weight: 700; }
.windgram .wg-inspector-agl { fill: #fff; font-size: 12px; font-weight: 750; }
.windgram .wg-inspector-msl { fill: #94a3b8; font-size: 10.5px; font-weight: 600; }
.windgram .wg-inspector-meteo { fill: #e2e8f0; font-size: 10.5px; font-weight: 600; }
.windgram .wg-inspector-soar { fill: #86efac; font-size: 10.5px; font-weight: 650; }
.windgram .wg-inspector-soar.is-muted { fill: #cbd5e1; font-weight: 600; }
${WINDGRAM_STABILITY.map(({ className, color }) => `.windgram .meteo-gram-stab-${className} { fill: ${color}; }`).join('\n')}
`;
