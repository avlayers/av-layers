import { stepTheme } from '../themes/registry';
import type { PreviewCommands } from './preview-commands';
import type { PreviewStore } from '../stores/app-store';

const POPOVERS = ['#theme-picker[open]', '#model-picker[open]', '#legend-key[open]', '#point-settings[open]', '.av-windgram-key-pop[open]'];

interface ShortcutOptions {
  readonly root: HTMLElement;
  readonly signal: AbortSignal;
  readonly store: PreviewStore;
  readonly commands: PreviewCommands;
  readonly point: { isOpen(): boolean; close(): void; dismiss(target: EventTarget | null): void };
  /** Steps the selected frame by ±1, or returns false when no live build is shown. */
  readonly stepFrame: (step: -1 | 1) => boolean;
}

/**
 * Keyboard shortcuts and outside-click dismissal: Escape closes popovers then the point card,
 * Space holds and P latches terrain peek, W and I toggle wind and isobars, 1 and 3 switch the
 * point view, [ and ] cycle themes, the arrow keys step frames, and F opens the point forecast at the
 * map center. Closing a point opened from the keyboard returns focus to where F was pressed.
 */
export function installShortcuts(options: ShortcutOptions): void {
  const { root, commands, point } = options;
  const intent = () => options.store.view.intent.value;
  const listen = { signal: options.signal };
  let spacePeek = false, pointOpener: HTMLElement | null = null;
  // Escape inside the card's own controls belongs to them; on the card itself (where F puts focus) it closes the card.
  const insidePointBody = (target: EventTarget | null) => {
    const body = root.querySelector('#point-body');
    return !!body && target !== body && target instanceof Node && body.contains(target);
  };
  const endSpacePeek = () => { if (spacePeek) { spacePeek = false; commands.setPeeking(false); } };

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      let closed = false;
      for (const selector of POPOVERS) {
        const open = root.querySelector<HTMLDetailsElement>(selector);
        if (open) { open.open = false; closed = true; }
      }
      if (closed) event.preventDefault();
      else if (point.isOpen() && !insidePointBody(event.target)) {
        point.close();
        event.preventDefault();
        if (pointOpener?.isConnected) pointOpener.focus();
        pointOpener = null;
      }
    }
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement | null)?.matches?.('input,select,textarea,button,summary')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat && !intent().peeking) { spacePeek = true; commands.setPeeking(true); }
      return;
    }
    const key = event.key;
    if (key === 'p' || key === 'P') { event.preventDefault(); spacePeek = false; commands.setPeeking(!intent().peeking); return; }
    if ((key === 'w' || key === 'W') && options.store.view.wind.value.supported) { event.preventDefault(); commands.toggleWeatherLayer('wind'); return; }
    if (key === 'f' || key === 'F') { event.preventDefault(); if (event.repeat) return; pointOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null; commands.forecastAtCenter(); return; }
    if (key === 'i' || key === 'I') { event.preventDefault(); commands.toggleWeatherLayer('isobars'); return; }
    if ((key === '1' || key === '3') && point.isOpen()) { event.preventDefault(); commands.setPointViewMode?.(key === '3' ? '3d' : '1d'); return; }
    if (key === '[' || key === ']') {
      event.preventDefault();
      commands.setTheme(stepTheme(intent().theme, key === ']' ? 1 : -1));
      return;
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && options.stepFrame(key === 'ArrowRight' ? 1 : -1)) event.preventDefault();
  }, listen);
  // The on-screen "Forecast at map center" button gets focus back the same way the F key does.
  document.addEventListener('click', event => {
    if (event.target instanceof HTMLElement && event.target.id === 'forecast-here') pointOpener = event.target;
  }, listen);
  document.addEventListener('keyup', event => { if (event.code === 'Space') endSpacePeek(); }, listen);
  window.addEventListener('blur', endSpacePeek, listen);
  document.addEventListener('pointerdown', event => {
    const target = event.target && typeof (event.target as Element).closest === 'function' ? event.target as Element : null;
    if (target) {
      for (const selector of POPOVERS) {
        const open = root.querySelector<HTMLDetailsElement>(selector);
        if (open && !open.contains(target)) open.open = false;
      }
    }
    point.dismiss(event.target);
  }, listen);
}
