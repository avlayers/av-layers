import { afterEach, expect, it, vi } from 'vitest';
import { installShortcuts } from './shortcuts';
import type { PreviewCommands } from './preview-commands';
import type { PreviewStore } from '../stores/app-store';

afterEach(() => { vi.unstubAllGlobals(); });

it('opens the point forecast at the map center with F or the button, and Escape on the card returns focus', () => {
  class Element extends EventTarget {
    id = ''; isConnected = true; focus = vi.fn(); children: Element[] = [];
    matches() { return false; }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  }
  const opener = new Element(), body = new Element(), control = new Element(), button = Object.assign(new Element(), { id: 'forecast-here' });
  body.children.push(control);
  const doc = Object.assign(new EventTarget(), { activeElement: opener as Element });
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('Node', Element);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', new EventTarget());
  let open = false;
  const commands = { forecastAtCenter: vi.fn(() => { open = true; doc.activeElement = body; }) } as unknown as PreviewCommands;
  const controller = new AbortController();
  const root = Object.assign(new EventTarget(), { querySelector: (selector: string) => selector === '#point-body' ? body : null });
  installShortcuts({
    root: root as unknown as HTMLElement, signal: controller.signal,
    store: { view: { intent: { value: {} }, wind: { value: { supported: false } } } } as unknown as PreviewStore, commands,
    point: { isOpen: () => open, close: () => { open = false; }, dismiss() {} },
    stepFrame: () => false
  });
  const key = (value: string, target: unknown = doc.activeElement, repeat = false) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: value, code: '', repeat });
    Object.defineProperty(event, 'target', { value: target });
    doc.dispatchEvent(event);
    return event;
  };
  expect(key('f').defaultPrevented).toBe(true);
  key('f', body, true);
  expect(commands.forecastAtCenter).toHaveBeenCalledOnce();
  expect(open).toBe(true);
  key('Escape', control);
  expect(open).toBe(true);
  key('Escape', body);
  expect(open).toBe(false);
  expect(opener.focus).toHaveBeenCalledOnce();

  const click = new Event('click');
  Object.defineProperty(click, 'target', { value: button });
  doc.dispatchEvent(click);
  commands.forecastAtCenter(); key('Escape', body);
  expect(button.focus).toHaveBeenCalledOnce();
  controller.abort();
});
