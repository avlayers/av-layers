import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindControls, type WindControlState } from './wind-controls';

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  style = { setProperty: (name: string, value: string) => { this.styleValues.set(name, value); } };
  styleValues = new Map<string, string>();
  className = '';
  id = '';
  type = '';
  value = '';
  min = '';
  max = '';
  step = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  disabled = false;
  tabIndex = -1;
  focusOptions: FocusOptions | undefined;

  constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  appendChild(child: FakeElement): void { this.append(child); }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }

  dispatchEvent(event: Record<string, unknown>): void {
    event.target ??= this;
    for (const listener of [...(this.listeners.get(String(event.type)) ?? [])]) listener(event);
  }

  contains(target: FakeElement): boolean {
    return target === this || this.children.some(child => child.contains(target));
  }

  closest(_selector: string): FakeElement | null {
    return (this.tag === 'button' || this.tag === 'input') && !this.disabled ? this : this.parent?.closest(_selector) ?? null;
  }

  focus(options?: FocusOptions): void {
    this.focusOptions = options;
    this.ownerDocument.activeElement = this;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  defaultView?: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>;
  listeners = new Map<string, Listener[]>();
  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }
  dispatchEvent(event: Record<string, unknown>): void {
    event.target ??= this;
    for (const listener of [...(this.listeners.get(String(event.type)) ?? [])]) listener(event);
  }
}

function all(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(all)];
}

function byClass(root: FakeElement, name: string): FakeElement[] {
  return all(root).filter(node => node.className.split(' ').includes(name));
}

function one(root: FakeElement, name: string): FakeElement {
  const found = byClass(root, name)[0];
  if (!found) throw new Error(`Missing .${name}`);
  return found;
}

function fire(node: FakeElement, type: string, values: Record<string, unknown> = {}): void {
  node.dispatchEvent({ type, ...(type.startsWith('pointer') ? { pointerId: 1, button: 0, isPrimary: true } : {}), ...values });
}

let doc: FakeDocument;
let parent: FakeElement;
let storage: Map<string, string>;

function create(onChange = vi.fn<(state: WindControlState) => void>(), onCommit = vi.fn()) {
  const controls = createWindControls(parent as unknown as HTMLElement, { onChange, onCommit });
  return { controls, onChange, onCommit, root: parent.children[0]! };
}

function animationFrames() {
  const pending = new Map<number, FrameRequestCallback>();
  let next = 0;
  doc.defaultView = {
    requestAnimationFrame(callback) { pending.set(++next, callback); return next; },
    cancelAnimationFrame(id) { pending.delete(id); }
  };
  return { pending, flush() { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(16); } };
}

beforeEach(() => {
  doc = new FakeDocument();
  parent = new FakeElement('div', doc);
  storage = new Map();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wind controls', () => {
  it('keeps altitude feedback immediate and delivers only the latest changed value per animation frame', () => {
    const frames = animationFrames(), { controls, root, onChange, onCommit } = create();
    const range = one(root, 'wind-controls-range');
    for (let index = 0; index < 100; index++) { range.value = String(index % 10); fire(range, 'input'); }
    expect(controls.state.height).toBe(4000);
    expect(range.getAttribute('aria-valuetext')).toBe('4,000 m AGL');
    expect(onChange).not.toHaveBeenCalled();
    expect(frames.pending.size).toBe(1);
    frames.flush();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ height: 4000 }));
    for (let index = 0; index < 100; index++) fire(range, 'input');
    expect(frames.pending.size).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(storage.size).toBe(0);
    fire(range, 'change'); fire(range, 'pointerup');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(storage.size).toBe(1);
    controls.destroy();
  });

  it.each(['change', 'pointerup', 'pointercancel'])('flushes the final altitude once on %s before its queued animation frame', event => {
    const frames = animationFrames(), { controls, root, onChange, onCommit } = create();
    const range = one(root, 'wind-controls-range');
    fire(range, 'pointerdown');
    range.value = '6'; fire(range, 'input');
    fire(range, event);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ height: 1500 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(frames.pending.size).toBe(0);
    frames.flush(); fire(range, 'change');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    controls.destroy();
  });

  it('replaces a pending altitude with a restored selection and cancels callbacks on destruction', () => {
    const frames = animationFrames(), { controls, root, onChange } = create();
    const range = one(root, 'wind-controls-range');
    range.value = '7'; fire(range, 'input');
    controls.setState!({ height: 'surface' });
    frames.flush();
    expect(controls.state.height).toBe('surface');
    expect(onChange).not.toHaveBeenCalled();
    range.value = '6'; fire(range, 'input');
    controls.destroy(); frames.flush();
    expect(frames.pending.size).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('remembers the numeric height when an uncommitted drag returns to Surface', () => {
    const frames = animationFrames(), { controls, root, onChange, onCommit } = create();
    const range = one(root, 'wind-controls-range');
    range.value = '6'; fire(range, 'input');
    fire(one(root, 'wind-controls-surface'), 'click'); frames.flush();
    expect(controls.state.height).toBe('surface');
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(JSON.parse([...storage.values()][0])).toMatchObject({ height: 'surface', fixedHeight: 1500 });
    controls.destroy();
  });

  it('commits a delivered preview that returns to the original height', () => {
    const frames = animationFrames(), { controls, root, onChange, onCommit } = create();
    const range = one(root, 'wind-controls-range');
    range.value = '6'; fire(range, 'input'); frames.flush();
    // Other map or timeline commands may write this delivered height to the URL.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ height: 1500 }));
    fire(one(root, 'wind-controls-surface'), 'click');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ height: 'surface' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(JSON.parse([...storage.values()][0])).toMatchObject({ height: 'surface', fixedHeight: 1500 });
    controls.destroy();
  });

  it('ignores the remainder of a height gesture after a history restore', () => {
    const frames = animationFrames(), { controls, root, onChange, onCommit } = create();
    const range = one(root, 'wind-controls-range');
    fire(range, 'pointerdown'); range.value = '6'; fire(range, 'input');
    controls.setState!({ height: 'lift' });
    range.value = '7'; fire(range, 'input'); fire(range, 'change'); fire(range, 'pointerup');
    frames.flush();
    expect(controls.state.height).toBe('lift');
    expect(range.value).toBe('9');
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
    fire(range, 'pointerdown'); range.value = '3'; fire(range, 'input'); fire(range, 'pointerup');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ height: 500 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    controls.destroy();
  });

  it('commits a range release outside the control and ignores other pointer releases', () => {
    const frames = animationFrames(), { controls, root, onChange, onCommit } = create();
    const range = one(root, 'wind-controls-range');
    fire(range, 'pointerdown'); range.value = '6'; fire(range, 'input');
    fire(range, 'pointerup', { pointerId: 2 });
    expect(frames.pending.size).toBe(1);
    expect(onCommit).not.toHaveBeenCalled();
    doc.dispatchEvent({ type: 'pointerup', pointerId: 1 });
    expect(frames.pending.size).toBe(0);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ height: 1500 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    controls.destroy();
  });

  it('does not leave Surface for an unrelated pointer release', () => {
    const { controls, root, onChange, onCommit } = create();
    fire(one(root, 'wind-controls-range'), 'pointerup');
    expect(controls.state.height).toBe('surface');
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    controls.destroy();
  });

  it('does not persist or commit after onChange destroys the controls', () => {
    const onChange = vi.fn<(state: WindControlState) => void>(() => controls.destroy());
    const { controls, root, onCommit } = create(onChange);
    fire(one(root, 'wind-controls-lift'), 'click');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it('renders into the parent with the approved closed and rail structure', () => {
    const { controls, root } = create();
    expect(parent.children).toEqual([root]);
    expect(root.className).toBe('wind-controls');
    expect(controls.state).toEqual({ style: 'trails', visible: true, paused: false, height: 'surface' });

    const trigger = one(root, 'wind-controls-trigger');
    expect(trigger.getAttribute('aria-label')).toContain('White trails');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(one(root, 'wind-controls-popup').hidden).toBe(true);
    expect(one(root, 'wind-controls-lift').textContent ?? '').toBe('');
    expect(all(one(root, 'wind-controls-lift')).map(node => node.textContent).join('')).toContain('Top of lift');
    expect(one(root, 'wind-controls-surface').textContent ?? '').toBe('');
    expect(all(one(root, 'wind-controls-surface')).map(node => node.textContent).join('')).toContain('Surface');
    expect(all(one(root, 'wind-controls-surface')).map(node => node.textContent).join('')).toContain('SFC');
    const range = one(root, 'wind-controls-range') as FakeElement & { type: string };
    expect(range.type).toBe('range');
    expect([range.min, range.max, range.step, range.value]).toEqual(['0', '9', '1', '0']);
    expect(range.getAttribute('aria-label')).toBe('Wind height');
    expect(range.getAttribute('aria-valuetext')).toBe('Surface');
    controls.destroy();
  });

  it('maps equal slider steps to increasing physical heights with nonlinear tick labels', () => {
    const { controls, root, onChange } = create();
    const range = one(root, 'wind-controls-range');
    expect(byClass(root, 'wind-controls-tick').map(tick => tick.textContent).filter(Boolean)).toEqual(['20', '250', '1k', '4k']);
    const heights = [20, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000];
    for (const [index, height] of heights.entries()) {
      range.value = String(index);
      fire(range, 'input');
      expect(controls.state.height).toBe(height);
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ height }));
      expect(range.getAttribute('aria-valuetext')).toBe(`${height.toLocaleString('en-US')} m AGL`);
    }
    controls.setUnits('imperial');
    expect(controls.state.height).toBe(4000);
    expect(range.value).toBe('9');
    expect(range.getAttribute('aria-valuetext')).toBe('13,000 ft AGL');
    controls.destroy();
  });

  it.each([[600, 500], [2400, 2000], [6000, 4000]])('migrates a remembered %i m height to %i m', (before, after) => {
    storage.set('av.wind-controls.v1', JSON.stringify({ height: before, fixedHeight: before }));
    const { controls, root } = create();
    expect(controls.state.height).toBe(after);
    expect(one(root, 'wind-controls-value').textContent).toBe(after.toLocaleString('en-US'));
    controls.destroy();
  });

  it('keeps a restored numeric selection and rail readout on the same height', () => {
    storage.set('av.wind-controls.v1', JSON.stringify({ height: 100, fixedHeight: 6000 }));
    const { controls, root } = create();
    expect(controls.state.height).toBe(100);
    expect(one(root, 'wind-controls-range').value).toBe('1');
    expect(one(root, 'wind-controls-value').textContent).toBe('100');
    controls.destroy();
  });

  it('uses one roving tab stop and arrow/Home/End selection for styles', () => {
    const { controls, onChange, root } = create();
    const trigger = one(root, 'wind-controls-trigger');
    fire(trigger, 'click', { detail: 0 });
    expect(one(root, 'wind-controls-popup').hidden).toBe(false);
    const styles = byClass(root, 'wind-controls-style');
    expect(styles[0]!.focusOptions).toEqual({ preventScroll: true });
    expect(styles.map(button => button.tabIndex)).toEqual([0, -1, -1]);
    fire(one(root, 'wind-controls-styles'), 'keydown', { key: 'ArrowRight', preventDefault: vi.fn() });
    expect(controls.state).toEqual({ style: 'barbs', visible: true, paused: false, height: 'surface' });
    expect(styles.map(button => button.tabIndex)).toEqual([-1, 0, -1]);
    expect(styles[1]!.focusOptions).toEqual({ preventScroll: true });
    fire(one(root, 'wind-controls-styles'), 'keydown', { key: 'End', preventDefault: vi.fn() });
    expect(controls.state.style).toBe('hybrid');
    fire(one(root, 'wind-controls-styles'), 'keydown', { key: 'Home', preventDefault: vi.fn() });
    expect(controls.state.style).toBe('trails');
    expect(onChange).toHaveBeenCalled();
    expect(one(root, 'wind-controls-popup').hidden).toBe(false);
    controls.destroy();
  });

  it('selecting a style enables wind and closes without replacing the trigger or rail', () => {
    const { controls, onChange, root } = create();
    const trigger = one(root, 'wind-controls-trigger');
    const rail = one(root, 'wind-controls-rail');
    fire(trigger, 'click', { detail: 1 });
    fire(byClass(root, 'wind-controls-action')[0]!, 'click');
    expect(controls.state.visible).toBe(false);

    fire(byClass(root, 'wind-controls-style')[2]!, 'click', { detail: 1 });
    expect(controls.state).toEqual({ style: 'hybrid', visible: true, paused: false, height: 'surface' });
    expect(one(root, 'wind-controls-popup').hidden).toBe(true);
    expect(trigger.focusOptions).toEqual({ preventScroll: true });
    expect(one(root, 'wind-controls-trigger')).toBe(trigger);
    expect(one(root, 'wind-controls-rail')).toBe(rail);
    expect(onChange).toHaveBeenLastCalledWith(controls.state);
    controls.destroy();
  });

  it('disables pause for barbs and hidden wind, and reflects paused/off on the closed trigger', () => {
    const { controls, root } = create();
    const trigger = one(root, 'wind-controls-trigger');
    const pause = byClass(root, 'wind-controls-action')[1]!;
    fire(trigger, 'click', { detail: 1 });

    fire(byClass(root, 'wind-controls-style')[1]!, 'click', { detail: 1 });
    expect(controls.state.style).toBe('barbs');
    expect(pause.disabled).toBe(true);
    expect(trigger.getAttribute('aria-label')).toContain('XC barbs');

    fire(byClass(root, 'wind-controls-style')[0]!, 'click', { detail: 1 });
    expect(pause.disabled).toBe(false);
    fire(pause, 'click');
    expect(controls.state.paused).toBe(true);
    expect(trigger.getAttribute('aria-label')).toContain('paused');
    expect(one(root, 'wind-controls-trigger-state').hidden).toBe(false);

    fire(byClass(root, 'wind-controls-action')[0]!, 'click');
    expect(controls.state.visible).toBe(false);
    expect(pause.disabled).toBe(true);
    expect(trigger.getAttribute('aria-label')).toContain('off');
    controls.destroy();
  });

  it('parks the thumb at the selected end and returns to the fixed height', () => {
    const { controls, root } = create();
    const range = one(root, 'wind-controls-range');
    range.value = '8';
    fire(range, 'input');
    fire(range, 'change');
    expect(controls.state.height).toBe(3000);

    fire(one(root, 'wind-controls-lift'), 'click');
    expect(controls.state.height).toBe('lift');
    expect(one(root, 'wind-controls-scale').getAttribute('data-height')).toBe('lift');
    expect(range.value).toBe('9');
    expect(range.getAttribute('aria-valuetext')).toBe('Top of lift');

    fire(range, 'pointerdown');
    fire(range, 'input');
    expect(controls.state.height).toBe('lift');

    fire(range, 'pointerup');
    expect(controls.state.height).toBe(3000);
    expect(range.value).toBe('8');
    expect(range.getAttribute('aria-valuetext')).toBe('3,000 m AGL');

    fire(one(root, 'wind-controls-lift'), 'click');
    fire(range, 'pointerdown');
    range.value = '2';
    fire(range, 'input');
    expect(controls.state.height).toBe(250);
    expect(one(root, 'wind-controls-scale').getAttribute('data-height')).toBe('fixed');

    fire(one(root, 'wind-controls-surface'), 'click');
    expect(controls.state.height).toBe('surface');
    expect(one(root, 'wind-controls-scale').getAttribute('data-height')).toBe('surface');
    expect(range.value).toBe('0');
    expect(range.getAttribute('aria-valuetext')).toBe('Surface');

    fire(one(root, 'wind-controls-lift'), 'click');
    fire(range, 'pointerdown');
    fire(range, 'pointercancel');
    range.value = '9';
    fire(range, 'input');
    expect(controls.state.height).toBe(4000);
    controls.destroy();
  });

  it('returns to the remembered fixed height when its unmoved thumb is tapped', () => {
    const { controls, root } = create();
    fire(one(root, 'wind-controls-lift'), 'click');
    fire(one(root, 'wind-controls-range'), 'pointerdown');
    fire(one(root, 'wind-controls-range'), 'pointerup');
    expect(controls.state.height).toBe(20);
    controls.destroy();
  });

  it('uses logical pilot-friendly imperial AGL stops (100 / 800 / 3k / 13k) for labels and value text', () => {
    const { controls, root } = create();
    controls.setUnits('imperial');
    expect(one(root, 'wind-controls-unit').textContent).toBe('ft AGL');
    expect(byClass(root, 'wind-controls-tick').map(tick => tick.textContent).filter(Boolean)).toEqual(['100', '800', '3k', '13k']);
    expect(one(root, 'wind-controls-value').textContent).toBe('100');
    expect(one(root, 'wind-controls-range').getAttribute('aria-valuetext')).toBe('Surface');
    expect(controls.state.height).toBe('surface');
    controls.destroy();
  });

  it('shows compact ready/loading/unavailable states', () => {
    const { controls, root } = create();
    const status = one(root, 'wind-controls-status');
    expect(status.hidden).toBe(true);
    controls.setStatus('loading');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Loading wind');
    expect(one(root, 'wind-controls-trigger').getAttribute('aria-busy')).toBe('true');
    fire(byClass(root, 'wind-controls-action')[0], 'click');
    expect(status.hidden).toBe(true);
    expect(one(root, 'wind-controls-trigger').getAttribute('aria-busy')).toBe('false');
    fire(byClass(root, 'wind-controls-action')[0], 'click');
    expect(status.hidden).toBe(false);
    controls.setStatus('unavailable');
    expect(status.textContent).toBe('Wind unavailable');
    controls.setStatus('ready');
    expect(status.hidden).toBe(true);
    controls.setQuality!(true);
    expect(status.hidden).toBe(true);
    expect(status.textContent).toBe('');
    expect(root.getAttribute('data-quality')).toBe('overview');
    controls.destroy();
  });

  it('closes on Escape and outside pointerdown and restores focus without scrolling', () => {
    const { controls, root } = create();
    const trigger = one(root, 'wind-controls-trigger');
    fire(trigger, 'click', { detail: 1 });
    expect(one(root, 'wind-controls-popup').hidden).toBe(false);
    doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault: vi.fn() });
    expect(one(root, 'wind-controls-popup').hidden).toBe(true);
    expect(trigger.focusOptions).toEqual({ preventScroll: true });

    fire(trigger, 'click', { detail: 1 });
    const map = new FakeElement('canvas', doc);
    doc.activeElement = map;
    doc.dispatchEvent({ type: 'pointerdown', target: map });
    expect(one(root, 'wind-controls-popup').hidden).toBe(true);
    expect(doc.activeElement).toBe(map);
    doc.dispatchEvent({ type: 'pointerup', target: map });
    expect(doc.activeElement).toBe(trigger);
    expect(trigger.focusOptions).toEqual({ preventScroll: true });
    controls.destroy();
  });

  it('keeps focus on an intentional outside or rail control', () => {
    const { controls, root } = create();
    const trigger = one(root, 'wind-controls-trigger');
    for (const target of [new FakeElement('button', doc), one(root, 'wind-controls-surface')]) {
      fire(trigger, 'click', { detail: 0 });
      doc.dispatchEvent({ type: 'pointerdown', target });
      target.focus();
      doc.dispatchEvent({ type: 'pointerup', target });
      expect(one(root, 'wind-controls-popup').hidden).toBe(true);
      expect(doc.activeElement).toBe(target);
    }
    fire(trigger, 'click', { detail: 0 });
    const area = new FakeElement('div', doc), other = new FakeElement('button', doc);
    doc.dispatchEvent({ type: 'pointerdown', target: area });
    other.focus();
    doc.dispatchEvent({ type: 'pointerup', target: area });
    expect(doc.activeElement).toBe(other);
    controls.destroy();
  });

  it('restores validated persisted state and ignores broken storage', () => {
    const first = create();
    first.controls.setUnits('imperial');
    fire(byClass(first.root, 'wind-controls-style')[2]!, 'click', { detail: 1 });
    first.controls.setStatus('ready');
    const range = one(first.root, 'wind-controls-range');
    range.value = '9';
    fire(range, 'input');
    fire(range, 'change');
    fire(byClass(first.root, 'wind-controls-action')[0]!, 'click');
    first.controls.destroy();

    const second = create();
    expect(second.controls.state).toEqual({ style: 'hybrid', visible: false, paused: false, height: 4000 });
    second.controls.destroy();

    storage.set('av.wind-controls.v1', '{not json');
    const third = create();
    expect(third.controls.state).toEqual({ style: 'trails', visible: true, paused: false, height: 'surface' });
    third.controls.destroy();
  });

  it('removes its host and listeners on destroy', () => {
    const { controls, root } = create();
    const before = doc.listeners.get('pointerdown')?.length ?? 0;
    controls.destroy();
    expect(parent.children).toEqual([]);
    expect(doc.listeners.get('pointerdown')?.length ?? 0).toBe(before - 1);
    controls.destroy();
    expect(root.parent).toBeNull();
  });
});
