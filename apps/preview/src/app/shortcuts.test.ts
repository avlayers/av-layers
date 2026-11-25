import { afterEach, expect, it, vi } from 'vitest';
import { installShortcuts } from './shortcuts';
import type { PreviewCommands } from './preview-commands';
import type { PreviewStore } from '../stores/app-store';

afterEach(() => { vi.unstubAllGlobals(); });

it('opens the point forecast at the map center with F and returns focus on Escape', () => {
  class Element { isConnected = true; focus = vi.fn(); matches() { return false; } }
  const opener = new Element(), doc = Object.assign(new EventTarget(), { activeElement: opener });
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('Node', Element);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', new EventTarget());
  let open = false;
  const commands = { forecastAtCenter: vi.fn(() => { open = true; }) } as unknown as PreviewCommands;
  const controller = new AbortController();
  installShortcuts({
    root: { querySelector: () => null } as unknown as HTMLElement, signal: controller.signal,
    store: { view: { intent: { value: {} }, wind: { value: { supported: false } } } } as unknown as PreviewStore, commands,
    point: { isOpen: () => open, close: () => { open = false; }, dismiss() {} },
    stepFrame: () => false
  });
  const key = (value: string) => { const event = Object.assign(new Event('keydown', { cancelable: true }), { key: value, code: '' }); doc.dispatchEvent(event); return event; };
  expect(key('f').defaultPrevented).toBe(true);
  expect(commands.forecastAtCenter).toHaveBeenCalledOnce();
  expect(open).toBe(true);
  key('Escape');
  expect(open).toBe(false);
  expect(opener.focus).toHaveBeenCalledOnce();
  controller.abort();
});
