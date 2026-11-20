import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileResponseSchema, SUPPORT_CUMULUS } from '@av/contracts';
import { formatPointMapLift, type PointFrame } from '@av/client';
import { fixturePointSample, fixtureProfileBuild, fixtureProfileResponse } from '../../../tests/client-point-fixture.ts';
import { mountWindgram } from './dom.ts';
import { disposePointWindgram, renderPointWindgram } from './point-windgram.ts';
import { buildStitchedWindgramView, buildWindgramView, createPointForecast, readWindgram } from './model.ts';
import { findBestSoaringDayKey, formatDayWindowLabel, resolveStitchedDayWindow } from './point-view-mode.ts';
import { sceneData } from './scene-store.ts';
import { renderWindgramKey, renderWindgramSvg } from './svg.ts';
import { formatWindgramReading } from './windgram-readout.ts';

import { barbGeometry, displayedBarbSpeed, quantizedBarbSpeed } from './wind-barb.ts';
import { classifyParagliderWind, cloudOktasSegments, getWindgramCalloutRenderer, placeWindgramCallout } from './windgram-callout.ts';
import { windBarbGlyph } from './windgram-glyphs.ts';
import { resolveWindgramPresentation } from './windgram-presentation.ts';
import { elevationTickMeters, mpsToKnots, roundedElevationLabel } from './windgram-format.ts';
import { hourSampling, sampleHeight } from './windgram-sampling.ts';

it('mirrors the pennant and feathers south of the equator without reversing the staff', () => {
  for (const [direction, x, y] of [[0, 0, -22], [90, 22, 0], [180, 0, 22], [270, -22, 0]]) {
    const north = barbGeometry(65, direction, 22, false), south = barbGeometry(65, direction, 22, true);
    expect(north.staff).toBe(south.staff);
    expect(north.points[1]?.map(value => value || 0)).toEqual([x, y]);
    for (const vertex of [3, 6, 8]) {
      const side = ([px, py]: readonly [number, number]) => Math.sign(x * py - y * px);
      expect(side(north.points[vertex]!)).toBe(1);
      expect(side(south.points[vertex]!)).toBe(-1);
    }
  }
});

it.each(['metric', 'imperial'] as const)('draws WMO/ICAO knot barbs invariantly in %s while formatting display speeds', system => {
  const presentation = resolveWindgramPresentation({ compact: true });
  for (const calmKt of [0, 0.1, 0.4, 1, 2.49]) {
    const glyph = windBarbGlyph({ x: 0, y: 0, speedKt: calmKt, directionDeg: 0, southernHemisphere: false }, presentation, system);
    expect(glyph.calm).toBe(true);
    expect(glyph.flags).toHaveLength(0);
  }
  const twentyKt = windBarbGlyph({ x: 0, y: 0, speedKt: 20, directionDeg: 0, southernHemisphere: false }, presentation, system);
  expect(twentyKt.calm).toBe(false);
  expect(twentyKt.flags).toHaveLength(2);
  expect(displayedBarbSpeed(20 / mpsToKnots(1), system)).toBe(system === 'metric' ? 37 : 23);
});

it('uses a 2.5 kt calm threshold and quantizes 2.5..7.49 kt to a half feather', () => {
  for (const calm of [0, 0.4, 1, 2.49]) {
    expect(quantizedBarbSpeed(calm)).toBe(0);
    expect(barbGeometry(calm, 0, 21, false).calm).toBe(true);
  }
  for (const speed of [2.5, 3, 4, 5, 6, 7, 7.49]) {
    expect(quantizedBarbSpeed(speed)).toBe(5);
    const geometry = barbGeometry(speed, 0, 21, false);
    expect(geometry.calm).toBe(false);
    expect(geometry.flags).toHaveLength(1);
    expect(geometry.points.some(([x]) => x === 5)).toBe(true);
  }
  for (const speed of [7.5, 8, 9, 10, 11, 12]) expect(quantizedBarbSpeed(speed)).toBe(10);
});

it('bounds geometry work for extreme finite source winds', () => {
  const geometry = barbGeometry(Math.fround(1e30), 45, 21, false);
  expect(geometry.flags.length).toBeGreaterThanOrEqual(16);
  expect(geometry.flags.length).toBeLessThanOrEqual(21);
  expect(geometry.points.every(point => point.every(Number.isFinite))).toBe(true);
});

it.each(['metric', 'imperial'] as const)('compresses extreme knot pennants identically in %s inside a mobile staff', system => {
  const presentation = resolveWindgramPresentation({ compact: true });
  for (const speedKt of [195, 200, 205, 245, 250, 255, 400]) {
    const glyph = windBarbGlyph({ x: 0, y: 0, speedKt, directionDeg: 0, southernHemisphere: false }, presentation, system);
    const quantized = Math.round(speedKt / 5) * 5;
    const pennants = Math.min(16, Math.floor(quantized / 50));
    expect(glyph.flags).toHaveLength(pennants + Math.floor(quantized % 50 / 10) + Number(quantized % 10 >= 5));
    for (const [, y] of glyph.points) expect(y).toBeGreaterThanOrEqual(-22);
    for (const [, y] of glyph.points) expect(y).toBeLessThanOrEqual(0);
  }
});

it('uses one temperature datum when a native level coincides with the 2 m observation', () => {
  const { forecast, profile, sample } = fixture([1]);
  const [hour] = forecast([sample.frames[0], profile.frames[0]]).hours;
  const frame = {
    ...hour, modelTerrainM: 500,
    surface: { ...hour.surface, temperatureC: 20 },
    levels: [{ ...hour.levels[0], heightM: 502, temperatureC: 19 }, { ...hour.levels[1], heightM: 602, temperatureC: 18 }],
  };
  const known = hourSampling(frame);
  expect(known.temperatureC).toEqual([{ altitudeM: 502, value: 20 }, { altitudeM: 602, value: 18 }]);
  expect(sampleHeight(known.lapseCPer1000Ft, 502)).toBeCloseTo(-6.096);
  const missing = hourSampling({ ...frame, surface: { ...frame.surface, temperatureC: null } });
  expect(sampleHeight(missing.temperatureC, 502)).toBe(19);
});

const point = { lat: 37.65, lon: -79.8 };

function fixture(hours: readonly number[], mapFrameCount = hours.length) {
  const build = fixtureProfileBuild({ frameHours: hours, mapFrameCount });
  const expectedFrames = build.manifest.frames.map(frame => frame.id);
  const url = `https://api.test/point?lat=${point.lat}&lon=${point.lon}&frame=${expectedFrames.join(',')}&layers=`;
  const sample = fixturePointSample(build, url + 'usable-lift-msl,usable-lift-agl');
  const profile = fixtureProfileResponse(build, url + 'thermal-top-msl,pbl-height-agl,thermal-velocity,sfc-temp-c,wind-gust-10m,cloud-cover-total,cloud-cover-low');
  const forecast = (frames: readonly PointFrame[]) => createPointForecast(build, point)(build.manifest.frames, new Map(frames.map(frame => [frame.id, frame])));
  const view = (frames: readonly PointFrame[], compact = false) => {
    const site = forecast(frames);
    return buildWindgramView(site, { unitSystem: 'metric', compact, timeZone: site.site.timeZone, hours: site.hours });
  };
  return { build, sample, profile, forecast, view };
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, ((event: Event) => void)[]>();
  attributes = new Map<string, string>();
  style: { cssText?: string } = {};
  textContent = '';
  innerHTML = '';
  hidden = false;
  className = '';
  id = '';
  role = '';
  ariaLabel = '';
  ariaPressed = '';
  disabled = false;
  type = '';
  value = '';
  checked = false;
  tabIndex = -1;
  clientWidth = 420;
  constructor(readonly tag: string, readonly ownerDocument?: Document) {}
  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = [];
    this.innerHTML = '';
    this.append(...children);
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

function visit(element: FakeElement): FakeElement[] {
  return [element, ...element.children.flatMap(visit)];
}

afterEach(() => vi.unstubAllGlobals());

it('labels heights on a regular step instead of each model level', () => {
  expect(roundedElevationLabel(1258, 'metric')).toBe('1,300');
  expect(elevationTickMeters(1500, 2500, 'metric', 420).map(height => roundedElevationLabel(height, 'metric'))).toEqual([
    '1,600', '1,700', '1,800', '1,900', '2,000', '2,100', '2,200', '2,300', '2,400'
  ]);
  const { profile, sample, forecast } = fixture([14, 15, 16, 17, 18, 19, 20]);
  const frames = profile.frames.map((frame, index) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[index].layers } }));
  const site = forecast(frames);
  const svg = renderWindgramSvg(buildWindgramView(site, {
    unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: site.site.timeZone, hours: site.hours, widthPx: 620,
  }));
  const heights = [...svg.matchAll(/y="([^"]+)"[^>]*class="wg-axis-feet"/g)].map(match => Number(match[1]));
  const gaps = heights.slice(1).map((y, index) => Math.abs(y - heights[index]));
  expect(svg).toContain('>1,600<');
  expect(svg).toContain('>2,000<');
  expect(svg).not.toContain('1,258');
  expect(gaps.length).toBeGreaterThan(3);
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.5);
  expect([...svg.matchAll(/class="wg-temperature[^"]*">([^<]*)</g)].map(match => match[1]).filter(value => value === '10°')).toHaveLength(1);
});

it('crops a wide soaring chart to the same height band as the phone', () => {
  const { profile, sample, forecast } = fixture([20]);
  const frames = profile.frames.map((frame, index) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[index].layers } }));
  const site = forecast(frames);
  const options = { unitSystem: 'metric' as const, timeZone: site.site.timeZone, hours: site.hours };
  const full = buildWindgramView(site, { ...options, compact: false });
  const wide = buildWindgramView(site, { ...options, compact: false, heightRange: 'soaring' });
  const phone = buildWindgramView(site, { ...options, compact: true });
  expect(wide.topM).toBe(phone.topM);
  expect(wide.topM).toBeLessThan(full.topM);
});

describe('Windgram data', () => {
  it.each([false, true])('shows the sampled ceiling below native ground (compact=%s)', compact => {
    const { sample, profile, forecast, view } = fixture([20, 21, 22, 23]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    const [low, calm, missing, outside] = frames;
    low.layers['usable-lift-msl'] = { ...low.layers['usable-lift-msl'], value: 1300, interpolated: true, support: SUPPORT_CUMULUS };
    low.layers['usable-lift-agl'] = { ...low.layers['usable-lift-agl'], value: 350, interpolated: true, support: SUPPORT_CUMULUS };
    calm.layers['usable-lift-msl'] = { ...calm.layers['usable-lift-msl'], value: null, status: 'no-usable-lift' };
    calm.layers['usable-lift-agl'] = { ...calm.layers['usable-lift-agl'], value: 0, status: 'no-usable-lift' };
    calm.layers['thermal-top-msl'] = { ...calm.layers['thermal-top-msl'], value: 1500 };
    calm.layers['pbl-height-agl'] = { ...calm.layers['pbl-height-agl'], value: 100 };
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
      missing.layers[layer] = { ...missing.layers[layer], value: null, status: 'unavailable' };
      outside.layers[layer] = { ...outside.layers[layer], value: null, status: 'outside-domain' };
    }
    const result = forecast(frames);
    expect(result.site.timeZone).toBe('Etc/GMT+5');
    const lift = result.hours.map(hour => hour.mapLift);
    expect(formatPointMapLift(lift[0], 'metric')).toBe('MSL 1300 m · AGL 350 m · Surface elevation unknown · Map Cu');
    expect(lift[0].agl).toMatchObject({ value: 350, interpolated: true, surfaceId: 'gfs-fine' });
    expect(lift[1].agl).toMatchObject({ value: 0, status: 'no-usable-lift' });
    expect(formatPointMapLift(lift[1], 'metric')).toContain('AGL no usable lift');
    expect(formatPointMapLift(lift[2], 'metric')).toContain('AGL unavailable');
    expect(formatPointMapLift(lift[3], 'metric')).toContain('AGL outside coverage');
    expect(frames.every(frame => frame.derived.usableLiftTopV2M === 2500)).toBe(true);

    const scene = view(frames, compact);
    expect(scene.floorM).toBeLessThan(1300);
    expect(scene.hours.map(hour => hour.usableLiftTopM)).toEqual([1300, null, null, null]);
    const svg = renderWindgramSvg(scene);
    expect(svg.match(/data-map-lift-ceiling/g)).toHaveLength(1);
    expect(svg).toContain('Map usable lift');
    expect(readWindgram(scene, 0, 1300)).toMatchObject({ heightM: 1300, temperatureF: null, speedKt: null, heightAglM: null });
    expect(readWindgram(scene, 1, 1800)).toMatchObject({ nativeThermalTopM: 1500, modelPblTopM: 1600, heightAglM: 300, heightAglReference: 'model' });
  });

  it('keeps the manifest time axis while a scheduled hour lacks data', () => {
    const { sample, profile, forecast, view } = fixture([22, 23, 24, 27]);
    const frames = [sample.frames[0], profile.frames[2], profile.frames[3]];
    const hours = forecast(frames).hours;
    expect(hours.map(hour => hour.levels.length)).toEqual([0, 0, 4, 4]);
    expect(hours[0].modelTerrainM).toBeNull();
    expect(hours[0].mapLift.terrainM).toBe(1500);
    const scene = view(frames);
    expect(scene.hours).toHaveLength(4);
    expect(scene.hours[3].x - scene.hours[2].x).toBeCloseTo(3 * (scene.hours[2].x - scene.hours[1].x));
    expect(readWindgram(scene, 0, 1900)).toMatchObject({ heightAglM: 400, heightAglReference: 'terrain', speedKt: null });
    expect(readWindgram(scene, 1, 1900)).toMatchObject({ heightAglM: null, heightAglReference: null, temperatureF: null });
    expect(readWindgram(scene, 2, 1800).speedKt).toBeCloseTo(9.7192);
  });

  it('fits the plot and axes within the panel height budget', () => {
    const { profile, forecast } = fixture([20, 21, 22]);
    const site = forecast(profile.frames);
    const scene = buildWindgramView(site, {
      unitSystem: 'metric', compact: true, timeZone: site.site.timeZone, hours: site.hours, widthPx: 420, heightPx: 286
    });
    expect(scene.height).toBe(286);
    expect(scene.hours.map(hour => hour.validAt)).toEqual(site.hours.map(hour => hour.validAt));
    expect(renderWindgramSvg(scene)).toContain('width="420" height="286" viewBox="0 0 420 286"');
  });

  it('preserves the gap where a native level has no height', () => {
    const { profile, view } = fixture([20, 21]);
    profile.frames[0].profile.levels[1].heightM = null;
    profile.frames[1].profile.levels[0].heightM = null;
    const scene = view(profileResponseSchema.parse(profile).frames);
    expect(readWindgram(scene, 0, 1800).temperatureF).toBeCloseTo(53.6);
    expect(readWindgram(scene, 0, 2400)).toMatchObject({
      temperatureF: null, speedKt: null, relativeHumidityPercent: null, verticalVelocityPaS: null, windShear: null
    });
    expect(readWindgram(scene, 0, 3000).temperatureF).toBeCloseTo(39.2);
    expect(readWindgram(scene, 1, 1502).temperatureF).not.toBeNull();
    expect(readWindgram(scene, 1, 1850)).toMatchObject({ temperatureF: null, speedKt: null });
  });

  it('reports the same interpolated humidity that controls hatching', () => {
    const { profile, view } = fixture([20]);
    const column = profile.frames[0].profile;
    column.levels = [
      { ...column.levels[0], pressureHpa: 510, heightM: 5000, temperatureC: -25, dewPointC: -32 },
      { ...column.levels[1], pressureHpa: 420, heightM: 6500, temperatureC: -40, dewPointC: -40 },
    ];
    const reading = readWindgram(view(profile.frames), 0, 6312.5);
    expect(reading).toMatchObject({ cloud: 'humidity', temperatureF: -36.625, dewPointC: -39 });
    expect(reading.relativeHumidityPercent).toBeCloseTo(94.014, 3);
  });

  it('keeps Day 1 hourly column width unchanged when 3-hourly later days are present', () => {
    const dayOneHours = [14, 15, 16, 17, 18];
    const mixedHours = [...dayOneHours, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54];
    const singleDay = fixture(dayOneHours);
    const multiDay = fixture(mixedHours);
    const singleSite = singleDay.forecast(singleDay.profile.frames);
    const multiSite = multiDay.forecast(multiDay.profile.frames);
    const dayKey = singleSite.hours[0].validAt.slice(0, 10);
    const singleView = buildWindgramView(singleSite, {
      unitSystem: 'metric',
      timeZone: singleSite.site.timeZone,
      hours: { timeZone: singleSite.site.timeZone, dateKey: dayKey }
    });
    const multiView = buildWindgramView(multiSite, {
      unitSystem: 'metric',
      timeZone: multiSite.site.timeZone,
      hours: { timeZone: multiSite.site.timeZone, dateKey: dayKey }
    });
    expect(multiView.columnWidth).toBeCloseTo(singleView.columnWidth, 5);
  });

  it('reads gust and precipitation classes from the published descriptors', () => {
    const { build, profile, forecast } = fixture([15]);
    expect(forecast(profile.frames).semantics).toEqual({ capeLabel: 'CAPE', gust: 'instant', precipitation: 'windowMeanRate' });
    if (build.manifest.version !== 5) throw new Error('Expected v5');
    build.manifest.descriptors.layers['wind-gust-10m']!.timeSupport = 'interval-maximum';
    expect(forecast(profile.frames).semantics.gust).toBe('hourMax');
    expect(renderWindgramKey('imperial')).toContain('Map usable lift');
  });

  it('formats horizontal wind thresholds in displayed units while keeping knot feather increments', () => {
    const metric = renderWindgramKey('metric'), imperial = renderWindgramKey('imperial');
    expect(metric).toContain('Wind · half 5 / full 10 / flag 50 kt');
    expect(metric).toContain('Green wind is below 16.7 km/h');
    expect(imperial).toContain('Wind · half 5 / full 10 / flag 50 kt');
    expect(imperial).toContain('Green wind is below 10.4 mph');
  });

  it('uses pinned CAPE and gust semantics for an older build of the same model', () => {
    const { build, profile } = fixture([15]);
    const pointFrames = new Map(profile.frames.map(frame => [frame.id, frame]));
    const read = () => {
      const site = createPointForecast(build, point)(build.manifest.frames, pointFrames);
      const scene = buildWindgramView(site, { unitSystem: 'metric', timeZone: site.site.timeZone });
      const reading = { ...readWindgram(scene, 0, 1800), capeJkg: 500, gustKt: 10 };
      return formatWindgramReading(sceneData(scene), reading, 'surface').join(' · ');
    };
    expect(read()).toContain('CAPE 500 J/kg');
    expect(read()).toContain('gust sample');
    build.manifest.descriptors.layers['cape-jkg'].label = 'Retained CAPE';
    build.manifest.descriptors.layers['wind-gust-10m'].timeSupport = 'interval-maximum';
    expect(read()).toContain('Retained CAPE 500 J/kg');
    expect(read()).toContain('hour-max gust');
  });

  it('converts only changed hours as sample and profile pages arrive', () => {
    const { build, sample, profile } = fixture(Array.from({ length: 120 }, (_, i) => i + 1), 24);
    const convert = createPointForecast(build, point);
    const frames = build.manifest.frames, first = sample.frames[0];
    const loaded = new Map<string, PointFrame>([[first.id, first]]);
    const before = convert(frames, loaded).hours;
    loaded.set(first.id, { ...profile.frames[0], layers: { ...profile.frames[0].layers, ...first.layers } });
    loaded.set(sample.frames[48].id, sample.frames[48]);
    const after = convert(frames, loaded).hours;
    expect(after.flatMap((hour, index) => hour === before[index] ? [] : [index])).toEqual([0, 48]);
    expect(after[0].levels).toBe(profile.frames[0].profile.levels);
    expect(convert(frames.slice(0, 24), loaded).hours[0]).toBe(after[0]);
    expect(convert(frames, loaded).hours[48]).toBe(after[48]);
  });

  it('reuses the mounted day chart across later-day progress pages and updates on resize or mode change', () => {
    const head = new FakeElement('head');
    const otherHead = new FakeElement('head');
    vi.stubGlobal('document', { head: otherHead, createElement: (tag: string) => new FakeElement(tag) });
    let resizeCallback: (() => void) | null = null;
    const disconnected = vi.fn();
    let maxHeight = '50%';
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: Object.assign(new EventTarget(), {
        getComputedStyle: () => ({ maxHeight }),
        ResizeObserver: class {
          constructor(callback: () => void) { resizeCallback = callback; }
          observe(): void {}
          disconnect(): void { disconnected(); }
        }
      })
    };
    const { build, sample, profile } = fixture([14, 15, 29, 38, 39]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    const root = owner.createElement('div');
    const container = root as unknown as HTMLElement;
    const onFrame = vi.fn();

    renderPointWindgram(container, { frames: frames.slice(0, 2) }, build, {
      point, frameId: 'f014', unitSystem: 'metric', viewMode: '1d', totalFrames: 5, loading: true, onFrame
    });
    const host = visit(root).find(el => el.className === 'av-windgram-host')!;
    expect(host.ownerDocument).toBe(owner);
    expect(head.children).toHaveLength(2);
    expect(otherHead.children).toHaveLength(0);
    // A percentage can remain unresolved in computed style. The chart keeps its natural height.
    expect(Number(/viewBox="0 0 420 (\d+)"/.exec(host.innerHTML)?.[1])).toBeGreaterThan(286);
    maxHeight = '286px';
    resizeCallback!();
    expect(host.innerHTML).toContain('viewBox="0 0 420 286"');
    const htmlSpy = vi.fn();
    let currentHtml = host.innerHTML;
    Object.defineProperty(host, 'innerHTML', {
      get: () => currentHtml,
      set: (next: string) => { htmlSpy(); currentHtml = next; }
    });

    // Appending later-day frames keeps Day 1's mounted SVG untouched.
    const update = renderPointWindgram(container, { frames }, build, {
      point, frameId: 'f014', unitSystem: 'metric', viewMode: '1d', totalFrames: 5, loading: false, onFrame
    });
    expect(htmlSpy).not.toHaveBeenCalled();

    // Magnetic TOL + free-height inspection mounts directly with zero mode-toggle checkbox,
    // a 1-line telemetry strip, and a visual chart key popover.
    expect(visit(root).some(el => el.tag === 'input' && el.type === 'checkbox')).toBe(false);
    expect(host.getAttribute('aria-label')).toContain('magnetic snap on Top of Lift');
    const bar = visit(root).find(el => el.className === 'av-windgram-bar')!;
    expect(bar).toBeDefined();
    expect(visit(bar).map(el => el.textContent).join(' ')).toContain('Key');
    const keyCard = visit(bar).find(el => el.className === 'av-windgram-key')!;
    expect(keyCard.innerHTML).toContain('Strong Thermal');
    expect(keyCard.innerHTML).toContain('Inversion');

    // Selecting an hour with no usable lift keeps 'MSL no usable lift · AGL no usable lift' hidden below the chart.
    frames[1].layers['usable-lift-msl'] = { ...frames[1].layers['usable-lift-msl']!, value: null, status: 'no-usable-lift' };
    frames[1].layers['usable-lift-agl'] = { ...frames[1].layers['usable-lift-agl']!, value: 0, status: 'no-usable-lift' };
    renderPointWindgram(container, { frames }, build, {
      point, frameId: 'f015', unitSystem: 'metric', viewMode: '1d', totalFrames: 5, loading: false, onFrame
    });
    const liftSummaryEl = visit(root).find(el => el.className === 'av-windgram-lift-summary')!;
    expect(liftSummaryEl.hidden).toBe(true);
    expect(visit(bar).map(el => el.textContent).join(' ')).not.toContain('no usable lift');
    update('f014');

    // Resizing the host recomputes the chart width.
    host.clientWidth = 640;
    resizeCallback!();
    expect(htmlSpy).toHaveBeenCalledOnce();
    expect(host.innerHTML).toContain('viewBox="0 0 640');

    const press = (key: string) => host.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key }));
    let frameId = 'f014';
    for (let count = 0; count < 6 && frameId !== 'f038'; count++) {
      onFrame.mockClear();
      press('ArrowRight');
      frameId = String(onFrame.mock.calls.at(-1)?.[0] ?? frameId);
      update(frameId);
    }
    expect(frameId).toBe('f038');

    disposePointWindgram(container);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('snaps magnetically within 16px of Top of Lift, glides freely beyond 16px, and re-snaps via snapToTol', () => {
    const { sample, profile, forecast } = fixture([20, 21]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    frames[0].layers['usable-lift-msl']!.value = 2100;
    frames[0].layers['usable-lift-agl']!.value = 600;
    frames[0].layers['cloud-cover-total'] = { ...frames[0].layers['sfc-temp-c']!, value: 35 };
    const site = forecast(frames);
    const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, timeZone: site.site.timeZone, hours: site.hours });
    const cursor = new FakeElement('g');
    const tolRing = new FakeElement('circle');
    const badge = new FakeElement('text');
    const agl = new FakeElement('text');
    const msl = new FakeElement('text');
    const meteo = new FakeElement('text');
    const soar = new FakeElement('text');
    const markers = new Map([
      ['[data-windgram-cursor]', cursor],
      ['[data-cursor-tol-ring]', tolRing],
      ['[data-cursor-badge]', badge],
      ['[data-cursor-agl]', agl],
      ['[data-cursor-msl]', msl],
      ['[data-cursor-meteo]', meteo],
      ['[data-cursor-soar]', soar],
    ]);
    const svg = {
      querySelector: (selector: string) => markers.get(selector) ?? null,
      getScreenCTM: () => ({ inverse: () => ({}) }),
    };
    const host = Object.assign(new FakeElement('div'), {
      ownerDocument: {},
      querySelector: (selector: string) => (selector === 'svg.windgram' ? svg : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: scene.width, bottom: scene.height }),
    });
    vi.stubGlobal('DOMPoint', class {
      constructor(readonly x: number, readonly y: number) {}
      matrixTransform() { return this; }
    });
    const telemetries: import('./windgram-readout.ts').WindgramTelemetryStrip[] = [];
    const chart = mountWindgram(host as unknown as HTMLElement, {
      view: scene,
      idPrefix: 'magnetic-card',
      selectedValidAt: scene.hours[0].validAt,
      inspectionMode: 'magnetic',
      onTelemetry: item => { if (item) telemetries.push(item); },
    });

    // Initial selection defaults onto cloud-capped Top of Lift (2100 m < 2500 m thermal top) with concise badge, cardinal wind, TOL climb, and cloud %.
    expect(badge.textContent).toBe('★ TOP OF LIFT');
    expect(badge.textContent).not.toContain('drag');
    expect(agl.textContent).toBe('600 m AGL');
    expect(agl.textContent).not.toContain('model AGL');
    expect(meteo.textContent).not.toMatch(/\(\d+°\)/);
    expect(soar.textContent).toMatch(/Climb \+\d+\.\d m\/s · Cloud 35%/);
    expect(tolRing.getAttribute('visibility')).toBe('hidden');
    expect(telemetries.at(-1)?.snappedToTol).toBe(true);

    const tolRatio = (2100 - scene.floorM) / (scene.topM - scene.floorM);
    const tolY = scene.bottom - tolRatio * scene.plotHeight;

    // Hovering within 16px vertically of TOL snaps onto TOL.
    host.dispatchEvent(Object.assign(new Event('pointermove'), {
      pointerType: 'mouse', pointerId: 1, clientX: scene.hours[0].x, clientY: tolY - 11,
    }));
    expect(badge.textContent).toBe('★ TOP OF LIFT');
    expect(agl.textContent).toBe('600 m AGL');
    expect(tolRing.getAttribute('visibility')).toBe('hidden');

    // Dragging within the convective layer (>16px below TOL) shows stronger mid-layer climb rate and cloud %.
    const midThermalRatio = (1800 - scene.floorM) / (scene.topM - scene.floorM);
    const midThermalY = scene.bottom - midThermalRatio * scene.plotHeight;
    host.dispatchEvent(Object.assign(new Event('pointerdown'), {
      pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: scene.hours[0].x, clientY: tolY,
    }));
    host.dispatchEvent(Object.assign(new Event('pointermove'), {
      pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: scene.hours[0].x, clientY: midThermalY,
    }));
    host.dispatchEvent(Object.assign(new Event('pointerup'), {
      pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: scene.hours[0].x, clientY: midThermalY,
    }));
    expect(badge.textContent).toBe('ALTITUDE');
    expect(badge.textContent).not.toContain('drag');
    expect(agl.textContent).toMatch(/^\d+ m AGL$/);
    expect(agl.textContent).not.toContain('model AGL');
    expect(tolRing.getAttribute('visibility')).toBe('visible');
    expect(meteo.textContent).not.toMatch(/\(\d+°\)/);
    expect(soar.textContent).toMatch(/Climb \+\d+\.\d m\/s · Cloud 35%/);
    expect(telemetries.at(-1)?.canSnapToTol).toBe(true);
    expect(telemetries.at(-1)?.altChip).toContain('↺ TOL');

    // Uncapped dry TOL hour (frame 1) in imperial formats Peak +XXX fpm.
    const imperialScene = buildWindgramView(site, { unitSystem: 'imperial', compact: false, timeZone: site.site.timeZone, hours: site.hours });
    const imperialReading = readWindgram(imperialScene, 1, imperialScene.hours[1].usableLiftTopM!);
    expect(imperialReading.peakClimbMps).toBeGreaterThan(0);

    // Tapping the ↺ TOL chip action snaps right back onto Top of Lift.
    chart.snapToTol();
    expect(badge.textContent).toBe('★ TOP OF LIFT');
    expect(agl.textContent).toBe('600 m AGL');
    expect(tolRing.getAttribute('visibility')).toBe('hidden');
    expect(telemetries.at(-1)?.snappedToTol).toBe(true);

    // Hovering at the very bottom line of the Windgram jumps to 10 m AGL (where 10 m wind & temp start) instead of 0 m AGL.
    const unpinnedChart = mountWindgram(host as unknown as HTMLElement, {
      view: scene,
      idPrefix: 'magnetic-bottom',
      selectedValidAt: scene.hours[0].validAt,
      inspectionMode: 'magnetic',
    });
    host.dispatchEvent(Object.assign(new Event('pointermove'), {
      pointerType: 'mouse', pointerId: 3, clientX: scene.hours[0].x, clientY: scene.bottom,
    }));
    expect(badge.textContent).toBe('ALTITUDE');
    expect(agl.textContent).toBe('10 m AGL');
    expect(meteo.textContent.length).toBeGreaterThan(0);
    unpinnedChart.dispose();
    chart.dispose();
  });

  it('restores the selected map lift card after hover and blur, and clears it on Escape', () => {
    const { sample, view } = fixture([20, 21]);
    sample.frames[1].layers['usable-lift-msl']!.value = 2200;
    sample.frames[1].layers['usable-lift-agl']!.value = 700;
    const scene = view(sample.frames);
    const cursor = new FakeElement('g');
    const agl = new FakeElement('text');
    const msl = new FakeElement('text');
    const markers = new Map([['[data-windgram-cursor]', cursor], ['[data-cursor-agl]', agl], ['[data-cursor-msl]', msl]]);
    const svg = {
      querySelector: (selector: string) => markers.get(selector) ?? null,
      getScreenCTM: () => ({ inverse: () => ({}) })
    };
    const host = Object.assign(new FakeElement('div'), {
      ownerDocument: {},
      querySelector: (selector: string) => selector === 'svg.windgram' ? svg : null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: scene.width, bottom: scene.height })
    });
    vi.stubGlobal('DOMPoint', class {
      constructor(readonly x: number, readonly y: number) {}
      matrixTransform() { return this; }
    });
    const chart = mountWindgram(host as unknown as HTMLElement, { view: scene, idPrefix: 'lift-card', selectedValidAt: scene.hours[0].validAt });
    const point = (type: string, y = scene.top + 10) => host.dispatchEvent(Object.assign(new Event(type), {
      pointerType: 'mouse', pointerId: 1, clientX: scene.hours[1].x, clientY: y
    }));
    const expectLift = (aglText: string, mslText: string) => {
      expect(cursor.getAttribute('visibility')).toBe('visible');
      expect([agl.textContent, msl.textContent]).toEqual([aglText, mslText]);
    };

    point('pointermove');
    expectLift('700 m AGL', '2200 m MSL');
    point('pointermove', 0);
    expectLift('500 m AGL', '2000 m MSL');
    point('pointermove');
    point('pointerleave');
    expectLift('500 m AGL', '2000 m MSL');
    point('pointerdown');
    point('pointerup');
    host.dispatchEvent(new Event('blur'));
    expectLift('700 m AGL', '2200 m MSL');
    host.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    point('pointerleave');
    expect(cursor.getAttribute('visibility')).toBe('hidden');
    chart.dispose();
  });

  it('renders Option B 2x2 Instrument Tile by default with PG wind thresholds, vario bar, cloud oktas, conditional rain, and pluggable variant swapping', () => {
    expect(classifyParagliderWind(null)).toBe('missing');
    expect(classifyParagliderWind(0.2)).toBe('calm');
    expect(classifyParagliderWind(4.0)).toBe('ok');      // 14.4 km/h (<20 km/h)
    expect(classifyParagliderWind(7.0)).toBe('caution'); // 25.2 km/h (20-30 km/h)
    expect(classifyParagliderWind(9.5)).toBe('danger');  // 34.2 km/h (>30 km/h)
    expect([0, 4, 15, 35, 75, 95].map(cloudOktasSegments)).toEqual([0, 0, 1, 2, 4, 5]);

    const { sample, profile, forecast } = fixture([20, 21]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    frames[0].layers['cloud-cover-total'] = { ...frames[0].layers['sfc-temp-c']!, value: 35 };
    const site = forecast(frames);
    const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, timeZone: site.site.timeZone, hours: site.hours });

    const defaultSvg = renderWindgramSvg(scene);
    expect(defaultSvg).toContain('data-callout-variant="tile-2x2"');
    expect(defaultSvg).toContain('data-tile-wind-arrow=""');
    expect(defaultSvg).toContain('data-tile-climb-fill=""');
    expect(defaultSvg).toContain('data-tile-okta="4"');
    expect(defaultSvg).toContain('data-tile-rain-icon=""');

    const classicSvg = renderWindgramSvg(scene, { calloutVariant: 'classic' });
    expect(classicSvg).toContain('data-callout-variant="classic"');
    expect(classicSvg).toContain('data-cursor-soar=""');
    expect(classicSvg).not.toContain('data-tile-wind-arrow=""');

    // Bind Option B 2x2 DOM nodes directly and verify live painting across dry, caution-wind/rain, and in-cloud states.
    const back = new FakeElement('rect');
    const badgePill = new FakeElement('rect');
    const badge = new FakeElement('text');
    const agl = new FakeElement('text');
    const msl = new FakeElement('text');
    const windBg = new FakeElement('rect');
    const dial = new FakeElement('circle');
    const windArrow = new FakeElement('path');
    const windCalm = new FakeElement('circle');
    const windSpeed = new FakeElement('text');
    const windDir = new FakeElement('text');
    const climbFill = new FakeElement('rect');
    const climbVal = new FakeElement('text');
    const climbSub = new FakeElement('text');
    const cloudBg = new FakeElement('rect');
    const oktas = [0, 1, 2, 3, 4].map(() => new FakeElement('rect'));
    const cloudText = new FakeElement('text');
    const rainBg = new FakeElement('rect');
    const tempEl = new FakeElement('text');
    const rainIcon = new FakeElement('path');
    const hazardEl = new FakeElement('text');
    const tileNodes = new Map<string, FakeElement>([
      ['[data-cursor-back]', back],
      ['[data-tile-badge-pill]', badgePill],
      ['[data-cursor-badge]', badge],
      ['[data-cursor-agl]', agl],
      ['[data-cursor-msl]', msl],
      ['[data-tile-wind-bg]', windBg],
      ['[data-tile-dial]', dial],
      ['[data-tile-wind-arrow]', windArrow],
      ['[data-tile-wind-calm]', windCalm],
      ['[data-tile-wind-speed]', windSpeed],
      ['[data-tile-wind-dir]', windDir],
      ['[data-tile-climb-fill]', climbFill],
      ['[data-tile-climb-val]', climbVal],
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-cloud-bg]', cloudBg],
      ...oktas.map((el, i) => [`[data-tile-okta="${i}"]`, el] as const),
      ['[data-tile-cloud-text]', cloudText],
      ['[data-tile-rain-bg]', rainBg],
      ['[data-tile-temp]', tempEl],
      ['[data-tile-rain-icon]', rainIcon],
      ['[data-tile-hazard]', hazardEl],
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileNodes.get(sel) ?? null,
    } as unknown as ParentNode);

    const baseReading = readWindgram(scene, 0, 1800);
    const dummyTelemetry = {
      timeChip: '3:00 PM', altChip: '★ TOL 500 m AGL', snappedToTol: true, canSnapToTol: false,
      calloutBadge: '★ TOP OF LIFT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: true, chips: [],
    };

    // 1) Flyable wind (270° W blowing East -> downwind arrow rotated 90°), dry sky (rain icon hidden), 35% cloud (2/5 oktas).
    const size = bound.paint({
      aglText: '500 m AGL',
      mslText: '2,000 m MSL',
      useTol: true,
      telemetry: dummyTelemetry,
      reading: { ...baseReading, speedKt: mpsToKnots(4.5), directionDeg: 270, precipitationMmHr: 0, windShear: null },
      unitSystem: 'metric',
    });
    expect(size).toEqual({ width: 178, height: 74 });
    expect(badge.textContent).toBe('★ TOL');
    expect(windArrow.getAttribute('transform')).toBe('translate(16.5 33) rotate(90)');
    expect(windSpeed.textContent).toBe('16 km/h');
    expect(windSpeed.getAttribute('class')).toContain('is-ok');
    expect(windDir.textContent).toBe('W');
    expect(Number(climbFill.getAttribute('height'))).toBeGreaterThan(0);
    expect(oktas.map(el => el.getAttribute('class')?.includes('is-lit') ?? false)).toEqual([true, true, false, false, false]);
    expect(cloudText.textContent).toBe('Cloud 35%');
    expect(rainIcon.getAttribute('visibility')).toBe('hidden');
    expect(hazardEl.textContent).toBe('Dry');

    // 2) Caution wind (25 km/h WNW), active precipitation (0.8 mm/h), freezing air (-2°C), and in-cloud RH >=94%.
    bound.paint({
      aglText: '900 m AGL',
      mslText: '2,400 m MSL',
      useTol: false,
      telemetry: dummyTelemetry,
      reading: {
        ...baseReading,
        speedKt: mpsToKnots(7.0),
        directionDeg: 292.5,
        temperatureF: 28.4,
        cloud: 'humidity',
        cloudCoverTotalPercent: 85,
        precipitationMmHr: 0.8,
      },
      unitSystem: 'metric',
    });
    expect(badge.textContent).toBe('ALT');
    expect(back.getAttribute('class')).toContain('is-caution');
    expect(windBg.getAttribute('class')).toContain('is-caution');
    expect(windDir.textContent).toBe('WNW · Caution');
    expect(cloudBg.getAttribute('class')).toContain('is-cloud');
    expect(cloudText.textContent).toBe('IN CLOUD · 85%');
    expect(tempEl.textContent).toBe('❄ -2°C');
    expect(tempEl.getAttribute('class')).toContain('is-freeze');
    expect(rainIcon.getAttribute('visibility')).toBe('visible');
    expect(hazardEl.textContent).toBe('Rain 0.8 mm/h');

    // 3) Live runtime variant swap via setCalloutVariant.
    const swapHost = new FakeElement('div');
    const mounted = mountWindgram(swapHost as unknown as HTMLElement, {
      view: scene,
      idPrefix: 'swap-callout',
      selectedValidAt: scene.hours[0].validAt,
      inspectionMode: 'magnetic',
    });
    expect(swapHost.innerHTML).toContain('data-callout-variant="tile-2x2"');
    mounted.setCalloutVariant('classic');
    expect(swapHost.innerHTML).toContain('data-callout-variant="classic"');
    mounted.setCalloutVariant('tile-2x2');
    expect(swapHost.innerHTML).toContain('data-callout-variant="tile-2x2"');
    mounted.dispose();
  });

  it('places the floating callout in calm sky pockets away from cursor bullseye and convective dome with hysteresis', () => {
    const bounds = { left: 46, top: 46, right: 616, bottom: 296 };
    const ceilingSamples = [
      { x: 100, ceilingY: 220 },
      { x: 260, ceilingY: 85 },
      { x: 300, ceilingY: 72 },
      { x: 340, ceilingY: 80 },
      { x: 520, ceilingY: 230 },
    ];
    // Cursor at high convective peak (x=300, y=72): callout avoids covering (300, 72) and avoids sitting inside the high dome.
    const peakPlaced = placeWindgramCallout({
      cursorX: 300,
      cursorY: 72,
      width: 178,
      height: 74,
      bounds,
      ceilingSamples,
      preferredSide: 'right',
    });
    const overlapsCursor =
      300 >= peakPlaced.x - 8 && 300 <= peakPlaced.x + 178 + 8 &&
      72 >= peakPlaced.y - 8 && 72 <= peakPlaced.y + 74 + 8;
    expect(overlapsCursor).toBe(false);
    expect(peakPlaced.x).toBeGreaterThanOrEqual(bounds.left + 4);
    expect(peakPlaced.x + 178).toBeLessThanOrEqual(bounds.right - 4);

    // Hysteresis keeps preferredSide steady across symmetric sky pockets.
    const flatSamples = [{ x: 150, ceilingY: 230 }, { x: 450, ceilingY: 230 }];
    const rightPref = placeWindgramCallout({ cursorX: 330, cursorY: 210, width: 178, height: 74, bounds, ceilingSamples: flatSamples, preferredSide: 'right' });
    const leftPref = placeWindgramCallout({ cursorX: 330, cursorY: 210, width: 178, height: 74, bounds, ceilingSamples: flatSamples, preferredSide: 'left' });
    expect(rightPref.side).toBe('right');
    expect(leftPref.side).toBe('left');
  });

  it('stitches 3 daylight panels with zero plotHeight/plotWidth shrinkage, midnight isolation, interact-only hover, and chip-free bar controls', () => {
    // 3 days of daylight hours in Etc/GMT+5 (14..21 UTC = 09:00..16:00 local)
    const day1 = [14, 16, 18, 20];
    const day2 = [38, 40, 42, 44];
    const day3 = [62, 64, 66, 68];
    const day4 = [86, 88, 90];
    const { build, sample, profile, forecast } = fixture([...day1, ...day2, ...day3, ...day4], 15);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));
    // Make Day 2 the clear best soaring day, and Day 3 strong but blown out by 45 km/h (12.5 m/s) gale surface winds.
    for (const i of [4, 5, 6, 7]) {
      frames[i]!.layers['usable-lift-msl']!.value = 2650;
      frames[i]!.layers['usable-lift-agl']!.value = 1150;
      frames[i]!.layers['thermal-velocity']!.value = 2.8;
    }
    for (const i of [8, 9, 10, 11]) {
      frames[i]!.layers['usable-lift-msl']!.value = 2750;
      frames[i]!.layers['usable-lift-agl']!.value = 1250;
      frames[i]!.layers['thermal-velocity']!.value = 2.9;
    }
    const site = forecast(frames);
    const allDays = [...new Set(site.hours.map(h => h.validAt.slice(0, 10)))];
    expect(allDays.length).toBeGreaterThanOrEqual(3);
    const win3 = resolveStitchedDayWindow(allDays, { focusDayKey: allDays[0] });
    expect(win3.windowDays).toHaveLength(3);
    expect(formatDayWindowLabel(win3.windowDays)).toContain('–');

    const hoursByDay = new Map(allDays.map(d => [d, site.hours.filter(h => h.validAt.startsWith(d)).map(h => ({ validAt: h.validAt }))]));
    const fhMap = new Map(site.hours.map(h => [h.validAt, {
      usableLiftTopM: h.mapLift.mslM,
      terrainM: h.mapLift.terrainM,
      thermalVelocityMps: h.thermalVelocityMps,
      surfaceWindMps: h.validAt.startsWith(allDays[2]!) ? 12.5 : h.surface.windSpeedMps,
    }]));
    expect(findBestSoaringDayKey(allDays.slice(0, 3), hoursByDay, fhMap)).toBe(allDays[1]);

    const oneDay = buildWindgramView(site, {
      unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: site.site.timeZone,
      widthPx: 620, heightPx: 320, hours: { timeZone: site.site.timeZone, dateKey: allDays[0]! },
    });
    const threeDay = buildStitchedWindgramView(site, {
      unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: site.site.timeZone,
      widthPx: 620, heightPx: 320, dateKeys: win3.windowDays, selectedDateKey: allDays[0], bestDateKey: allDays[1],
    });
    const threeDayInternal = sceneData(threeDay);
    // Zero shrinkage guarantee: 3-Day stitched view preserves identical plotHeight, plotWidth, top, and bottom.
    expect(threeDay.plotHeight).toBe(oneDay.plotHeight);
    expect(threeDay.plotWidth).toBe(oneDay.plotWidth);
    expect(threeDay.top).toBe(oneDay.top);
    expect(threeDay.bottom).toBe(oneDay.bottom);
    expect(threeDayInternal.dayPanels).toHaveLength(3);

    const stitchedSvg = renderWindgramSvg(threeDay);
    expect(stitchedSvg).toContain('windgram-stitched');
    expect(stitchedSvg.match(/data-night-seam/g)).toHaveLength(2);
    expect(stitchedSvg.match(/data-windgram-day=/g)).toHaveLength(3);
    // Each stitched day panel places its own isotherm temperature callout pills independently.
    const labelRects = [...stitchedSvg.matchAll(/class="wg-temperature-label"[^>]*><rect x="([^"]+)"/g)].map(m => Number(m[1]));
    for (const panel of threeDayInternal.dayPanels!) {
      expect(labelRects.some(x => x >= panel.left && x <= panel.left + panel.width)).toBe(true);
    }
    // Usable lift path has 3 separate M subpaths (never connected across midnight).
    const liftPath = threeDayInternal.series.find(s => s.key === 'usableLiftTopM')?.path ?? '';
    expect(liftPath.match(/M/g)).toHaveLength(3);

    // Verify 3-Day default mode, initial today/first-day window anchoring even when Day 4 is selected on timeline,
    // chip-free bar, 0% resting clobber ('interact' trigger), 3d <-> 1d toggle, and stable SVG across cross-day selection.
    const head = new FakeElement('head');
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: Object.assign(new EventTarget(), {
        getComputedStyle: () => ({ maxHeight: '300px' }),
      }),
    };
    const root = owner.createElement('div');
    const onFrame = vi.fn();
    const onViewModeChange = vi.fn();
    const onVisibleDaysChange = vi.fn();
    // Omit viewMode -> defaults to '3d'; pass Day 4 frame (frames[12]) -> still opens starting on first day (win3.windowDays)!
    const update = renderPointWindgram(root as unknown as HTMLElement, { frames }, build, {
      point, frameId: frames[12]!.id, unitSystem: 'metric',
      onFrame, onViewModeChange, onVisibleDaysChange,
    });
    const bar = visit(root).find(el => el.className === 'av-windgram-bar')!;
    expect(bar.children).toHaveLength(2);
    const barText = visit(bar).map(el => el.textContent).join(' ');
    expect(barText).toContain('1-Day');
    expect(barText).toContain('3-Day');
    expect(barText).not.toContain('Sfc ');
    expect(barText).not.toContain('Cloud ');
    const host = visit(root).find(el => el.className === 'av-windgram-host')!;
    // Defaults to stitched 3-day view anchored to first/today window despite Day 4 timeline selection.
    expect(host.innerHTML).toContain('windgram-stitched');
    expect(onVisibleDaysChange).toHaveBeenLastCalledWith(win3.windowDays);
    // At rest in 'interact' mode, cursor group starts hidden (0% chart covered).
    expect(host.innerHTML).toContain('data-windgram-cursor="" visibility="hidden"');

    // Toggle to '1-Day' and back to '3-Day'.
    const btn1d = visit(bar).find(el => el.getAttribute('data-point-view') === '1d')!;
    const btn3d = visit(bar).find(el => el.getAttribute('data-point-view') === '3d')!;
    btn1d.dispatchEvent(new Event('click'));
    expect(onViewModeChange).toHaveBeenCalledExactlyOnceWith('1d');
    expect(host.innerHTML).not.toContain('windgram-stitched');
    btn3d.dispatchEvent(new Event('click'));
    expect(onViewModeChange).toHaveBeenLastCalledWith('3d');
    expect(host.innerHTML).toContain('windgram-stitched');

    // Jump back to Day 1 so win3 is active, then verify selecting Day 2 inside the same 3-day window does NOT rebuild host.innerHTML.
    update(frames[0]!.id);
    expect(onVisibleDaysChange).toHaveBeenLastCalledWith(win3.windowDays);
    const htmlSpy = vi.fn();
    let currentSvg = host.innerHTML;
    Object.defineProperty(host, 'innerHTML', {
      get: () => currentSvg,
      set: (next: string) => { htmlSpy(); currentSvg = next; },
    });
    update(frames[5]!.id);
    expect(htmlSpy).not.toHaveBeenCalled();

    disposePointWindgram(root as unknown as HTMLElement);
    expect(onVisibleDaysChange).toHaveBeenLastCalledWith(null);
  });
});
