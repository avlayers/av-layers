export const panelStyles = `
.av-windgram-panel{display:grid;gap:6px;min-width:0}
.av-windgram-host{min-width:0;max-height:var(--av-chart-max-height,58vh);overflow:auto}
.av-windgram-panel p{margin:0}
.av-windgram-lift-summary,.av-windgram-profile-status,.av-windgram-panel .av-point-time,.av-windgram-panel .av-point-incomplete{font-size:11px;line-height:1.4}
.av-windgram-lift-summary{font-weight:600}
.av-windgram-panel .av-point-incomplete{color:#a15c00}
.av-windgram-details{font:11px/1.5 system-ui,sans-serif}
.av-windgram-details summary{cursor:pointer;width:fit-content}
.windgram-inspection{padding:5px 0}
.windgram-inspection label{display:flex;gap:4px;align-items:center}
.windgram-readout{margin:4px 0;line-height:1.45}
.windgram-legend-ramp,.windgram-legend-symbols{display:flex;flex-wrap:wrap;gap:4px 8px;margin:5px 0}
.windgram-legend-chip,.windgram-legend-symbols>span{display:inline-flex;align-items:center;gap:.3em}
.windgram-legend-chip::before{content:'';width:.85em;height:.85em;border:1px solid #51486e;background:var(--chip)}
`;
