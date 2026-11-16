import { afterEach, expect, it, vi } from 'vitest';
import {
  createCompactTimeline,
  dayHatchFractions,
  frameIndexForDayFraction,
  nearestFrameIndexForDay,
  solarRibbonStops,
  type TimelineFrame
} from './compact-timeline';

class ClassList {
  private readonly tokens = new Set<string>();
  add(...tokens: string[]): void { for (const token of tokens) this.tokens.add(token); }
  contains(token: string): boolean { return this.tokens.has(token); }
  toggle(token: string, force?: boolean): boolean {
    const next = force ?? !this.tokens.has(token);
    if (next) this.tokens.add(token);
    else this.tokens.delete(token);
    return next;
  }
}

class Element extends EventTarget {
  children: Element[] = [];
  readonly classList = new ClassList();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  parentNode: Element | null = null;
  className = '';
  textContent = '';
  type = '';
  tabIndex = -1;
  disabled = false;
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 0;
  style: Record<string, string> = {};
  offsetLeft = 0;
  offsetWidth = 36;
  getBoundingClientRect(): { left: number; width: number } {
    return { left: this.offsetLeft - (this.parentNode?.scrollLeft ?? 0), width: this.offsetWidth };
  }
  constructor(readonly tag: string) { super(); }
  get ownerDocument(): Document { return doc; }
  append(...nodes: Element[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: Element[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  removeChild(node: Element): void {
    this.children = this.children.filter(child => child !== node);
    node.parentNode = null;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  contains(node: Element): boolean { return this === node || this.children.some(child => child.contains(node)); }
  focus(): void { doc.activeElement = this; }
}

class Document extends EventTarget {
  elements: Element[] = [];
  activeElement: Element | null = null;
  visibilityState: DocumentVisibilityState = 'visible';
  createElement(tag: string): Element {
    const element = new Element(tag);
    this.elements.push(element);
    return element;
  }
}

let doc: Document;

function setup(offsetMinutes?: number, place?: { latitude: number; longitude: number }) {
  doc = new Document();
  const host = doc.createElement('div');
  const onSelect = vi.fn();
  const timeline = createCompactTimeline(host as unknown as HTMLElement, {
    onSelect,
    ...(offsetMinutes !== undefined ? { offsetMinutes } : {}),
    ...place
  });
  return { host, onSelect, timeline };
}

function all(element: Element): Element[] {
  return [element, ...element.children.flatMap(all)];
}

function byClass(root: Element, name: string): Element {
  const element = all(root).find(candidate => candidate.className.split(/\s+/).includes(name) || candidate.classList.contains(name));
  if (!element) throw new Error(`Missing .${name}`);
  return element;
}

function named(root: Element, name: string): Element[] {
  return all(root).filter(element => element.className.split(/\s+/).includes(name));
}

function click(element: Element): void {
  element.dispatchEvent(new Event('click'));
}

function key(element: Element, value: string): Event {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value });
  element.dispatchEvent(event);
  return event;
}

function pointer(element: Element, type: string, clientX: number): void {
  const event = new Event(type);
  Object.defineProperties(event, { clientX: { value: clientX }, button: { value: 0 }, pointerId: { value: 1 } });
  element.dispatchEvent(event);
}

const frames: TimelineFrame[] = [
  { id: 'a', validTime: '2026-11-13T18:00:00Z' },
  { id: 'b', validTime: '2026-11-13T21:00:00Z' },
  { id: 'c', validTime: '2026-11-14T00:00:00Z' }
];

afterEach(() => {
  vi.useRealTimers();
});

it('chooses the nearest frame on a target day and keeps ties stable', () => {
  const day: TimelineFrame[] = [
    { id: 'a', validTime: '2026-11-14T03:00:00Z' },
    { id: 'b', validTime: '2026-11-14T10:00:00Z' },
    { id: 'c', validTime: '2026-11-14T16:00:00Z' },
    { id: 'd', validTime: '2026-11-14T22:00:00Z' }
  ];
  expect(nearestFrameIndexForDay(day, [0, 1, 2, 3], 0, 12, 0)).toBe(1);
  const tied: TimelineFrame[] = [
    { id: 'a', validTime: '2026-11-14T10:00:00Z' },
    { id: 'b', validTime: '2026-11-14T14:00:00Z' }
  ];
  expect(nearestFrameIndexForDay(tied, [0, 1], 0, 12, 0)).toBe(0);
  expect(frameIndexForDayFraction(frames, [0, 1, 2], 0, 0.9)).toBe(1);
  expect(frameIndexForDayFraction(frames, [0, 1, 2], 0, 0.05)).toBe(-1);
  expect(frameIndexForDayFraction(frames, [], 0, 0.5)).toBe(-1);
  expect(frameIndexForDayFraction(frames, [0], 0, Number.NaN)).toBe(-1);
});

it('keeps each hour one hour wide and leaves wider gaps unselectable', () => {
  const hourly: TimelineFrame[] = [12, 13, 14, 15, 18, 21].map(hour => ({
    id: `h${hour}`, validTime: `2026-11-14T${String(hour).padStart(2, '0')}:00:00Z`
  }));
  const indices = hourly.map((_, index) => index);
  expect(frameIndexForDayFraction(hourly, indices, 0, (13 + 20 / 60) / 24)).toBe(1);
  expect(frameIndexForDayFraction(hourly, indices, 0, 16.5 / 24)).toBe(-1);
  expect(frameIndexForDayFraction(hourly, indices, 0, 17.75 / 24)).toBe(4);
  expect(frameIndexForDayFraction(hourly, indices, 0, 10 / 24)).toBe(0);
  expect(frameIndexForDayFraction(hourly, indices, 0, 23 / 24)).toBe(5);
  expect(dayHatchFractions(frames, [0, 1], 0)).toEqual([
    { start: 0, end: 18 / 24 },
    { start: (18 * 60 + 30) / 1440, end: (21 * 60 - 30) / 1440 },
    { start: 21 / 24, end: 1 }
  ]);
  expect(dayHatchFractions(hourly, indices, 0).map(segment => [segment.start, segment.end])).toEqual([
    [0, 12 / 24],
    [(15 * 60 + 30) / 1440, (18 * 60 - 30) / 1440],
    [(18 * 60 + 30) / 1440, (21 * 60 - 30) / 1440],
    [21 / 24, 1]
  ]);
  expect(dayHatchFractions(frames, [], 0)).toEqual([]);
  const tight: TimelineFrame[] = [
    { id: 'noon', validTime: '2026-11-14T12:00:00Z' },
    { id: 'later', validTime: '2026-11-14T13:05:00Z' }
  ];
  expect(dayHatchFractions(tight, [0, 1], 0)).toContainEqual({ start: 750 / 1440, end: 755 / 1440 });
  expect(frameIndexForDayFraction(tight, [0, 1], 0, 752 / 1440)).toBe(-1);
});

it('places a morning color stop for a map-center local day', () => {
  const offsetMinutes = -300;
  const start = Date.parse('2026-11-13T00:00:00Z') - offsetMinutes * 60_000;
  const stops = solarRibbonStops(37.54, -77.46, start, start + 86_400_000);
  expect(stops?.[0]).toMatchObject({ at: 0 });
  expect(stops?.at(-1)).toMatchObject({ at: 100 });
  expect(stops?.map(stop => stop.at)).toEqual([...(stops ?? [])].map(stop => stop.at).sort((left, right) => left - right));
  const night = stops?.[0]?.color;
  const morning = stops?.find(stop => stop.at >= 20 && stop.at <= 40 && stop.color !== night);
  expect(morning).toBeTruthy();
  const polar = solarRibbonStops(78, 15, Date.parse('2025-12-21T12:00:00Z'), Date.parse('2025-12-21T12:00:00Z') + 86_400_000);
  expect(polar?.every(stop => stop.color === polar[0]?.color)).toBe(true);
  expect(solarRibbonStops(Number.NaN, 0, start, start + 1)).toBeNull();
});

it('renders local days, the outlined day, and the local-plus-UTC clock', () => {
  const { host, timeline } = setup();
  timeline.update(frames, 'b');
  const root = host.children[0]!;
  const days = named(root, 'ct-day');
  expect(days.map(day => day.textContent)).toEqual(['Fri 13', 'Sat 14']);
  expect(days.map(day => day.classList.contains('is-selected'))).toEqual([true, false]);
  expect(days.map(day => day.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  expect(byClass(root, 'ct-time').textContent).toBe('21:00 (21:00 UTC)');
  expect(byClass(root, 'ct-track').getAttribute('aria-valuetext')).toBe('Nov 13, 21:00 (21:00 UTC)');
  expect(byClass(root, 'ct-track').getAttribute('aria-valuenow')).toBe('1');
  expect(named(root, 'ct-tick').map(tick => tick.textContent)).toEqual(['00', '03', '06', '09', '12', '15', '18', '21', '24']);
  timeline.destroy();
});

it('keeps the neutral ribbon until a map center arrives and ignores a small pan', () => {
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'b');
  const ribbon = byClass(host.children[0]!, 'ct-ribbon');
  expect(ribbon.style.background).toBe('#e7edf2');
  timeline.setMapCenter(37.54, -77.46);
  expect(ribbon.style.background).toContain('#e8893a');
  const painted = ribbon.style.background;
  timeline.setMapCenter(37.541, -77.464);
  expect(ribbon.style.background).toBe(painted);
  expect(byClass(host.children[0]!, 'ct-time').textContent).toBe('21:00 (21:00 UTC)');
  expect(onSelect).not.toHaveBeenCalled();
  timeline.destroy();
});

it('labels hours from a fixed offset and regroups without changing the selected frame', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup(-300);
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  expect(named(root, 'ct-day').map(day => day.textContent)).toEqual(['Fri 13']);
  expect(byClass(root, 'ct-time').textContent).toBe('13:00 (18:00 UTC)');
  click(byClass(root, 'ct-play'));
  timeline.setOffsetMinutes(0);
  expect(onSelect).not.toHaveBeenCalled();
  expect(named(root, 'ct-day').map(day => day.textContent)).toEqual(['Fri 13', 'Sat 14']);
  expect(byClass(root, 'ct-time').textContent).toBe('18:00 (18:00 UTC)');
  expect(byClass(root, 'ct-play').getAttribute('aria-pressed')).toBe('true');
  vi.advanceTimersByTime(700);
  expect(onSelect).toHaveBeenLastCalledWith(1, 'replace');
  timeline.destroy();
});

it('selects a day at the current hour, snaps the track, and steps across midnight', () => {
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  const days = named(root, 'ct-day');
  click(days[1]!);
  expect(onSelect).toHaveBeenLastCalledWith(2, 'push');
  expect(days[1]!.classList.contains('is-selected')).toBe(true);

  timeline.update(frames, 'a');
  const track = byClass(root, 'ct-track');
  track.offsetLeft = 0;
  track.offsetWidth = 100;
  pointer(track, 'pointerdown', 90);
  expect(onSelect).toHaveBeenLastCalledWith(1, 'none');
  pointer(track, 'pointermove', 90);
  expect(onSelect).toHaveBeenCalledTimes(2);
  pointer(track, 'pointerup', 90);
  expect(onSelect).toHaveBeenLastCalledWith(1, 'push');

  const right = key(track, 'ArrowRight');
  expect(right.defaultPrevented).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(2, 'replace');
  expect(doc.activeElement).toBe(track);
  key(track, 'Home');
  expect(onSelect).toHaveBeenLastCalledWith(0, 'replace');
  key(track, 'End');
  expect(onSelect).toHaveBeenLastCalledWith(2, 'replace');
  timeline.destroy();
});

it('hatches a gap day and the hours outside a partial day', () => {
  const { host, onSelect, timeline } = setup();
  const partial: TimelineFrame[] = [
    { id: 'early', validTime: '2026-11-13T12:00:00Z' },
    { id: 'late', validTime: '2026-11-13T18:00:00Z' },
    { id: 'after', validTime: '2026-11-15T15:00:00Z' }
  ];
  timeline.update(partial, 'late');
  const root = host.children[0]!;
  const days = named(root, 'ct-day');
  expect(days.map(day => day.textContent)).toEqual(['Fri 13', 'Sat 14', 'Sun 15']);
  expect(days[1]!.disabled).toBe(true);
  expect(days[1]!.classList.contains('is-unavailable')).toBe(true);
  expect(days[1]!.getAttribute('aria-label')).toBe('Sat 14, unavailable');
  click(days[1]!);
  expect(onSelect).not.toHaveBeenCalled();
  click(days[2]!);
  expect(onSelect).toHaveBeenLastCalledWith(2, 'push');
  expect(days[2]!.classList.contains('is-selected')).toBe(true);

  timeline.update(partial, 'late');
  const hatches = named(root, 'ct-hatch');
  expect(hatches.map(hatch => [hatch.style.left, hatch.style.width])).toEqual([
    ['0%', '50%'],
    ['52.1%', '20.8%'],
    ['75%', '25%']
  ]);
  const track = byClass(root, 'ct-track');
  track.offsetLeft = 0;
  track.offsetWidth = 240;
  pointer(track, 'pointerdown', 15 * 10);
  expect(onSelect).toHaveBeenCalledTimes(1);
  pointer(track, 'pointerup', 15 * 10);
  timeline.destroy();
});

it('plays through available frames across midnight and stops at the last', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  const play = byClass(root, 'ct-play');
  click(play);
  expect(play.getAttribute('aria-pressed')).toBe('true');
  expect(onSelect).not.toHaveBeenCalled();

  vi.advanceTimersByTime(700);
  expect(onSelect).toHaveBeenLastCalledWith(1, 'replace');
  expect(play.getAttribute('aria-pressed')).toBe('true');
  vi.advanceTimersByTime(700);
  expect(onSelect).toHaveBeenLastCalledWith(2, 'replace');
  expect(named(root, 'ct-day')[1]!.classList.contains('is-selected')).toBe(true);
  expect(play.getAttribute('aria-pressed')).toBe('false');

  vi.advanceTimersByTime(2100);
  expect(onSelect).toHaveBeenCalledTimes(2);

  click(play);
  expect(onSelect).toHaveBeenLastCalledWith(0, 'replace');
  expect(play.getAttribute('aria-pressed')).toBe('true');
  timeline.destroy();
});

it('stops playback when the document hides and cleans up on destroy', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  const play = byClass(root, 'ct-play');
  click(play);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  expect(play.getAttribute('aria-pressed')).toBe('false');
  vi.advanceTimersByTime(1400);
  expect(onSelect).not.toHaveBeenCalled();

  doc.visibilityState = 'visible';
  click(play);
  vi.advanceTimersByTime(700);
  expect(onSelect).toHaveBeenLastCalledWith(1, 'replace');
  timeline.destroy();
  vi.advanceTimersByTime(1400);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(host.children).toHaveLength(0);
  doc.dispatchEvent(new Event('visibilitychange'));
});

it('disables controls and does not start playback when disabled', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a', true);
  const root = host.children[0]!;
  const play = byClass(root, 'ct-play');
  expect(play.disabled).toBe(true);
  expect(named(root, 'ct-day').every(day => day.disabled)).toBe(true);
  expect(byClass(root, 'ct-track').getAttribute('aria-disabled')).toBe('true');
  click(play);
  pointer(byClass(root, 'ct-track'), 'pointerdown', 10);
  vi.advanceTimersByTime(1400);
  expect(onSelect).not.toHaveBeenCalled();

  timeline.update(frames, 'b', false);
  expect(play.disabled).toBe(false);
  expect(byClass(root, 'ct-track').tabIndex).toBe(0);
  timeline.destroy();
});

it('pauses playback when the user scrubs, picks a day, or uses arrow keys', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  const play = byClass(root, 'ct-play');
  const track = byClass(root, 'ct-track');
  track.offsetWidth = 100;
  click(play);
  pointer(track, 'pointerdown', 10);
  expect(play.getAttribute('aria-pressed')).toBe('false');
  const calls = onSelect.mock.calls.length;
  vi.advanceTimersByTime(2100);
  expect(onSelect.mock.calls.length).toBe(calls);

  click(play);
  key(root, 'ArrowRight');
  expect(play.getAttribute('aria-pressed')).toBe('false');
  expect(onSelect).toHaveBeenLastCalledWith(1, 'replace');
  vi.advanceTimersByTime(2100);
  expect(onSelect).toHaveBeenLastCalledWith(1, 'replace');

  click(play);
  click(named(root, 'ct-day')[1]!);
  expect(play.getAttribute('aria-pressed')).toBe('false');
  expect(onSelect).toHaveBeenLastCalledWith(2, 'push');
  timeline.destroy();
});

it('pause stops playback without selecting another frame', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  click(byClass(host.children[0]!, 'ct-play'));
  timeline.pause();
  expect(byClass(host.children[0]!, 'ct-play').getAttribute('aria-pressed')).toBe('false');
  vi.advanceTimersByTime(2100);
  expect(onSelect).not.toHaveBeenCalled();
  timeline.destroy();
});

it('does not record a scrub when the timeline is disabled before release', () => {
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  const track = byClass(host.children[0]!, 'ct-track');
  track.offsetWidth = 100;
  pointer(track, 'pointerdown', 90);
  expect(onSelect).toHaveBeenLastCalledWith(1, 'none');
  timeline.update(frames, 'b', true);
  pointer(track, 'pointerup', 90);
  expect(onSelect.mock.calls.some(call => call[1] === 'push')).toBe(false);
  timeline.destroy();
});
