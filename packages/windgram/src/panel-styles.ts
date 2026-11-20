export const panelStyles = `
.av-windgram-panel{display:grid;gap:4px;min-width:0;position:relative}
.av-windgram-host{min-width:0;max-height:var(--av-chart-max-height,58vh);overflow:auto}
.av-windgram-panel p{margin:0}
.av-windgram-lift-summary,.av-windgram-profile-status,.av-windgram-panel .av-point-time,.av-windgram-panel .av-point-incomplete{font-size:11px;line-height:1.35}
.av-windgram-lift-summary{font-weight:600}
.av-windgram-panel .av-point-incomplete{color:#a15c00}
.av-windgram-bar{display:flex;align-items:center;justify-content:space-between;gap:5px;min-height:22px;min-width:0;padding-right:var(--av-bar-reserve-right,0px)}
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
@media (max-width:380px){.av-windgram-bar,.av-windgram-nav{gap:3px}.wg-scope-btn{padding:0 5px;font-size:9.5px}.wg-step-btn{width:15px}.wg-step-label{padding:0 3px;font-size:9.5px}.av-windgram-key-btn{padding:0 5px;font-size:9.5px}}
button.wg-chip.is-alt{cursor:pointer;background:#e6f0fa;border-color:#60a5fa;color:#1e3a8a;font-weight:700}
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
