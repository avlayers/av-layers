import { afterEach, expect, it, vi } from 'vitest';
import {
  buildDayScale,
  createCompactTimeline,
  minuteToX,
  coarseSpanFractions,
  dayHatchFractions,
  frameIndexForDayFraction,
  nearestFrameIndexForDay,
  solarMinuteBounds,
  solarRibbonStops,
  type TimelineFrame
} from './timeline-controller';

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
  #text = '';
  get textContent(): string {
    return this.children.length ? this.children.map(child => child.textContent).join('') : this.#text;
  }
  set textContent(value: string) {
    this.#text = value;
    this.children = [];
  }
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

function pointer(element: Element, type: string, clientX: number, pointerId = 1): void {
  const event = new Event(type);
  Object.defineProperties(event, { clientX: { value: clientX }, button: { value: 0 }, pointerId: { value: pointerId } });
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
  expect(frameIndexForDayFraction(frames, [0, 1, 2], 0, 0.05)).toBe(2);
  expect(frameIndexForDayFraction(frames, [], 0, 0.5)).toBe(-1);
  expect(frameIndexForDayFraction(frames, [0], 0, Number.NaN)).toBe(-1);
});

it('snaps a coarse gap to the nearest frame and marks the span', () => {
  const hourly: TimelineFrame[] = [12, 13, 14, 15, 18, 21].map(hour => ({
    id: `h${hour}`, validTime: `2026-11-14T${String(hour).padStart(2, '0')}:00:00Z`
  }));
  const indices = hourly.map((_, index) => index);
  expect(frameIndexForDayFraction(hourly, indices, 0, (13 + 20 / 60) / 24)).toBe(1);
  expect(frameIndexForDayFraction(hourly, indices, 0, 16.5 / 24)).toBe(3);
  expect(frameIndexForDayFraction(hourly, indices, 0, 17.75 / 24)).toBe(4);
  expect(coarseSpanFractions(hourly, indices, 0)).toEqual([
    { start: 15 / 24, end: 18 / 24 },
    { start: 18 / 24, end: 21 / 24 }
  ]);
  expect(dayHatchFractions(hourly, indices, 0)).toEqual([
    { start: 0, end: 12 / 24 },
    { start: 21 / 24, end: 1 }
  ]);
  expect(coarseSpanFractions(frames, [0, 1], 0)).toEqual([{ start: 18 / 24, end: 21 / 24 }]);
  expect(dayHatchFractions(frames, [], 0)).toEqual([]);
});

function luminance(hex: string): number {
  const channel = (index: number) => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

it('brightens the ribbon at midday and keeps the sunrise and sunset limbs dim', () => {
  const offsetMinutes = -300;
  const start = Date.parse('2026-11-16T00:00:00Z') - offsetMinutes * 60_000;
  const stops = solarRibbonStops(38.7, -78.4, start, start + 86_400_000);
  expect(stops).toBeTruthy();
  const bright = stops!.reduce((best, stop) => luminance(stop.color) > luminance(best.color) ? stop : best);
  expect(bright.at).toBeGreaterThan(45);
  expect(bright.at).toBeLessThan(58);
  expect(bright.color).toBe('#fff7d6');
  const limb = (from: number, to: number) => Math.max(...stops!.filter(stop => stop.at >= from && stop.at <= to).map(stop => luminance(stop.color)));
  expect(limb(26, 34)).toBeLessThan(luminance(bright.color) * 0.55);
  expect(limb(68, 76)).toBeLessThan(luminance(bright.color) * 0.55);
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
  expect(ribbon.style.background).toContain('#fff7d6');
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
    ['75%', '25%']
  ]);
  expect(named(root, 'ct-coarse').map(shade => [shade.style.left, shade.style.width])).toEqual([['50%', '25%']]);
  const track = byClass(root, 'ct-track');
  track.offsetLeft = 0;
  track.offsetWidth = 240;
  pointer(track, 'pointerdown', 15 * 10);
  expect(onSelect).toHaveBeenLastCalledWith(0, 'none');
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

it('folds both nights during daylight and opens only the night that contains the selection', () => {
  const bounds = { sunrise: 7 * 60, sunset: 17 * 60 };
  const folded = buildDayScale(400, bounds, 16 * 60);
  expect(folded.linear).toBe(false);
  expect(folded.segments.filter(segment => segment.folded).map(segment => segment.kind)).toEqual(['morning', 'evening']);
  expect(folded.segments[0]!.x1 - folded.segments[0]!.x0).toBe(28);
  expect(folded.segments.at(-1)!.x1).toBe(400);
  const evening = buildDayScale(400, bounds, 19 * 60);
  expect(evening.segments.filter(segment => segment.folded).map(segment => segment.kind)).toEqual(['morning']);
  expect(evening.segments.find(segment => segment.kind === 'evening')!.x1).toBeGreaterThan(evening.segments.find(segment => segment.kind === 'day')!.x1);
  expect(buildDayScale(400, null, 16 * 60).linear).toBe(true);
  expect(buildDayScale(120, bounds, 12 * 60).linear).toBe(true);
  expect(buildDayScale(120, { sunrise: 0.4, sunset: 17 * 60 }, 12 * 60).linear).toBe(false);
  const shortMorning = buildDayScale(400, { sunrise: 0.4, sunset: 17 * 60 }, 12 * 60);
  expect(shortMorning.segments.map(segment => segment.kind)).toEqual(['day', 'evening']);
  expect(shortMorning.segments[0]!.start).toBe(0);
  expect(minuteToX(shortMorning, 0)).toBe(0);
  const shortEvening = buildDayScale(400, { sunrise: 7 * 60, sunset: 1440 - 0.4 }, 12 * 60);
  expect(shortEvening.segments.map(segment => segment.kind)).toEqual(['morning', 'day']);
  expect(shortEvening.segments.at(-1)!.end).toBe(1440);

  const offsetMinutes = -300;
  const start = Date.parse('2026-11-16T00:00:00Z') - offsetMinutes * 60_000;
  const place = solarMinuteBounds(37.54, -77.46, '2026-11-16', offsetMinutes);
  expect(place && place.sunset).toBeGreaterThan(16 * 60);
  expect(place && place.sunrise).toBeLessThan(16 * 60);
  const hourly: TimelineFrame[] = Array.from({ length: 24 }, (_, hour) => ({
    id: `h${hour}`,
    validTime: new Date(start + hour * 3_600_000).toISOString()
  }));
  const { host, onSelect, timeline } = setup(offsetMinutes, { latitude: 37.54, longitude: -77.46 });
  const root = host.children[0]!;
  const track = byClass(root, 'ct-track');
  track.offsetWidth = 480;
  timeline.update(hourly, 'h16');
  const labels = named(root, 'ct-tick').map(tick => tick.textContent);
  expect(named(root, 'ct-moon')).toHaveLength(2);
  expect(labels).not.toContain('00');
  expect(labels).not.toContain('03');
  expect(labels).not.toContain('21');
  expect(labels).toContain('12');
  expect(labels.every(label => Number(label) * 60 >= place!.sunrise && Number(label) * 60 <= place!.sunset)).toBe(true);

  timeline.update(hourly, 'h21');
  expect(named(root, 'ct-moon')).toHaveLength(1);
  expect(named(root, 'ct-tick').map(tick => tick.textContent)).not.toContain('21');

  timeline.update(hourly, 'h16');
  pointer(track, 'pointerdown', 10);
  const selected = onSelect.mock.calls.at(-1)?.[0] as number;
  const chosen = new Date(Date.parse(hourly[selected]!.validTime) + offsetMinutes * 60_000);
  expect(chosen.getUTCHours() * 60 + chosen.getUTCMinutes()).toBeLessThan(place!.sunrise);
  pointer(track, 'pointermove', 10);
  expect(onSelect.mock.calls.at(-1)?.[0]).toBe(selected);
  pointer(track, 'pointerup', 10);
  timeline.destroy();
});

it('keeps the folded scale steady while a drag crosses into the night', () => {
  const offsetMinutes = -300;
  const start = Date.parse('2026-11-16T00:00:00Z') - offsetMinutes * 60_000;
  const place = solarMinuteBounds(37.54, -77.46, '2026-11-16', offsetMinutes);
  const hourly: TimelineFrame[] = Array.from({ length: 24 }, (_, hour) => ({
    id: `h${hour}`,
    validTime: new Date(start + hour * 3_600_000).toISOString()
  }));
  const { host, timeline } = setup(offsetMinutes, { latitude: 37.54, longitude: -77.46 });
  const root = host.children[0]!;
  const track = byClass(root, 'ct-track');
  track.offsetWidth = 480;
  timeline.update(hourly, 'h16');
  const scale = buildDayScale(480, place, 16 * 60);
  const evening = scale.segments.find(segment => segment.kind === 'evening')!;
  const nightX = (evening.x0 + evening.x1) / 2;
  pointer(track, 'pointerdown', minuteToX(scale, 16 * 60));
  expect(named(root, 'ct-moon')).toHaveLength(2);
  pointer(track, 'pointermove', nightX);
  expect(named(root, 'ct-moon')).toHaveLength(2);
  pointer(track, 'pointerup', nightX);
  expect(named(root, 'ct-moon')).toHaveLength(1);
  timeline.destroy();
});

it('keeps the folded scale when the app echoes the scrubbed frame', () => {
  const offsetMinutes = -300;
  const start = Date.parse('2026-11-16T00:00:00Z') - offsetMinutes * 60_000;
  const place = solarMinuteBounds(37.54, -77.46, '2026-11-16', offsetMinutes);
  const hourly: TimelineFrame[] = Array.from({ length: 24 }, (_, hour) => ({
    id: `h${hour}`,
    validTime: new Date(start + hour * 3_600_000).toISOString()
  }));
  doc = new Document();
  const host = doc.createElement('div');
  const timeline = createCompactTimeline(host as unknown as HTMLElement, {
    onSelect(index) { timeline.update(hourly, hourly[index]!.id); },
    offsetMinutes,
    latitude: 37.54,
    longitude: -77.46
  });
  const root = host.children[0]!;
  const track = byClass(root, 'ct-track');
  track.offsetWidth = 480;
  timeline.update(hourly, 'h16');
  const scale = buildDayScale(480, place, 16 * 60);
  const evening = scale.segments.find(segment => segment.kind === 'evening')!;
  pointer(track, 'pointerdown', minuteToX(scale, 16 * 60));
  pointer(track, 'pointermove', (evening.x0 + evening.x1) / 2);
  expect(named(root, 'ct-moon')).toHaveLength(2);
  pointer(track, 'pointerup', (evening.x0 + evening.x1) / 2);
  expect(named(root, 'ct-moon')).toHaveLength(1);
  timeline.destroy();
});

it('drops a frozen drag scale when the frames or map center change, and keeps it across a resize', () => {
  const offsetMinutes = -300;
  const start = Date.parse('2026-11-16T00:00:00Z') - offsetMinutes * 60_000;
  const place = solarMinuteBounds(37.54, -77.46, '2026-11-16', offsetMinutes);
  const hourly: TimelineFrame[] = Array.from({ length: 24 }, (_, hour) => ({
    id: `h${hour}`,
    validTime: new Date(start + hour * 3_600_000).toISOString()
  }));
  const { host, onSelect, timeline } = setup(offsetMinutes, { latitude: 37.54, longitude: -77.46 });
  const root = host.children[0]!;
  const track = byClass(root, 'ct-track');
  track.offsetWidth = 480;
  timeline.update(hourly, 'h16');
  const scale = buildDayScale(480, place, 16 * 60);
  const evening = scale.segments.find(segment => segment.kind === 'evening')!;
  const nightX = (evening.x0 + evening.x1) / 2;
  pointer(track, 'pointerdown', minuteToX(scale, 16 * 60));
  pointer(track, 'pointermove', nightX);
  expect(named(root, 'ct-moon')).toHaveLength(2);
  track.offsetWidth = 640;
  pointer(track, 'pointermove', nightX);
  expect(named(root, 'ct-moon')).toHaveLength(2);
  const refreshed = hourly.map(frame => ({ ...frame, validTime: new Date(Date.parse(frame.validTime) + 1000).toISOString() }));
  onSelect.mockClear();
  timeline.update(refreshed, 'h21');
  expect(named(root, 'ct-moon')).toHaveLength(1);
  pointer(track, 'pointerup', nightX);
  expect(onSelect.mock.calls.some(call => call[1] === 'push')).toBe(false);
  timeline.update(hourly, 'h16');
  const daylight = buildDayScale(640, place, 16 * 60);
  pointer(track, 'pointerdown', minuteToX(daylight, 16 * 60));
  expect(named(root, 'ct-moon')).toHaveLength(2);
  timeline.setMapCenter(78, 15);
  expect(named(root, 'ct-tick').map(tick => tick.textContent)).toContain('00');
  pointer(track, 'pointerup', minuteToX(daylight, 16 * 60));
  timeline.destroy();
});

it('keeps a polar day on the linear hour scale', () => {
  expect(solarMinuteBounds(78, 15, '2025-12-21', 0)).toBeNull();
  const { host, timeline } = setup(0, { latitude: 78, longitude: 15 });
  const root = host.children[0]!;
  byClass(root, 'ct-track').offsetWidth = 480;
  timeline.update([{ id: 'noon', validTime: '2025-12-21T12:00:00Z' }], 'noon');
  expect(named(root, 'ct-moon')).toHaveLength(0);
  expect(named(root, 'ct-tick').map(tick => tick.textContent)).toEqual(['00', '03', '06', '09', '12', '15', '18', '21', '24']);
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

it('records a scrub that starts with no selection', () => {
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, null);
  const track = byClass(host.children[0]!, 'ct-track');
  track.offsetWidth = 240;
  pointer(track, 'pointerdown', 200);
  pointer(track, 'pointerup', 200);
  expect(onSelect.mock.calls.some(call => call[1] === 'push')).toBe(true);
  timeline.destroy();
});

function setupAnimationTimeline(onPlayback?: (playing: boolean) => void, onIntent?: (index: number) => void) {
  doc = new Document();
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  const view = Object.assign(new EventTarget(), {
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++nextId; callbacks.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { callbacks.delete(id); }
  });
  Object.defineProperty(doc, 'defaultView', { value: view });
  const host = doc.createElement('div');
  const onSelect = vi.fn();
  const timeline = createCompactTimeline(host as unknown as HTMLElement, { onSelect, ...(onPlayback ? { onPlayback } : {}), ...(onIntent ? { onIntent } : {}) });
  const hours = [0, 6, 12, 18].map(hour => ({ id: `h${hour}`, validTime: `2026-11-14T${String(hour).padStart(2, '0')}:00:00Z` }));
  timeline.update(hours, 'h0');
  const track = byClass(host.children[0]!, 'ct-track');
  track.offsetWidth = 240;
  const flush = () => { const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(16); };
  return { host, track, timeline, onSelect, hours, callbacks, flush };
}

it('coalesces drag scene work while immediately moving the playhead', () => {
  const { host, track, timeline, onSelect, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  pointer(track, 'pointermove', 120);
  pointer(track, 'pointermove', 180);
  expect(byClass(host.children[0]!, 'ct-time').textContent).toBe('18:00 (18:00 UTC)');
  expect(onSelect).not.toHaveBeenCalled();
  expect(callbacks.size).toBe(1);
  flush();
  expect(onSelect.mock.calls).toEqual([[3, 'none']]);
  pointer(track, 'pointerup', 180);
  expect(onSelect).toHaveBeenLastCalledWith(3, 'push');
  timeline.destroy();
});

it('preserves the pending playhead across unchanged scene updates', () => {
  const { host, track, timeline, onSelect, hours, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  timeline.update(hours, 'h0');
  expect(byClass(host.children[0]!, 'ct-time').textContent).toBe('18:00 (18:00 UTC)');
  flush();
  expect(onSelect.mock.calls).toEqual([[3, 'none']]);
  timeline.update(hours, 'h18');
  pointer(track, 'pointerup', 180);
  expect(onSelect).toHaveBeenLastCalledWith(3, 'push');
  timeline.destroy();
});

it('commits the newest release position and cancels its queued scene update', () => {
  const { track, timeline, onSelect, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  pointer(track, 'pointerup', 120);
  expect(onSelect.mock.calls).toEqual([[2, 'push']]);
  expect(callbacks.size).toBe(0);
  flush();
  expect(onSelect).toHaveBeenCalledTimes(1);
  timeline.destroy();
});

it('restores the starting scene without a history entry when a drag returns', () => {
  const { track, timeline, onSelect, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  flush();
  pointer(track, 'pointermove', 0);
  pointer(track, 'pointerup', 0);
  expect(onSelect.mock.calls).toEqual([[3, 'none'], [0, 'replace']]);
  flush();
  expect(onSelect).toHaveBeenCalledTimes(2);
  timeline.destroy();
});

it('invalidates a queued drag when the frame axis changes', () => {
  const { track, timeline, onSelect, hours, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  timeline.update(hours.slice(0, 3), 'h0');
  expect(callbacks.size).toBe(0);
  pointer(track, 'pointermove', 120);
  pointer(track, 'pointerup', 120);
  flush();
  expect(onSelect).not.toHaveBeenCalled();
  timeline.destroy();
});

it('lets an immediate keyboard selection supersede a queued drag', () => {
  const { track, timeline, onSelect, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  key(track, 'End');
  expect(onSelect.mock.calls).toEqual([[3, 'replace']]);
  expect(callbacks.size).toBe(0);
  pointer(track, 'pointerup', 60);
  flush();
  expect(onSelect).toHaveBeenCalledTimes(1);
  timeline.destroy();
});

it('cancels queued drag work on destruction', () => {
  const { track, timeline, onSelect, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  timeline.destroy();
  expect(callbacks.size).toBe(0);
  flush();
  expect(onSelect).not.toHaveBeenCalled();
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

it('does not re-seek a repeated release coordinate after opening a folded night', () => {
  const { host, track, timeline, onSelect, flush } = setupAnimationTimeline();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    id: `h${hour}`, validTime: `2026-11-16T${String(hour).padStart(2, '0')}:00:00Z`
  }));
  timeline.setMapCenter(37.54, -77.46);
  timeline.setOffsetMinutes(-300);
  timeline.update(hourly, 'h21');
  track.offsetWidth = 480;
  pointer(track, 'pointerdown', 10);
  const selected = Number(track.getAttribute('aria-valuenow'));
  expect(selected).not.toBe(21);
  expect(named(host.children[0]!, 'ct-moon')).toHaveLength(1);
  pointer(track, 'pointerup', 10);
  expect(onSelect.mock.calls).toEqual([[selected, 'push']]);
  flush();
  timeline.destroy();
});

it('ignores a second pointer and commits the first pointer position', () => {
  const { track, timeline, onSelect, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  pointer(track, 'pointerdown', 180, 2);
  pointer(track, 'pointermove', 180, 2);
  pointer(track, 'pointerup', 180, 2);
  expect(track.getAttribute('aria-valuenow')).toBe('1');
  pointer(track, 'pointerup', 60);
  expect(onSelect.mock.calls).toEqual([[1, 'push']]);
  flush();
  timeline.destroy();
});

it('lets day and playback controls supersede pending drag work', () => {
  vi.useFakeTimers();
  const { host, track, timeline, onSelect, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  click(named(host.children[0]!, 'ct-day')[0]!);
  expect(onSelect.mock.calls).toEqual([[3, 'push']]);
  pointer(track, 'pointerup', 60);
  expect(callbacks.size).toBe(0);
  flush();
  timeline.update([{ id: 'h0', validTime: '2026-11-14T00:00:00Z' }, { id: 'h6', validTime: '2026-11-14T06:00:00Z' }], 'h0');
  onSelect.mockClear();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  click(byClass(host.children[0]!, 'ct-play'));
  expect(onSelect.mock.calls).toEqual([[1, 'replace'], [0, 'replace']]);
  pointer(track, 'pointerup', 60);
  flush();
  expect(onSelect).toHaveBeenCalledTimes(2);
  timeline.destroy();
});

it('recognizes synchronous scene echoes and preserves a pending playhead on old scene updates', () => {
  const { host, track, timeline, onSelect, hours, flush } = setupAnimationTimeline();
  onSelect.mockImplementation((index: number) => timeline.update(hours, hours[index]!.id));
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  flush();
  pointer(track, 'pointermove', 180);
  timeline.update(hours.map(frame => ({ ...frame })), 'h6');
  expect(byClass(host.children[0]!, 'ct-time').textContent).toBe('18:00 (18:00 UTC)');
  flush();
  pointer(track, 'pointerup', 180);
  expect(onSelect.mock.calls).toEqual([[1, 'none'], [3, 'none'], [3, 'push']]);
  timeline.destroy();
});

it('preserves the frozen night scale across old scene updates and synchronous echoes', () => {
  const { host, track, timeline, onSelect, flush } = setupAnimationTimeline();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    id: `h${hour}`, validTime: `2026-11-16T${String(hour).padStart(2, '0')}:00:00Z`
  }));
  const bounds = solarMinuteBounds(37.54, -77.46, '2026-11-16', -300);
  timeline.setMapCenter(37.54, -77.46);
  timeline.setOffsetMinutes(-300);
  timeline.update(hourly, 'h21');
  onSelect.mockImplementation((index: number) => timeline.update(hourly, hourly[index]!.id));
  track.offsetWidth = 480;
  const scale = buildDayScale(480, bounds, 16 * 60);
  const evening = scale.segments.find(segment => segment.kind === 'evening')!;
  pointer(track, 'pointerdown', minuteToX(scale, 16 * 60));
  pointer(track, 'pointermove', (evening.x0 + evening.x1) / 2);
  timeline.update(hourly, 'h21');
  expect(named(host.children[0]!, 'ct-moon')).toHaveLength(2);
  flush();
  expect(named(host.children[0]!, 'ct-moon')).toHaveLength(2);
  pointer(track, 'pointerup', (evening.x0 + evening.x1) / 2);
  expect(named(host.children[0]!, 'ct-moon')).toHaveLength(1);
  timeline.destroy();
});

it.each(['selection', 'frames', 'disabled'])('invalidates pending drag and release after external %s change', change => {
  const { track, timeline, onSelect, hours, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  if (change === 'selection') timeline.update(hours, 'h6');
  else if (change === 'frames') timeline.update(hours.map((frame, index) => index === 1 ? { ...frame, validTime: '2026-11-14T07:00:00Z' } : frame), 'h0');
  else timeline.update(hours, 'h0', true);
  expect(callbacks.size).toBe(0);
  pointer(track, 'pointerup', 120);
  flush();
  expect(onSelect).not.toHaveBeenCalled();
  timeline.destroy();
});

it('does not seek a pointercancel coordinate and permits reentrant RAF scheduling', () => {
  const { track, timeline, onSelect, callbacks, flush } = setupAnimationTimeline();
  onSelect.mockImplementationOnce(() => pointer(track, 'pointermove', 120));
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  flush();
  expect(callbacks.size).toBe(1);
  flush();
  pointer(track, 'pointercancel', 180);
  expect(onSelect.mock.calls).toEqual([[1, 'none'], [2, 'none'], [2, 'push']]);
  timeline.destroy();
});

it.each(['day', 'key'])('commits same-frame %s selection after a drag scene was delivered', control => {
  const { host, track, timeline, onSelect, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  flush();
  if (control === 'day') click(named(host.children[0]!, 'ct-day')[0]!);
  else key(track, 'End');
  pointer(track, 'pointerup', 60);
  expect(onSelect.mock.calls).toEqual([[3, 'none'], [3, control === 'day' ? 'push' : 'replace']]);
  timeline.destroy();
});

it('cancels a pending gesture before an external selection of the acknowledged scene', () => {
  const { host, track, timeline, onSelect, hours, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  flush();
  pointer(track, 'pointermove', 180);
  timeline.update(hours, 'h6');
  expect(track.getAttribute('aria-valuenow')).toBe('3');
  timeline.cancelGesture();
  expect(track.getAttribute('aria-valuenow')).toBe('1');
  expect(byClass(host.children[0]!, 'ct-time').textContent).toBe('06:00 (06:00 UTC)');
  expect(callbacks.size).toBe(0);
  timeline.update(hours, 'h6');
  pointer(track, 'pointerup', 180);
  flush();
  expect(onSelect.mock.calls).toEqual([[1, 'none']]);
  timeline.cancelGesture();
  timeline.destroy();
  timeline.cancelGesture();
});

it('ignores subpixel movement on release after opening a folded night', () => {
  const { track, timeline, onSelect, flush } = setupAnimationTimeline();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    id: `h${hour}`, validTime: `2026-11-16T${String(hour).padStart(2, '0')}:00:00Z`
  }));
  timeline.setMapCenter(37.54, -77.46);
  timeline.setOffsetMinutes(-300);
  timeline.update(hourly, 'h21');
  track.offsetWidth = 480;
  pointer(track, 'pointerdown', 10);
  const selected = Number(track.getAttribute('aria-valuenow'));
  pointer(track, 'pointermove', 10.5);
  pointer(track, 'pointerup', 10.5);
  expect(onSelect.mock.calls).toEqual([[selected, 'push']]);
  flush();
  timeline.destroy();
});

it('does not start playback when an immediate selection destroys the timeline', () => {
  vi.useFakeTimers();
  const onPlayback = vi.fn();
  const { host, track, timeline, onSelect, flush } = setupAnimationTimeline(onPlayback);
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  onSelect.mockImplementationOnce(() => timeline.destroy());
  const play = byClass(host.children[0]!, 'ct-play');
  click(play);
  expect(onSelect.mock.calls).toEqual([[1, 'replace']]);
  expect(vi.getTimerCount()).toBe(0);
  expect(onPlayback).not.toHaveBeenCalled();
  flush();
});

it('does not start playback when a selection synchronously disables the timeline', () => {
  vi.useFakeTimers();
  const onPlayback = vi.fn();
  const { host, track, timeline, onSelect, hours, flush } = setupAnimationTimeline(onPlayback);
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  onSelect.mockImplementationOnce(() => timeline.update(hours, 'h6', true));
  click(byClass(host.children[0]!, 'ct-play'));
  expect(vi.getTimerCount()).toBe(0);
  expect(onPlayback).not.toHaveBeenCalled();
  flush();
  expect(onSelect.mock.calls).toEqual([[1, 'replace']]);
  timeline.destroy();
});

it('does not start playback when selecting the first frame destroys the timeline', () => {
  vi.useFakeTimers();
  const onPlayback = vi.fn();
  const { host, timeline, onSelect, hours } = setupAnimationTimeline(onPlayback);
  timeline.update(hours, 'h18');
  onSelect.mockImplementationOnce(() => timeline.destroy());
  click(byClass(host.children[0]!, 'ct-play'));
  expect(onSelect.mock.calls).toEqual([[0, 'replace']]);
  expect(vi.getTimerCount()).toBe(0);
  expect(onPlayback).not.toHaveBeenCalled();
});

it('announces each changed drag intent before coalesced scene delivery', () => {
  const onIntent = vi.fn();
  const { track, timeline, onSelect, flush } = setupAnimationTimeline(undefined, onIntent);
  pointer(track, 'pointerdown', 60);
  pointer(track, 'pointermove', 60);
  pointer(track, 'pointermove', 120);
  pointer(track, 'pointermove', 120);
  expect(onIntent.mock.calls).toEqual([[1], [2]]);
  expect(onSelect).not.toHaveBeenCalled();
  flush();
  expect(onSelect.mock.calls).toEqual([[2, 'none']]);
  pointer(track, 'pointerup', 180);
  expect(onIntent.mock.calls).toEqual([[1], [2], [3]]);
  expect(onSelect.mock.calls).toEqual([[2, 'none'], [3, 'push']]);
  timeline.destroy();
});

it('cancels an obsolete Auto-like result before the next drag scene is delivered', async () => {
  let generation = 0;
  const onIntent = vi.fn(() => { generation++; });
  const { track, timeline, onSelect, hours, flush } = setupAnimationTimeline(undefined, onIntent);
  const requested = generation;
  let resolve!: () => void;
  const result = new Promise<void>(done => { resolve = done; }).then(() => {
    if (requested === generation) timeline.update(hours, 'h6');
  });
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 180);
  resolve();
  await result;
  expect(track.getAttribute('aria-valuenow')).toBe('3');
  expect(onSelect).not.toHaveBeenCalled();
  flush();
  expect(onSelect.mock.calls).toEqual([[3, 'none']]);
  pointer(track, 'pointerup', 180);
  timeline.destroy();
});

it.each(['destroy', 'disable', 'cancel'])('stops the gesture when onIntent synchronously calls %s', action => {
  const onIntent = vi.fn(() => {
    if (action === 'destroy') timeline.destroy();
    else if (action === 'disable') timeline.update(hours, 'h0', true);
    else timeline.cancelGesture();
  });
  const setup = setupAnimationTimeline(undefined, onIntent);
  const { timeline, hours } = setup;
  pointer(setup.track, 'pointerdown', 60);
  pointer(setup.track, 'pointerup', 120);
  setup.flush();
  expect(onIntent.mock.calls).toEqual([[1]]);
  expect(setup.callbacks.size).toBe(0);
  expect(setup.onSelect).not.toHaveBeenCalled();
  timeline.destroy();
});

it('does not commit release when onIntent invalidates the gesture', () => {
  const onIntent = vi.fn(() => timeline.cancelGesture());
  const setup = setupAnimationTimeline(undefined, onIntent);
  const { timeline } = setup;
  pointer(setup.track, 'pointerdown', 0);
  pointer(setup.track, 'pointerup', 120);
  setup.flush();
  expect(onIntent.mock.calls).toEqual([[2]]);
  expect(setup.onSelect).not.toHaveBeenCalled();
  expect(setup.track.getAttribute('aria-valuenow')).toBe('0');
  timeline.destroy();
});

it('does not let a reentrant release invalidate a newly started gesture', () => {
  const onIntent = vi.fn().mockImplementationOnce(() => {
    timeline.cancelGesture();
    pointer(track, 'pointerdown', 180);
  });
  const setup = setupAnimationTimeline(undefined, onIntent);
  const { timeline, track } = setup;
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointerup', 120);
  expect(onIntent.mock.calls).toEqual([[2], [3]]);
  expect(setup.callbacks.size).toBe(1);
  pointer(track, 'pointerup', 180);
  setup.flush();
  expect(setup.onSelect.mock.calls).toEqual([[3, 'push']]);
  timeline.destroy();
});

it.each(['destroy', 'disable'])('does not start a gesture when playback stop synchronously calls %s', action => {
  vi.useFakeTimers();
  const onPlayback = vi.fn((playing: boolean) => {
    if (!playing) {
      if (action === 'destroy') timeline.destroy();
      else timeline.update(hours, 'h0', true);
    }
  });
  const setup = setupAnimationTimeline(onPlayback);
  const { timeline, hours } = setup;
  click(byClass(setup.host.children[0]!, 'ct-play'));
  pointer(setup.track, 'pointerdown', 60);
  expect(setup.callbacks.size).toBe(0);
  pointer(setup.track, 'pointerup', 120);
  setup.flush();
  expect(onPlayback.mock.calls).toEqual([[true], [false]]);
  expect(vi.getTimerCount()).toBe(0);
  expect(setup.callbacks.size).toBe(0);
  expect(setup.onSelect).not.toHaveBeenCalled();
  timeline.destroy();
});

it.each(['pointerup', 'pointercancel'])('replaces a changed gesture returned to start before RAF on %s', type => {
  const { track, timeline, onSelect, callbacks, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  pointer(track, 'pointermove', 0);
  pointer(track, type, 0);
  expect(onSelect.mock.calls).toEqual([[0, 'replace']]);
  expect(callbacks.size).toBe(0);
  flush();
  expect(onSelect).toHaveBeenCalledTimes(1);
  timeline.destroy();
});

it('pushes the final scene after a synchronous RAF echo', () => {
  const events: string[] = [];
  const { track, timeline, onSelect, hours, flush } = setupAnimationTimeline();
  onSelect.mockImplementation((index: number, history: string) => {
    events.push(`select:${index}:${history}`);
    timeline.update(hours, hours[index]!.id);
  });
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  flush();
  pointer(track, 'pointerup', 60);
  expect(events).toEqual(['select:1:none', 'select:1:push']);
  timeline.destroy();
});

it('replaces restored starting scene after a previously delivered drag frame', () => {
  const { track, timeline, onSelect, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  flush();
  pointer(track, 'pointermove', 0);
  pointer(track, 'pointerup', 0);
  expect(onSelect.mock.calls).toEqual([[1, 'none'], [0, 'replace']]);
  timeline.destroy();
});

it('allows final onSelect to start a new gesture without completing it twice', () => {
  const { track, timeline, onSelect, flush } = setupAnimationTimeline();
  onSelect.mockImplementationOnce(() => pointer(track, 'pointerdown', 120));
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointerup', 60);
  expect(onSelect.mock.calls).toEqual([[1, 'push']]);
  pointer(track, 'pointerup', 120);
  flush();
  expect(onSelect.mock.calls).toEqual([[1, 'push'], [2, 'push']]);
  timeline.destroy();
});

it('returns cancellation state based on the acknowledged scene without completing', () => {
  const { track, timeline, onSelect, flush } = setupAnimationTimeline();
  expect(timeline.cancelGesture()).toBeNull();
  pointer(track, 'pointerdown', 0);
  expect(timeline.cancelGesture()).toEqual({ changed: false, delivered: false });
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  expect(timeline.cancelGesture()).toEqual({ changed: true, delivered: false });
  flush();
  expect(onSelect).not.toHaveBeenCalled();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  flush();
  pointer(track, 'pointermove', 120);
  expect(timeline.cancelGesture()).toEqual({ changed: true, delivered: true });
  expect(track.getAttribute('aria-valuenow')).toBe('1');
  pointer(track, 'pointerup', 120);
  flush();
  expect(onSelect.mock.calls).toEqual([[1, 'none']]);
  timeline.destroy();
  expect(timeline.cancelGesture()).toBeNull();
});

it.each(['day', 'key', 'play'])('does not select again on release when %s supersedes drag', control => {
  vi.useFakeTimers();
  const { host, track, timeline, onSelect, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  flush();
  if (control === 'day') click(named(host.children[0]!, 'ct-day')[0]!);
  else if (control === 'key') key(track, 'End');
  else click(byClass(host.children[0]!, 'ct-play'));
  const calls = onSelect.mock.calls.length;
  pointer(track, 'pointerup', 60);
  flush();
  expect(onSelect).toHaveBeenCalledTimes(calls);
  timeline.destroy();
});

it.each(['destroy', 'disable', 'external', 'new gesture'])('does not disturb state after final onSelect causes %s', action => {
  const { track, timeline, onSelect, hours, flush } = setupAnimationTimeline();
  onSelect.mockImplementationOnce(() => {
    if (action === 'destroy') timeline.destroy();
    else if (action === 'disable') timeline.update(hours, 'h6', true);
    else if (action === 'external') timeline.update(hours, 'h12');
    else pointer(track, 'pointerdown', 120);
  });
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointerup', 60);
  expect(onSelect.mock.calls).toEqual([[1, 'push']]);
  if (action === 'new gesture') {
    pointer(track, 'pointerup', 120);
    expect(onSelect.mock.calls).toEqual([[1, 'push'], [2, 'push']]);
  } else if (action === 'external') {
    expect(track.getAttribute('aria-valuenow')).toBe('2');
  }
  flush();
  timeline.destroy();
});

it('does not select for an unchanged click or invalidated external update', () => {
  const { track, timeline, onSelect, hours, flush } = setupAnimationTimeline();
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointerup', 0);
  pointer(track, 'pointerdown', 0);
  pointer(track, 'pointermove', 60);
  timeline.update(hours, 'h12');
  pointer(track, 'pointerup', 60);
  flush();
  expect(onSelect).not.toHaveBeenCalled();
  timeline.destroy();
});
