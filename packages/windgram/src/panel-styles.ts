export const panelStyles = `
.av-windgram-panel{display:grid;gap:4px;min-width:0;position:relative}
.av-windgram-host{min-width:0;max-height:var(--av-chart-max-height,58vh);overflow:auto}
.av-windgram-panel p{margin:0}
.av-windgram-lift-summary,.av-windgram-profile-status,.av-windgram-panel .av-point-time,.av-windgram-panel .av-point-incomplete{font-size:11px;line-height:1.35}
.av-windgram-lift-summary{font-weight:600}
.av-windgram-panel .av-point-incomplete{color:#a15c00}
.av-windgram-bar{display:flex;align-items:center;justify-content:space-between;gap:5px;min-height:28px;min-width:0;padding-right:var(--av-bar-reserve-right,0px)}
.av-windgram-nav{display:flex;flex:1 1 auto;align-items:center;gap:5px;min-width:0;overflow-x:auto;scrollbar-width:none}
.av-windgram-nav::-webkit-scrollbar{display:none}
.wg-scope-seg{display:inline-flex;flex:none;align-items:center;height:20px;padding:1.5px;border-radius:999px;border:1px solid #cbd5e1;background:#eef3f8}
.wg-scope-seg[hidden],.wg-day-stepper[hidden],.wg-chip[hidden]{display:none!important}
.wg-scope-btn{height:15px;padding:0 7px;border:0;border-radius:999px;background:transparent;color:#475569;font:700 10px/15px ui-sans-serif,system-ui,sans-serif;cursor:pointer;white-space:nowrap;user-select:none}
.wg-scope-btn:hover:not(.is-active):not(:disabled){color:#16324f;background:#dde7f2}
.wg-scope-btn.is-active{background:#16324f;color:#fff;box-shadow:0 1px 2px rgba(15,23,42,.22)}
.wg-day-stepper{display:inline-flex;flex:none;align-items:center;height:20px;border-radius:999px;border:1px solid #d5e0ea;background:#f8fafc;overflow:hidden}
.wg-step-btn{display:grid;place-items:center;width:19px;height:100%;padding:0;border:0;background:transparent;color:#334155;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;user-select:none}
.wg-step-btn:hover:not(:disabled){background:#e6eef6;color:#16324f}
.wg-step-btn:disabled{opacity:.36;cursor:default}
.wg-step-label{padding:0 5px;color:#1e293b;font:650 10px/18px ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}
.wg-step-label.is-best{color:#16324f;font-weight:750}
.wg-chip{display:inline-flex;flex:none;align-items:center;height:20px;padding:0 6px;border-radius:999px;border:1px solid #d7e0ea;background:#f3f7fb;color:#243446;font:600 10px/18px ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap}
@media (max-width:380px){.av-windgram-bar,.av-windgram-nav{gap:3px}.wg-scope-btn{padding:0 5px;font-size:9.5px}.wg-step-btn{width:15px}.wg-step-label{padding:0 3px;font-size:9.5px}.av-windgram-key-btn{padding:0 8px;font-size:10.5px}}
button.wg-chip.is-alt{cursor:pointer;background:#e6f0fa;border-color:#60a5fa;color:#1e3a8a;font-weight:700}
button.wg-chip.is-alt:hover{background:#dbeafe}
.av-windgram-key-pop{position:static;flex:none}
.av-windgram-key-btn{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 10px;border-radius:999px;border:1px solid #cbd5e1;background:#f8fafc;color:#1e293b;font:700 11px/26px ui-sans-serif,system-ui,sans-serif;list-style:none;cursor:pointer;user-select:none}
.av-windgram-key-glyph{display:inline-flex;align-items:center}
.av-windgram-key-btn::-webkit-details-marker{display:none}
.av-windgram-key-btn:hover,.av-windgram-key-pop[open]>.av-windgram-key-btn{background:#16324f;border-color:#16324f;color:#fff}
.av-windgram-key-pop>.av-windgram-key{position:absolute;z-index:9;right:0;bottom:34px;width:min(380px,100%);max-height:calc(100% - 38px);overflow-y:auto;padding:11px 12px;border-radius:10px;border:1px solid #2b3a4e;background:#132030f7;backdrop-filter:blur(10px);box-shadow:0 10px 28px rgba(8,18,30,.45);color:#f1f5f9;font:11px/1.38 ui-sans-serif,system-ui,sans-serif}
.wg-key-head{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:7px}
.wg-key-head strong{font-size:12px;color:#fff}
.wg-key-head span{font-size:10.5px;color:#cbd5e1}
.wg-key-spectrum{margin-bottom:9px;padding-bottom:8px;border-bottom:1px solid #263649}
.wg-key-bands{display:grid;gap:4px}
.wg-key-bands-6{grid-template-columns:repeat(6,minmax(0,1fr))}
.wg-key-bands-4{grid-template-columns:repeat(4,minmax(0,1fr))}
.wg-key-band{display:flex;flex-direction:column;gap:2px;min-width:0;padding:2px;border-radius:4px}
.wg-key-band:focus-visible{outline:1.5px solid #38bdf8;outline-offset:1px}
.wg-key-band-lbl{font-size:10.5px;font-weight:650;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wg-key-seg{display:block;height:8px;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}
.wg-key-band-rng{font-size:10.5px;color:#cbd5e1;font-variant-numeric:tabular-nums;white-space:nowrap}
.wg-key-backdrops{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.wg-key-chip{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:#cbd5e1}
.wg-key-chip i{display:inline-block;width:12px;height:10px;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.24)}
.wg-key-wind-box{display:flex;flex-direction:column;gap:5px;margin-bottom:9px;padding-bottom:8px;border-bottom:1px solid #263649}
.wg-key-wind-copy{display:flex;flex-direction:column;gap:2px}
.wg-key-wind-copy strong{font-size:11px;font-weight:650;color:#f8fafc}
.wg-key-wind-copy span{font-size:10.5px;line-height:1.35;color:#cbd5e1}
.wg-key-wind-svg{display:block;max-width:100%;height:auto}
.wg-key-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 9px}
.wg-key-item{display:flex;align-items:center;gap:6px;min-width:0}
.wg-key-item svg{flex:none}
.wg-key-item div{display:flex;flex-direction:column;min-width:0;line-height:1.28}
.wg-key-item strong{font-size:11px;font-weight:650;color:#f8fafc}
.wg-key-item span{font-size:10.5px;color:#cbd5e1}
.wg-key-more{margin-top:8px;padding-top:6px;border-top:1px solid #263649}
.wg-key-more>summary{font-size:10.5px;font-weight:650;color:#93c5fd;cursor:pointer;user-select:none}
.wg-key-foot{margin-top:5px!important;font-size:10.5px;line-height:1.4;color:#cbd5e1}
#app[data-chrome="dark"] .wg-scope-seg{background:#162231;border-color:#2b3c52}
#app[data-chrome="dark"] .wg-scope-btn{color:#94a3b8}
#app[data-chrome="dark"] .wg-scope-btn:hover:not(.is-active):not(:disabled){background:#1f3044;color:#f8fafc}
#app[data-chrome="dark"] .wg-scope-btn.is-active{background:#f59e0b;color:#0f172a}
#app[data-chrome="dark"] .wg-day-stepper{background:#182636;border-color:#2b3c52}
#app[data-chrome="dark"] .wg-step-btn{color:#cbd5e1}
#app[data-chrome="dark"] .wg-step-btn:hover:not(:disabled){background:#223449;color:#fff}
#app[data-chrome="dark"] .wg-step-label{color:#e2e8f0}
#app[data-chrome="dark"] .wg-step-label.is-best{color:#fde68a}
#app[data-chrome="dark"] .wg-chip{background:#192738;border-color:#2b3c52;color:#dce6f2}
#app[data-chrome="dark"] button.wg-chip.is-alt{background:#1e3a5f;border-color:#38bdf8;color:#e0f2fe}
#app[data-chrome="dark"] .av-windgram-key-btn{background:#1a2838;border-color:#2d4057;color:#e2e8f0}
#app[data-chrome="dark"] .av-windgram-key-btn:hover,#app[data-chrome="dark"] .av-windgram-key-pop[open]>.av-windgram-key-btn{background:#f59e0b;border-color:#f59e0b;color:#0f172a}
`;
