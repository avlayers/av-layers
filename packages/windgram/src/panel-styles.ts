export const panelStyles = `
.av-windgram-panel{display:grid;gap:4px;min-width:0;position:relative}
.av-windgram-host{min-width:0;max-height:var(--av-chart-max-height,58vh);overflow:auto}
.av-windgram-panel p{margin:0}
.av-windgram-lift-summary,.av-windgram-profile-status,.av-windgram-panel .av-point-time,.av-windgram-panel .av-point-incomplete{font-size:11px;line-height:1.35}
.av-windgram-lift-summary{font-weight:600}
.av-windgram-panel .av-point-incomplete{color:#a15c00}
.av-windgram-bar{display:flex;align-items:center;justify-content:space-between;gap:5px;min-height:24px;min-width:0;padding-right:var(--av-bar-reserve-right,0px)}
.av-windgram-chips{display:flex;flex:1 1 auto;align-items:center;gap:4px;min-width:0;overflow-x:auto;scrollbar-width:none}
.av-windgram-chips::-webkit-scrollbar{display:none}
.wg-chip{display:inline-flex;flex:none;align-items:center;height:20px;padding:0 6px;border-radius:6px;border:1px solid #d7e0ea;background:#f3f7fb;color:#243446;font:600 10.5px/20px ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap}
.wg-chip.is-time{background:#16324f;border-color:#16324f;color:#fff;font-weight:700}
.wg-chip.is-tol{background:#fef3c7;border-color:#f59e0b;color:#78350f;font-weight:700}
button.wg-chip.is-alt{cursor:pointer;background:#e6f0fa;border-color:#60a5fa;color:#1e3a8a;font-weight:650}
button.wg-chip.is-alt:hover{background:#dbeafe}
.av-windgram-key-pop{position:static;flex:none}
.av-windgram-key-btn{display:inline-flex;align-items:center;gap:3px;height:20px;padding:0 7px;border-radius:999px;border:1px solid #cbd5e1;background:#f8fafc;color:#1e293b;font:700 10.5px/18px ui-sans-serif,system-ui,sans-serif;list-style:none;cursor:pointer;user-select:none}
.av-windgram-key-btn::-webkit-details-marker{display:none}
.av-windgram-key-btn:hover,.av-windgram-key-pop[open]>.av-windgram-key-btn{background:#16324f;border-color:#16324f;color:#fff}
.av-windgram-key-pop>.av-windgram-key{position:absolute;z-index:9;right:0;bottom:30px;width:min(356px,100%);padding:10px 11px;border-radius:10px;border:1px solid #2b3a4e;background:#132030f7;backdrop-filter:blur(10px);box-shadow:0 10px 28px rgba(8,18,30,.45);color:#f1f5f9;font:11px/1.35 ui-sans-serif,system-ui,sans-serif}
.wg-key-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}
.wg-key-head strong{font-size:12px;color:#fff}
.wg-key-head span{font-size:10px;color:#94a3b8}
.wg-key-spectrum{margin-bottom:9px;padding-bottom:8px;border-bottom:1px solid #263649}
.wg-key-zones{display:flex;justify-content:space-between;font-size:9.5px;font-weight:650;color:#cbd5e1;margin-bottom:3px}
.wg-key-bar{display:grid;grid-template-columns:repeat(8,1fr);height:9px;border-radius:5px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
.wg-key-seg{display:block;height:100%}
.wg-key-ticks{display:flex;justify-content:space-between;margin-top:3px;font-size:9px;color:#94a3b8;font-variant-numeric:tabular-nums}
.wg-key-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 8px}
.wg-key-item{display:flex;align-items:center;gap:6px;min-width:0}
.wg-key-item svg{flex:none}
.wg-key-item div{display:flex;flex-direction:column;min-width:0;line-height:1.2}
.wg-key-item strong{font-size:10.5px;font-weight:650;color:#f8fafc}
.wg-key-item span{font-size:9.5px;color:#94a3b8}
.wg-key-foot{margin-top:8px!important;padding-top:6px;border-top:1px solid #263649;font-size:9.5px;line-height:1.35;color:#94a3b8}
#app[data-chrome="dark"] .wg-chip{background:#192738;border-color:#2b3c52;color:#dce6f2}
#app[data-chrome="dark"] .wg-chip.is-time{background:#f59e0b;border-color:#f59e0b;color:#0f172a}
#app[data-chrome="dark"] .wg-chip.is-tol{background:#f59e0b29;border-color:#f59e0b;color:#fde68a}
#app[data-chrome="dark"] button.wg-chip.is-alt{background:#1e3a5f;border-color:#38bdf8;color:#e0f2fe}
#app[data-chrome="dark"] .av-windgram-key-btn{background:#1a2838;border-color:#2d4057;color:#e2e8f0}
#app[data-chrome="dark"] .av-windgram-key-btn:hover,#app[data-chrome="dark"] .av-windgram-key-pop[open]>.av-windgram-key-btn{background:#f59e0b;border-color:#f59e0b;color:#0f172a}
`;
