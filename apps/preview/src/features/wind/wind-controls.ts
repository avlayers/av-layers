import './wind-controls.css';
import {
  parseWindPreferences, serializeWindPreferences, snapWindHeight as storedStop,
  WIND_STATUS_LABELS as STATUS_LABELS, WIND_STORAGE_KEY as STORAGE_KEY, WIND_STOPS as STOPS,
  WIND_STYLE_LABELS as STYLE_LABELS, WIND_STYLES as STYLES, windStopLabel as stopLabel, windStopValue as stopValue,
  type StoredWindPreferences, type WindControlState, type WindHeight, type WindStatus, type WindStyle, type WindUnits
} from './wind-model';

export type { WindControlState, WindHeight, WindStatus, WindStyle, WindUnits } from './wind-model';

export interface WindControlsOptions {
  onChange(state: WindControlState): void;
  onCommit?(): void;
  initial?: Partial<Pick<WindControlState, 'style' | 'visible' | 'height'>>;
}

export interface WindControls {
  readonly state: WindControlState;
  setStatus(status: WindStatus): void;
  setQuality?(overview: boolean): void;
  setState?(next: Partial<Pick<WindControlState, 'style' | 'visible' | 'height'>>): void;
  setUnits(units: WindUnits): void;
  destroy(): void;
}

const svg = (w: number, h: number, vw: number, vh: number, attrs: string, body: string) =>
  `<svg viewBox="0 0 ${vw} ${vh}" width="${w}" height="${h}" ${attrs}>${body}</svg>`;
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"';
const eyeBase = '<path d="M1.5 6s2.6-4.2 6.5-4.2S14.5 6 14.5 6s-2.6 4.2-6.5 4.2S1.5 6 1.5 6Z"/><circle cx="8" cy="6" r="1.8"/>';
const ICONS = {
  trails: svg(18, 15, 20, 16, stroke, '<path d="M2 4.2c3-2.4 5.5 2.4 8.8 0s4.8-1.8 7.2.4M2 8.2c3-2.4 5.5 2.4 8.8 0s4.8-1.8 7.2.4M2 12.2c3-2.4 5.5 2.4 8.8 0s4.8-1.8 7.2.4"/>'),
  barbs: svg(18, 15, 20, 16, stroke, '<circle cx="4.5" cy="13" r="1.4"/><path d="M5.5 11.8 14.8 2.5m0 0 3.2 2.6m-5.8 0 2.6 2.1"/>'),
  hybrid: svg(18, 15, 20, 16, stroke, '<path d="M1.8 5c2.8-2.2 5.2 2.2 8.2 0s4.4-1.6 6.5.3M1.8 10.2c2.4-1.8 4.4 1.6 7 0"/><path d="M11.2 13.8 17 5.6m0 0 2.2 2"/>'),
  tol: svg(11, 11, 16, 16, stroke, '<path d="M8 13.5V3.5m0 0-3 3m3-3 3 3M3 2h10"/>'),
  sfc: svg(12, 11, 16, 15, stroke, '<path d="M2 6.5c2.2-1.8 4.2 1.8 6.4 0s3.4-1.4 5.6.3"/><path d="M1.5 11h13M4.5 11l-1.5 2.4M8.8 11l-1.5 2.4M13.1 11l-1.5 2.4"/>'),
  eye: svg(14, 11, 16, 12, 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"', eyeBase),
  'eye-off': svg(14, 11, 16, 12, 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"', `${eyeBase}<path d="m2 1.2 12 9.6"/>`),
  pause: svg(9, 11, 10, 12, 'fill="currentColor"', '<rect x="1" y="1" width="3" height="10" rx="0.8"/><rect x="6" y="1" width="3" height="10" rx="0.8"/>'),
  play: svg(9, 11, 10, 12, 'fill="currentColor"', '<path d="M1.5 1.2v9.6L9.2 6z"/>')
} as const;
type IconName = keyof typeof ICONS;

const STYLE_SHORT_NAMES: Record<WindStyle, string> = {
  trails: 'Flow',
  barbs: 'Barbs',
  hybrid: 'Mix'
};

const attr = (n: Element, map: Record<string, string | boolean>) => { for (const [k, v] of Object.entries(map)) n.setAttribute(k, String(v)); };

function readStored(): StoredWindPreferences | null {
  try { return parseWindPreferences(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null); } catch { return null; }
}

const persist = (s: WindControlState, fixedHeight: number) => {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, serializeWindPreferences(s, fixedHeight)); } catch { /* ignore */ }
};

function compactTickValue(v: number): string {
  return v >= 1000 ? `${Number((v / 1000).toFixed(1))}k` : String(v);
}

function compactHeightBadge(height: WindHeight, fixedHeight: number, units: WindUnits): string {
  if (height === 'surface') return 'SFC';
  if (height === 'lift') return 'TOL';
  return compactTickValue(stopValue(fixedHeight, units));
}

export function createWindControls(parent: HTMLElement, options: WindControlsOptions): WindControls {
  const doc = parent.ownerDocument, stored = readStored(), init = options.initial;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n;
  };
  const btn = (cls: string, text?: string) => { const b = el('button', cls, text); b.type = 'button'; return b; };
  const icon = (name: IconName, cls: string) => { const s = el('span', cls); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name]; return s; };

  let state: WindControlState = {
    style: init?.style ?? stored?.style ?? 'trails',
    visible: init?.visible ?? stored?.visible ?? true,
    paused: false,
    height: init?.height ?? stored?.height ?? 'surface'
  };
  let fixedHeight = typeof state.height === 'number' ? state.height : stored?.fixedHeight ?? STOPS[0];
  let units: WindUnits = 'metric', status: WindStatus = 'ready', overview = false, destroyed = false;
  let delivered = state, committed = state, committedFixedHeight = fixedHeight, changeRequest: number | null = null;
  let pendingCommit = false;

  const root = el('div', 'wind-controls'), menu = el('div', 'wind-controls-menu'), trigger = btn('wind-controls-trigger');
  attr(trigger, { 'aria-haspopup': 'dialog', 'aria-controls': 'wind-controls-popup' });
  const triggerGlyph = el('span', 'wind-controls-trigger-glyph');
  const triggerMeta = el('span', 'wind-controls-trigger-meta');
  triggerMeta.setAttribute('aria-hidden', 'true');
  const triggerState = el('span', 'wind-controls-trigger-state');
  trigger.append(triggerGlyph, triggerMeta, triggerState);

  const popup = el('div', 'wind-controls-popup');
  popup.hidden = true; popup.id = 'wind-controls-popup'; attr(popup, { role: 'dialog', 'aria-label': 'Wind display' });

  const popupHead = el('div', 'wind-controls-head');
  popupHead.setAttribute('aria-hidden', 'true');
  const popupTitle = el('span', 'wind-controls-head-title', 'Wind');
  const popupLevel = el('span', 'wind-controls-head-level');
  popupHead.append(popupTitle, popupLevel);

  const styleGroup = el('div', 'wind-controls-styles');
  attr(styleGroup, { role: 'radiogroup', 'aria-label': 'Wind style' });
  const styleButtons = new Map<WindStyle, HTMLButtonElement>();
  for (const style of STYLES) {
    const choice = btn('wind-controls-style');
    attr(choice, { role: 'radio', 'aria-label': STYLE_LABELS[style] });
    const caption = el('span', 'wind-controls-style-caption', STYLE_SHORT_NAMES[style]);
    caption.setAttribute('aria-hidden', 'true');
    choice.append(icon(style, 'wind-controls-style-icon'), caption);
    choice.addEventListener('click', () => { selectStyle(style); closeMenu(true); });
    styleButtons.set(style, choice); styleGroup.append(choice);
  }

  const actionGroup = el('div', 'wind-controls-actions');
  attr(actionGroup, { role: 'group', 'aria-label': 'Wind actions' });
  const visibility = btn('wind-controls-action'), visibilityIcon = el('span', 'wind-controls-action-icon'), visibilityLabel = el('span', 'wind-controls-action-label');
  visibility.append(visibilityIcon, visibilityLabel);
  const pause = btn('wind-controls-action'), pauseIcon = el('span', 'wind-controls-action-icon'), pauseLabel = el('span', 'wind-controls-action-label');
  pause.append(pauseIcon, pauseLabel);
  actionGroup.append(visibility, pause);
  popup.append(popupHead, styleGroup, actionGroup);
  menu.append(trigger, popup);

  const statusLine = el('p', 'wind-controls-status');
  attr(statusLine, { role: 'status', 'aria-live': 'polite' }); statusLine.hidden = true;

  const rail = el('div', 'wind-controls-rail'), lift = btn('wind-controls-lift');
  const liftSr = el('span', 'sr-only', 'Top of lift');
  const liftRow = el('span', 'wind-controls-lift-row');
  liftRow.setAttribute('aria-hidden', 'true');
  liftRow.append(icon('tol', 'wind-controls-lift-icon'), el('span', 'wind-controls-lift-title', 'TOL'));
  const liftAuto = el('span', 'wind-controls-lift-auto', 'auto');
  liftAuto.setAttribute('aria-hidden', 'true');
  lift.append(liftSr, liftRow, liftAuto);

  const scale = el('div', 'wind-controls-scale'), unitLine = el('span', 'wind-controls-unit'), axis = el('div', 'wind-controls-axis');
  const track = el('span', 'wind-controls-track');
  track.setAttribute('aria-hidden', 'true');
  const trackFill = el('span', 'wind-controls-track-fill');
  track.append(trackFill);
  axis.append(track);

  const ticks = STOPS.map((height, index) => {
    const tick = el('span', 'wind-controls-tick');
    tick.setAttribute('aria-hidden', 'true');
    tick.style.setProperty('--wind-controls-position', String(index / (STOPS.length - 1)));
    axis.append(tick);
    return { tick, height, labelled: [0, 2, 5, 9].includes(index) };
  });
  const range = Object.assign(el('input', 'wind-controls-range'), { type: 'range', min: '0', max: String(STOPS.length - 1), step: '1', value: String(STOPS.indexOf(fixedHeight)) });
  range.setAttribute('aria-label', 'Wind height');
  const readout = el('output', 'wind-controls-value');

  const surface = btn('wind-controls-surface');
  const surfaceSr = el('span', 'sr-only', 'Surface');
  const surfaceRow = el('span', 'wind-controls-surface-row');
  surfaceRow.setAttribute('aria-hidden', 'true');
  surfaceRow.append(icon('sfc', 'wind-controls-surface-icon'), el('span', 'wind-controls-surface-title', 'SFC'));
  surface.append(surfaceSr, surfaceRow);

  axis.append(range, readout); scale.append(unitLine, axis); rail.append(lift, scale, surface);
  root.append(menu, statusLine, rail); parent.appendChild(root);

  const snapshot = (): WindControlState => Object.freeze({ ...state });
  const sameState = (a: WindControlState, b: WindControlState) => a.height === b.height && a.style === b.style && a.visible === b.visible && a.paused === b.paused;
  const cancelChange = (): void => {
    if (changeRequest !== null) doc.defaultView?.cancelAnimationFrame(changeRequest);
    changeRequest = null;
  };
  const notify = (commit: boolean): void => {
    if (destroyed) return;
    cancelChange();
    if (!sameState(state, delivered)) { delivered = state; pendingCommit = true; options.onChange(snapshot()); }
    if (destroyed) return;
    const changed = !sameState(state, committed);
    if (commit && (changed || pendingCommit || fixedHeight !== committedFixedHeight)) {
      const publish = changed || pendingCommit;
      committed = state; committedFixedHeight = fixedHeight; pendingCommit = false; persist(state, fixedHeight);
      if (publish) options.onCommit?.();
    }
  };
  const queueChange = (): void => {
    if (changeRequest !== null) return;
    const view = doc.defaultView;
    if (!view?.requestAnimationFrame || !view.cancelAnimationFrame) { notify(false); return; }
    changeRequest = view.requestAnimationFrame(() => { changeRequest = null; notify(false); });
  };

  function renderStatus(): void {
    attr(root, { 'data-status': status, 'data-quality': overview ? 'overview' : 'detail' });
    trigger.setAttribute('aria-busy', String(state.visible && status === 'loading'));
    const text = status !== 'ready' ? STATUS_LABELS[status] : '';
    statusLine.textContent = text; statusLine.hidden = !state.visible || !text;
  }

  function renderHeight(): void {
    const numeric = typeof state.height === 'number', index = STOPS.indexOf(fixedHeight), unit = units === 'imperial' ? 'ft AGL' : 'm AGL';
    const shown = state.height === 'lift' ? STOPS.length - 1 : state.height === 'surface' ? 0 : index;
    const normPos = String(shown / (STOPS.length - 1));
    const fixedPos = String(index / (STOPS.length - 1));
    const valueText = numeric ? `${stopLabel(fixedHeight, units)} ${unit}` : state.height === 'lift' ? 'Top of lift' : 'Surface';
    range.value = String(shown);
    range.setAttribute('aria-valuetext', valueText);
    unitLine.textContent = unit;
    for (const { tick, height, labelled } of ticks) {
      tick.textContent = labelled ? compactTickValue(stopValue(height, units)) : '';
    }
    readout.textContent = stopLabel(fixedHeight, units);
    readout.hidden = !numeric;
    readout.style.setProperty('--wind-controls-position', fixedPos);
    trackFill.style.setProperty('--wind-controls-position', normPos);
    scale.setAttribute('data-height', numeric ? 'fixed' : String(state.height));
    triggerMeta.textContent = compactHeightBadge(state.height, fixedHeight, units);
    popupLevel.textContent = numeric ? valueText : state.height === 'lift' ? 'TOL (auto)' : 'SFC';
    for (const [b, cls, sel] of [[lift, 'wind-controls-lift', state.height === 'lift'], [surface, 'wind-controls-surface', state.height === 'surface']] as const) {
      b.setAttribute('aria-pressed', String(sel)); b.className = sel ? `${cls} is-selected` : cls;
    }
  }

  function render(): void {
    attr(root, { 'data-style': state.style, 'data-visible': state.visible, 'data-paused': state.paused });
    const pausedActive = state.visible && state.paused && state.style !== 'barbs';
    triggerGlyph.innerHTML = ICONS[state.style];
    triggerState.innerHTML = !state.visible ? ICONS['eye-off'] : pausedActive ? ICONS.pause : '';
    triggerState.hidden = !(!state.visible || pausedActive);
    attr(trigger, { 'aria-label': `Wind controls, ${STYLE_LABELS[state.style]}, ${!state.visible ? 'off' : pausedActive ? 'paused' : 'visible'}`, 'aria-expanded': !popup.hidden });
    for (const style of STYLES) {
      const choice = styleButtons.get(style)!, selected = style === state.style;
      choice.className = selected ? 'wind-controls-style is-selected' : 'wind-controls-style';
      choice.setAttribute('aria-checked', String(selected)); choice.tabIndex = selected ? 0 : -1;
    }
    visibilityIcon.innerHTML = state.visible ? ICONS.eye : ICONS['eye-off'];
    visibilityLabel.textContent = state.visible ? 'On' : 'Off';
    attr(visibility, { 'aria-label': state.visible ? 'Hide wind' : 'Show wind', 'aria-pressed': state.visible });
    pause.disabled = !(state.visible && state.style !== 'barbs');
    pauseIcon.innerHTML = state.paused ? ICONS.play : ICONS.pause;
    pauseLabel.textContent = state.paused ? 'Play' : 'Pause';
    attr(pause, { 'aria-label': state.paused ? 'Resume wind' : 'Pause wind', 'aria-pressed': state.paused });
    renderStatus(); renderHeight();
  }

  const selectStyle = (style: WindStyle) => { if (!destroyed) { state = { ...state, style, visible: true }; render(); notify(true); } };
  const selectHeight = (height: WindHeight) => { if (!destroyed && state.height !== height) { state = { ...state, height }; renderHeight(); notify(true); } };
  const setMenu = (open: boolean, focusTarget: boolean) => {
    if (destroyed || popup.hidden === !open) return;
    popup.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
    if (focusTarget) (open ? styleButtons.get(state.style) : trigger)?.focus({ preventScroll: true });
  };
  const closeMenu = (restoreFocus: boolean) => setMenu(false, restoreFocus);

  trigger.addEventListener('click', event => { const kb = 'detail' in event && event.detail === 0; setMenu(popup.hidden, kb); });
  styleGroup.addEventListener('keydown', event => {
    const k = event.key, off = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0;
    if (!off && k !== 'Home' && k !== 'End') return;
    event.preventDefault();
    const next = k === 'Home' ? 0 : k === 'End' ? STYLES.length - 1 : (STYLES.indexOf(state.style) + off + STYLES.length) % STYLES.length;
    selectStyle(STYLES[next]); styleButtons.get(STYLES[next])?.focus({ preventScroll: true });
  });
  visibility.addEventListener('click', () => { if (!destroyed) { state = { ...state, visible: !state.visible }; render(); notify(true); } });
  pause.addEventListener('click', () => { if (!destroyed && !pause.disabled) { state = { ...state, paused: !state.paused }; render(); notify(true); } });
  lift.addEventListener('click', () => selectHeight('lift'));
  surface.addEventListener('click', () => selectHeight('surface'));
  let rangeGesture: { id: number; parked: 'surface' | 'lift' | null; cancelled: boolean } | null = null;
  const parkedIndex = () => rangeGesture?.parked === 'lift' ? STOPS.length - 1 : rangeGesture?.parked === 'surface' ? 0 : -1;
  range.addEventListener('pointerdown', event => {
    if (destroyed || !event.isPrimary || event.button !== 0 || rangeGesture && !rangeGesture.cancelled) return;
    rangeGesture = { id: event.pointerId, parked: state.height === 'lift' || state.height === 'surface' ? state.height : null, cancelled: false };
  });
  range.addEventListener('input', () => {
    if (destroyed) return;
    if (rangeGesture?.cancelled) { renderHeight(); return; }
    const index = Number(range.value);
    if (!Number.isInteger(index) || index < 0 || index >= STOPS.length || index === parkedIndex() || state.height === STOPS[index]) return;
    if (rangeGesture) rangeGesture.parked = null;
    fixedHeight = STOPS[index]; state = { ...state, height: fixedHeight }; renderHeight(); queueChange();
  });
  range.addEventListener('change', () => { if (!rangeGesture?.cancelled) notify(true); });
  const onRangeEnd = (event: PointerEvent): void => {
    const gesture = rangeGesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    rangeGesture = null;
    if (destroyed || gesture.cancelled) return;
    if (event.type === 'pointerup' && gesture.parked !== null && state.height === gesture.parked) selectHeight(fixedHeight);
    else notify(true);
  };
  range.addEventListener('pointerup', onRangeEnd); range.addEventListener('pointercancel', onRangeEnd);
  doc.addEventListener('pointerup', onRangeEnd, true); doc.addEventListener('pointercancel', onRangeEnd, true);

  let focusPending = false, focusAtDismiss: Element | null = null;
  const onPointerUp = (): void => {
    if (!focusPending) return;
    focusPending = false;
    doc.removeEventListener('pointerup', onPointerUp, true); doc.removeEventListener('pointercancel', onPointerUp, true);
    if (!destroyed && (doc.activeElement === focusAtDismiss || doc.activeElement === doc.body || !doc.activeElement)) trigger.focus({ preventScroll: true });
  };
  const onOutside = (event: PointerEvent): void => {
    if (popup.hidden) return;
    const target = event.target as Element | null;
    if (target && menu.contains(target)) return;
    closeMenu(false);
    if (!target?.closest?.('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex],[contenteditable]:not([contenteditable="false"])') && !focusPending) {
      focusPending = true; focusAtDismiss = doc.activeElement;
      doc.addEventListener('pointerup', onPointerUp, true); doc.addEventListener('pointercancel', onPointerUp, true);
    }
  };
  const onKeydown = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); closeMenu(true); } };
  doc.addEventListener('pointerdown', onOutside, true); doc.addEventListener('keydown', onKeydown);
  render();

  return {
    get state() { return snapshot(); },
    setStatus(next: WindStatus) { if (!destroyed && next in STATUS_LABELS) { status = next; renderStatus(); } },
    setQuality(next: boolean) { if (!destroyed && overview !== next) { overview = next; renderStatus(); } },
    setState(next) {
      if (destroyed) return;
      cancelChange();
      if (rangeGesture) rangeGesture.cancelled = true;
      const height = next.height !== undefined ? (typeof next.height === 'number' ? storedStop(next.height) ?? fixedHeight : next.height) : state.height;
      if (typeof height === 'number') fixedHeight = height;
      state = { ...state, ...(next.style ? { style: next.style } : {}), ...(next.visible !== undefined ? { visible: next.visible } : {}), height };
      delivered = committed = state; committedFixedHeight = fixedHeight; pendingCommit = false;
      render();
    },
    setUnits(next: WindUnits) { units = next === 'imperial' ? 'imperial' : 'metric'; renderHeight(); },
    destroy() {
      if (destroyed) return;
      cancelChange();
      destroyed = true; focusPending = false; rangeGesture = null;
      doc.removeEventListener('pointerdown', onOutside, true); doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('pointercancel', onPointerUp, true); doc.removeEventListener('keydown', onKeydown);
      doc.removeEventListener('pointerup', onRangeEnd, true); doc.removeEventListener('pointercancel', onRangeEnd, true);
      root.remove();
    }
  };
}
