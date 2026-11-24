import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileResponseSchema, SUPPORT_CUMULUS } from '@av/contracts';
import { dewpointFromGfsV16RhC, dewPointFromSpecificHumidityC, dewpointFromTempAndRhC } from '@av/thermodynamics';
import { formatPointMapLift, type PointFrame } from '@av/client';
import { fixturePointSample, fixtureProfileBuild, fixtureProfileResponse } from '../../../tests/client-point-fixture.ts';
import { mountWindgram } from './dom.ts';
import { disposePointWindgram, renderPointWindgram } from './point-windgram.ts';
import { buildStitchedWindgramView, buildWindgramView, createPointForecast, readWindgram, resolveCivilTimeZone } from './model.ts';
import { findBestSoaringDayKey, formatDayWindowLabel, resolveStitchedDayWindow } from './point-view-mode.ts';
import { sceneData } from './scene-store.ts';
import { localDateKey } from './internal-meteo.ts';
import { renderWindgramKey, renderWindgramSvg } from './svg.ts';
import { buildWindgramTelemetry, formatWindgramReading } from './windgram-readout.ts';

import { barbGeometry, displayedBarbSpeed, quantizedBarbSpeed } from './wind-barb.ts';
import {
  analyzeHourCloudLayers,
  classifyConvectiveCloudRegime,
  omegaToVerticalVelocityMps,
  skyCoverageCode,
  windBarbSpeedColor,
} from './windgram-atmosphere.ts';
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
    expect(result.site.timeZone).toBe('America/New_York');
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
    expect(readWindgram(scene, 0, 1900)).toMatchObject({ heightAglM: null, heightAglReference: null, speedKt: null });
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

  it('formats WMO-aligned horizontal wind thresholds in displayed units without adjectives while keeping knot feather increments', () => {
    const metric = renderWindgramKey('metric'), imperial = renderWindgramKey('imperial');
    expect(metric).toContain('Wind · half 5 / full 10 / flag 50 kt');
    expect(metric).toContain('Green wind is below 23.2 km/h · yellow ≥32 km/h · red ≥51 km/h · magenta ≥88 km/h');
    expect(metric).toContain('Cu &amp; OD');
    expect(metric).not.toContain('Cb');
    expect(metric).not.toContain('⚡');
    expect(metric).not.toMatch(/amber\/red strong/i);
    expect(imperial).toContain('Wind · half 5 / full 10 / flag 50 kt');
    expect(imperial).toContain('Green wind is below 14.4 mph · yellow ≥20 mph · red ≥32 mph · magenta ≥55 mph');
    expect(imperial).not.toMatch(/amber\/red strong/i);
    expect(renderWindgramKey('metric', false, 'lapse')).toContain('Green wind is below 16.7 km/h');
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
    const { build, sample, profile } = fixture([20, 21]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    frames[0].layers['usable-lift-msl']!.value = 2100;
    frames[0].layers['usable-lift-agl']!.value = 600;
    frames[0].layers['cloud-cover-total'] = { ...frames[0].layers['sfc-temp-c']!, value: 35 };
    const site = createPointForecast(build, point, {
      siteTerrain: {
        elevationM: 1500,
        status: 'valid',
        interpolated: true,
        surfaceId: 'gfs-fine',
        surface: 'DSM',
        verticalDatum: 'EGM2008',
      },
    })(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
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

  it('renders Option B 2x2 Instrument Tile by default with WMO 2.5+5n kt wind tiers, surface-only gusts, METAR sky code + Clear vs Whiteout disambiguation, dewpoint, dual-halo crosshairs, and pluggable variant swapping', () => {
    expect(classifyParagliderWind(null)).toBe('missing');
    expect(classifyParagliderWind(1.0)).toBe('calm');      // 1.9 kt (<2.5 kt WMO calm circle)
    expect(classifyParagliderWind(5.5)).toBe('ok');        // 10.7 kt (2.5–12.5 kt: 5 & 10 kt barbs green)
    expect(classifyParagliderWind(7.5)).toBe('moderate');  // 14.6 kt (12.5–17.5 kt: 15 kt barb white)
    expect(classifyParagliderWind(13.0)).toBe('caution');  // 25.3 kt (17.5–27.5 kt: 20 & 25 kt barbs yellow)
    expect(classifyParagliderWind(16.0)).toBe('danger');   // 31.1 kt (27.5–47.5 kt: 30–45 kt barbs coral)
    expect(classifyParagliderWind(26.0)).toBe('pennant');  // 50.5 kt (>=47.5 kt: 50+ kt WMO pennant magenta)
    expect([0, 4, 15, 35, 75, 95].map(cloudOktasSegments)).toEqual([0, 0, 1, 2, 4, 5]);
    expect([0, 5, 18, 40, 72, 95].map(skyCoverageCode)).toEqual(['CLR', 'CLR', 'FEW', 'SCT', 'BKN', 'OVC']);

    const { sample, profile, forecast } = fixture([20, 21]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    frames[0].layers['cloud-cover-total'] = { ...frames[0].layers['sfc-temp-c']!, value: 35 };
    const site = forecast(frames);
    const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, timeZone: site.site.timeZone, hours: site.hours });

    const defaultSvg = renderWindgramSvg(scene);
    expect(defaultSvg).toContain('windgram-hybrid');
    expect(defaultSvg).toContain('data-callout-variant="tile-2x2"');
    expect(defaultSvg).toContain('data-cursor-vertical-halo=""');
    expect(defaultSvg).toContain('data-cursor-horizontal-halo=""');
    expect(defaultSvg).toContain('data-cursor-point-halo=""');
    expect(defaultSvg).toContain('data-tile-wind-arrow=""');
    expect(defaultSvg).toContain('data-tile-climb-fill=""');
    expect(defaultSvg).toContain('data-tile-okta="4"');
    expect(defaultSvg).toContain('data-tile-sky-code=""');
    expect(defaultSvg).toContain('data-tile-dewpoint=""');
    expect(defaultSvg).toContain('data-tile-rain-icon=""');

    const classicSvg = renderWindgramSvg(scene, { calloutVariant: 'classic' });
    expect(classicSvg).toContain('data-callout-variant="classic"');
    expect(classicSvg).toContain('data-cursor-soar=""');
    expect(classicSvg).not.toContain('data-tile-wind-arrow=""');

    // Bind Option B 2x2 DOM nodes directly and verify live painting across dry, surface-gust, caution-wind/rain, and in-cloud states.
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
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const rainBg = new FakeElement('rect');
    const tempEl = new FakeElement('text');
    const dewpointEl = new FakeElement('text');
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
      ['[data-tile-sky-code]', skyCodeEl],
      ['[data-tile-cloud-text]', cloudText],
      ['[data-tile-rain-bg]', rainBg],
      ['[data-tile-temp]', tempEl],
      ['[data-tile-dewpoint]', dewpointEl],
      ['[data-tile-rain-icon]', rainIcon],
      ['[data-tile-hazard]', hazardEl],
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileNodes.get(sel) ?? null,
    } as unknown as ParentNode);

    const baseReading = readWindgram(scene, 0, 1800);
    const dummyTelemetry = {
      timeChip: '3:00 PM', altChip: '★ TOL 500 m AGL', snappedToTol: true, canSnapToTol: false,
      calloutBadge: '★ TOP OF LIFT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: true,
    };

    // 1) Flyable wind (270° W blowing East -> downwind arrow rotated 90°), clear air under SCT 35% sky, dewpoint Td 2°, no surface gust aloft at 300 m AGL.
    const size = bound.paint({
      aglText: '500 m AGL',
      mslText: '2,000 m MSL',
      useTol: true,
      telemetry: dummyTelemetry,
      reading: { ...baseReading, heightAglM: 300, speedKt: mpsToKnots(4.5), gustKt: 22, directionDeg: 270, precipitationMmHr: 0, windShear: null },
      unitSystem: 'metric',
    });
    expect(size).toEqual({ width: 204, height: 74 });
    expect(badge.textContent).toBe('★ TOL');
    expect(windArrow.getAttribute('transform')).toBe('translate(16.5 33) rotate(90)');
    expect(windSpeed.textContent).toBe('16 km/h');
    expect(windSpeed.getAttribute('class')).toContain('is-ok');
    expect(windDir.textContent).toBe('W · Sfc G41');
    expect(Number(climbFill.getAttribute('height'))).toBeGreaterThan(0);
    expect(oktas.map(el => el.getAttribute('class')?.includes('is-lit') ?? false)).toEqual([true, true, false, false, false]);
    expect(skyCodeEl.textContent).toBe('SCT 35%');
    expect(cloudText.textContent).toBe('Clear · RH 50%');
    expect(dewpointEl.textContent).toBe('Td 2°');
    expect(rainIcon.getAttribute('visibility')).toBe('hidden');
    expect(hazardEl.textContent).toBe('Dry');

    // 1b) Near-surface launch hover (<=150 m AGL) surfaces 10m gusts (W · G41) and promotes caution border without inventing upper-air gusts.
    bound.paint({
      aglText: '80 m AGL',
      mslText: '1,580 m MSL',
      useTol: false,
      telemetry: dummyTelemetry,
      reading: { ...baseReading, heightAglM: 80, speedKt: 10, gustKt: 22, directionDeg: 270, precipitationMmHr: 0, windShear: null },
      unitSystem: 'metric',
    });
    expect(windDir.textContent).toBe('W · G41');
    expect(back.getAttribute('class')).toContain('is-caution');

    // 2) Yellow-tier wind (20.4 kt / 38 km/h WNW — zero adjectives!), active precipitation (0.8 mm/h), freezing air (-2°C), and saturated IMC whiteout (RH >=94%).
    bound.paint({
      aglText: '900 m AGL',
      mslText: '2,400 m MSL',
      useTol: false,
      telemetry: dummyTelemetry,
      reading: {
        ...baseReading,
        heightAglM: 900,
        speedKt: mpsToKnots(10.5),
        gustKt: 24,
        directionDeg: 292.5,
        temperatureF: 28.4,
        dewPointC: -2.4,
        relativeHumidityPercent: 96,
        cloudHumidityPercent: 96,
        cloud: 'humidity',
        cloudCoverTotalPercent: 85,
        precipitationMmHr: 0.8,
      },
      unitSystem: 'metric',
    });
    expect(badge.textContent).toBe('ALT');
    expect(back.getAttribute('class')).toContain('is-caution');
    expect(windBg.getAttribute('class')).toContain('is-caution');
    expect(windDir.textContent).toBe('WNW · Sfc G44');
    expect(windDir.textContent).not.toMatch(/Caution|Strong/i);
    expect(cloudBg.getAttribute('class')).toContain('is-cloud');
    expect(skyCodeEl.textContent).toBe('OVC');
    expect(cloudText.textContent).toBe('☁ In cloud · RH 96%');
    expect(tempEl.textContent).toBe('❄ -2°C');
    expect(dewpointEl.textContent).toBe('Td -2°');
    expect(tempEl.getAttribute('class')).toContain('is-freeze');
    expect(rainIcon.getAttribute('visibility')).toBe('visible');
    expect(hazardEl.textContent).toBe('0.8 mm/h · ❄ Icing risk');

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

  it('models cloud depth, FEW/SCT/BKN/OVC scatteredness, multi-layer cloud decks, high cirrus vs low OVC, and Clear vs Whiteout/Cu-tower hover states', () => {
    const { build, sample, profile } = fixture([15, 17, 19], 3);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));

    // Hour 0 (15Z): Two distinct stratiform layers inside soaring domain (low OVC valley stratus 1700..1950m, clear slot at 2250m, mid SCT/BKN altocumulus 2650..3050m), w* = 0
    frames[0]!.layers['usable-lift-msl']!.value = null;
    frames[0]!.layers['usable-lift-msl']!.status = 'no-usable-lift';
    frames[0]!.layers['usable-lift-agl']!.value = 0;
    frames[0]!.layers['usable-lift-agl']!.status = 'no-usable-lift';
    frames[0]!.layers['thermal-velocity']!.value = 0;
    frames[0]!.layers['cloud-cover-low']!.value = 90;
    frames[0]!.layers['cloud-cover-total']!.value = 92;
    frames[0]!.profile.levels = [
      { pressureHpa: 900, heightM: 1700, temperatureC: 10, dewPointC: 9.8, uWindMps: 3, vWindMps: 2, omegaPaS: 0 },   // ~99% RH (OVC stratus)
      { pressureHpa: 875, heightM: 1950, temperatureC: 8.5, dewPointC: 8.0, uWindMps: 4, vWindMps: 2, omegaPaS: 0 },  // ~97% RH
      { pressureHpa: 845, heightM: 2250, temperatureC: 7.0, dewPointC: -4.0, uWindMps: 5, vWindMps: 3, omegaPaS: 0 }, // ~45% RH (clear VMC window!)
      { pressureHpa: 805, heightM: 2650, temperatureC: 2.0, dewPointC: -0.2, uWindMps: 7, vWindMps: 4, omegaPaS: 0 }, // ~85% RH (SCT/BKN alto deck)
      { pressureHpa: 765, heightM: 3050, temperatureC: -1.0, dewPointC: -3.0, uWindMps: 8, vWindMps: 5, omegaPaS: 0 }, // ~86% RH
    ];

    // Hour 1 (17Z): Towering SCT Cumulus (base = 2200 m, parcel top = 3450 m -> 1,250 m deep, w* = 2.8 m/s, cloud-cover-low = 38%) + Cloud suck!
    frames[1]!.layers['usable-lift-msl']!.value = 2200;
    frames[1]!.layers['usable-lift-agl']!.value = 700;
    frames[1]!.layers['surface-lcl-msl'] = { ...frames[1]!.layers['sfc-temp-c']!, value: 2200 };
    frames[1]!.layers['thermal-top-msl']!.value = 3450;
    frames[1]!.layers['thermal-velocity']!.value = 2.8;
    frames[1]!.layers['cloud-cover-low']!.value = 38;
    frames[1]!.layers['cloud-cover-total']!.value = 38;
    frames[1]!.derived.effectiveCloudLimitM = 2200;
    frames[1]!.derived.cuPotentialM = 1250;
    frames[1]!.derived.cloudCapped = true;
    frames[1]!.derived.overdeveloped = false;

    // Hour 2 (19Z): Sunny blue thermals with strong BL shear (buoyancyShearRatio = 0.28 -> B/S 3) under 95% High Cirrus ONLY (cloud-cover-low = 0%, dry column)
    frames[2]!.layers['usable-lift-msl']!.value = 2400;
    frames[2]!.layers['usable-lift-agl']!.value = 900;
    frames[2]!.layers['thermal-top-msl']!.value = 2550;
    frames[2]!.layers['surface-lcl-msl'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 3500 };
    frames[2]!.layers['thermal-velocity']!.value = 2.0;
    frames[2]!.layers['cloud-cover-low']!.value = 0;
    frames[2]!.layers['cloud-cover-total']!.value = 95;
    frames[2]!.derived.effectiveCloudLimitM = 3500;
    frames[2]!.derived.cloudCapped = false;
    frames[2]!.derived.overdeveloped = false;
    frames[2]!.derived.buoyancyShearRatio = 0.28;

    const site = createPointForecast(build, point)(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const scene = buildWindgramView(site, {
      unitSystem: 'metric',
      compact: false,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      hours: site.hours,
    });
    const svg = renderWindgramSvg(scene);

    // Chart SVG renders patterned SCT/BKN & solid OVC stratiform decks, Cu base glyph (no vertical tower boxes), and HI OVC cirrus badge!
    expect(svg).toContain('class="wg-cloud-deck-sct"');
    expect(svg).toContain('class="wg-cloud-deck-ovc"');
    expect(svg).toContain('data-cumulus="cu"');
    expect(svg).not.toContain('data-cu-tower=');
    expect(svg).toContain('data-sky-high="true"');
    expect(svg).toContain('>HI OVC<');

    // Direct multi-layer analysis verification on Hour 0
    const h0Analysis = analyzeHourCloudLayers(site.hours[0], hourSampling(site.hours[0]!), scene.topM);
    expect(h0Analysis.layers).toHaveLength(2);
    expect(h0Analysis.layers[0]!.saturated).toBe(true);
    expect(h0Analysis.layers[1]!.saturated).toBe(false);

    // Bind tile-2x2 and verify hover states across all 3 hours
    const climbSub = new FakeElement('text');
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const cloudBg = new FakeElement('rect');
    const hazardEl = new FakeElement('text');
    const oktas = [0, 1, 2, 3, 4].map(() => new FakeElement('rect'));
    const tileMap = new Map<string, FakeElement>([
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-sky-code]', skyCodeEl],
      ['[data-tile-cloud-text]', cloudText],
      ['[data-tile-cloud-bg]', cloudBg],
      ['[data-tile-hazard]', hazardEl],
      ...oktas.map((el, i) => [`[data-tile-okta="${i}"]`, el] as const),
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileMap.get(sel) ?? null,
    } as unknown as ParentNode);
    const dummyTel = {
      timeChip: '12:00 PM', altChip: '', snappedToTol: false, canSnapToTol: false,
      calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false,
    };

    // a) Hour 0 at 1,820 m (inside lower saturated OVC stratus): 'OVC 100%' + '☁ In cloud · ... m'
    const inLowOvc = readWindgram(scene, 0, 1820);
    bound.paint({ aglText: '320 m AGL', mslText: '1,820 m MSL', useTol: false, telemetry: dummyTel, reading: inLowOvc, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).toBe('OVC 100%');
    expect(cloudText.textContent).toMatch(/^☁ In cloud · \d+ m$/);
    expect(cloudBg.getAttribute('class')).toContain('is-cloud');

    // b) Hour 0 at 2,250 m (clear VMC slot between low OVC deck and mid SCT/BKN deck): '2 LYR' + 'Clear · Base +...' + 'Dry · 2 layers' when precip is 0
    const betweenLayers = readWindgram(scene, 0, 2250);
    bound.paint({ aglText: '750 m AGL', mslText: '2,250 m MSL', useTol: false, telemetry: dummyTel, reading: { ...betweenLayers, precipitationMmHr: 0 }, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).toBe('2 LYR');
    expect(cloudText.textContent).toMatch(/^Clear · Base \+\d+ m$/);
    expect(cloudBg.getAttribute('class')).not.toContain('is-cloud');
    expect(hazardEl.textContent).toBe('Dry · 2 layers');

    // c) Hour 0 at 2,850 m (inside upper non-saturated altocumulus band): '☁ SCT/BKN deck · ... m'
    const inMidDeck = readWindgram(scene, 0, 2850);
    bound.paint({ aglText: '1,350 m AGL', mslText: '2,850 m MSL', useTol: false, telemetry: dummyTel, reading: inMidDeck, unitSystem: 'metric' });
    expect(cloudText.textContent).toMatch(/^☁ (SCT|BKN) deck · \d+ m$/);
    expect(cloudBg.getAttribute('class')).toContain('is-cloud');

    // d) Hour 1 below Cu base (1,850 m), at ★ TOL Cu base (2,200 m), and inside towering Cu (2,650 m)
    const belowCu = readWindgram(scene, 1, 1850);
    bound.paint({ aglText: '350 m AGL', mslText: '1,850 m MSL', useTol: false, telemetry: dummyTel, reading: belowCu, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).toBe('SCT 38%');
    expect(cloudText.textContent).toBe('Clear · Base +350 m');

    const atCuTol = readWindgram(scene, 1, 2200);
    bound.paint({ aglText: '700 m AGL', mslText: '2,200 m MSL', useTol: true, telemetry: dummyTel, reading: atCuTol, unitSystem: 'metric' });
    expect(climbSub.textContent).toBe('▲ Cu base');
    expect(cloudText.textContent).toBe('Cu base · 1,250 m deep');
    expect(hazardEl.textContent).toBe('⚠ Cloud suck');

    const inCuTower = readWindgram(scene, 1, 2650);
    bound.paint({ aglText: '1,150 m AGL', mslText: '2,650 m MSL', useTol: false, telemetry: dummyTel, reading: inCuTower, unitSystem: 'metric' });
    expect(climbSub.textContent).toBe('☁ In Cu tower');
    expect(skyCodeEl.textContent).toBe('SCT Cu');
    expect(cloudText.textContent).toBe('☁ In Cu · 1,250 m deep');
    expect(hazardEl.textContent).toBe('⚠ Cloud suck');

    // e) Hour 2 at 1,900 m (sheared thermal under 95% high cirrus only): 'HI 95%' + 'Clear · High cirrus' + '▲ Sheared lift' + 'B/S 3 · Sheared'
    const underHighCirrus = readWindgram(scene, 2, 1900);
    bound.paint({ aglText: '400 m AGL', mslText: '1,900 m MSL', useTol: false, telemetry: dummyTel, reading: underHighCirrus, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).toBe('HI 95%');
    expect(cloudText.textContent).toBe('Clear · High cirrus');
    expect(oktas[0]!.getAttribute('class')).toContain('is-high');
    expect(climbSub.textContent).toBe('▲ Sheared lift');
    expect(hazardEl.textContent).toBe('B/S 3 · Sheared');
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
    // Usable lift path has 3 separate per-day M subpaths.
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

  it('renders Concept 1 hybrid-climb physics by default: Lenschow climb dome bounded by TOL, inversion lids, contoured RH cloud decks, OVC ceiling strip, active Cu only at LCL, no root SVG title tooltip, and pluggable lapse mode', () => {
    const day1 = [14, 16, 18, 20];
    const day2 = [38, 40, 42, 44];
    const { sample, profile, forecast } = fixture([...day1, ...day2], 8);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));

    // Day 1: morning surface inversion at 14Z (7a/9a), strong Cu-capped afternoon thermal at 18Z (thermalTop=2850 >= LCL=2800), and 100% high overcast at 18Z-20Z.
    frames[0]!.layers['usable-lift-msl']!.value = null;
    frames[0]!.layers['usable-lift-msl']!.status = 'no-usable-lift';
    frames[0]!.layers['usable-lift-agl']!.value = 0;
    frames[0]!.layers['usable-lift-agl']!.status = 'no-usable-lift';
    frames[0]!.layers['thermal-velocity']!.value = 0;
    // Create a true morning temperature inversion (+2°C warmer at 1800m than 2m surface)
    frames[0]!.layers['sfc-temp-c']!.value = 8;
    frames[0]!.profile.levels[0]!.temperatureC = 11;

    // Peak afternoon hour (index 2): strong w* = 2.4 m/s reaching effectiveCloudLimitM (2800m) + 100% total sky cover
    frames[2]!.layers['usable-lift-msl']!.value = 2800;
    frames[2]!.layers['usable-lift-agl']!.value = 1300;
    frames[2]!.layers['thermal-top-msl']!.value = 2850;
    frames[2]!.layers['surface-lcl-msl'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 2800 };
    frames[2]!.layers['thermal-velocity']!.value = 2.4;
    frames[2]!.layers['cloud-cover-total']!.value = 100;
    frames[3]!.layers['cloud-cover-total']!.value = 95;

    // Day 2: completely dead overcast day (w* = 0, no usable lift, saturated RH >= 95% cloud layer, and an elevated unstable lapse layer aloft that must NOT paint a false thermal blob!)
    for (const i of [4, 5, 6, 7]) {
      frames[i]!.layers['usable-lift-msl']!.value = null;
      frames[i]!.layers['usable-lift-msl']!.status = 'no-usable-lift';
      frames[i]!.layers['usable-lift-agl']!.value = 0;
      frames[i]!.layers['usable-lift-agl']!.status = 'no-usable-lift';
      frames[i]!.layers['thermal-velocity']!.value = 0;
      frames[i]!.layers['cloud-cover-total']!.value = 100;
      // Saturated overcast cloud layer at 2400..3000m (T === Td)
      frames[i]!.profile.levels[1]!.dewPointC = frames[i]!.profile.levels[1]!.temperatureC;
      frames[i]!.profile.levels[2]!.dewPointC = frames[i]!.profile.levels[2]!.temperatureC;
    }

    const site = forecast(frames);
    const allDays = [...new Set(site.hours.map(h => h.validAt.slice(0, 10)))];

    // 1) Stitched 2-day hybrid-climb default scene
    const stitched = buildStitchedWindgramView(site, {
      unitSystem: 'imperial',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      widthPx: 620,
      heightPx: 320,
      dateKeys: allDays,
    });
    const internal = sceneData(stitched);
    expect(internal.fieldMode).toBe('hybrid-climb');

    // Day 1 has climb dome paths & morning inversion; Day 2 (dead overcast) has ZERO climb paths inside its x-span!
    const climbFields = internal.fields.filter(f => f.className.startsWith('wg-climb-'));
    expect(climbFields.length).toBeGreaterThanOrEqual(3);
    const day2Left = internal.dayPanels![1]!.left;
    for (const cf of climbFields) {
      const xs = [...cf.path.matchAll(/[ML](-?\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
      expect(xs.every(x => x < day2Left)).toBe(true);
    }
    expect(internal.fields.some(f => f.className.startsWith('wg-inversion-'))).toBe(true);
    expect(internal.cloudDeckFields?.some(f => f.className === 'wg-cloud-deck-ovc')).toBe(true);
    expect(internal.skyCoverSpans?.some(s => s.tier === 'ovc')).toBe(true);

    const svg = renderWindgramSvg(stitched);
    // Root SVG uses aria-label + aria-describedby with NO root <title> tooltip before <desc>.
    expect(svg).toContain('aria-label="Wind, temperature and clouds by hour and altitude"');
    expect(svg).not.toMatch(/<svg[^>]*><title/);
    // High-contrast haloed TOL curve, top OVC sky-cover strip, contoured cloud deck, and active Cu only where lift reaches LCL.
    expect(svg).toContain('class="wg-tol-halo"');
    expect(svg).toContain('class="wg-tol-core"');
    expect(svg).toContain('data-sky-cover="ovc"');
    expect(svg).toContain('>OVC<');
    expect(svg).toContain('class="wg-cloud-deck-ovc"');
    expect(svg).toContain('data-cumulus="cu"');
    expect(svg).not.toContain('class="wg-cloud-potential"');

    // 2) Classic 'lapse' mode remains cleanly swappable via fieldMode: 'lapse'.
    const lapseScene = buildWindgramView(site, {
      unitSystem: 'imperial',
      fieldMode: 'lapse',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      hours: { timeZone: site.site.timeZone, dateKey: allDays[0]! },
    });
    const lapseSvg = renderWindgramSvg(lapseScene);
    expect(lapseSvg).toContain('meteo-gram-stab-');
    expect(lapseSvg).toContain('class="wg-cloud-potential"');
    expect(renderWindgramKey('imperial', true, 'hybrid-climb')).toContain('Net climb · ft/min');
    expect(renderWindgramKey('imperial', true, 'lapse')).toContain('Lapse rate · °F/1,000 ft');
  });

  it('models multi-regime soaring days faithfully: native-tail continuity past mapFrameCount, OD cumulus with zero fake lightning, Scorer-gated mountain wave w(ω), WMO 2.5+5n kt wind barbs, and -20..0°C SLW icing', () => {
    // 1) Exact hydrostatic vertical velocity conversion & WMO 2.5+5n knot wind barb speed coding
    // At 750 hPa, 0°C (273.15 K), ω = -10 Pa/s -> w = (10 * 287.05 * 273.15) / (75000 * 9.80665) ≈ +1.066 m/s (+210 fpm)
    const wWave = omegaToVerticalVelocityMps(-10, 0, 750, 2500);
    expect(wWave).toBeCloseTo(1.066, 2);
    expect(omegaToVerticalVelocityMps(8, 0, 750, 2500)).toBeLessThan(-0.8);
    expect([1.5, 8.5, 11.5, 15, 24, 26, 32, 52].map(windBarbSpeedColor)).toEqual([
      '#78ff78', '#78ff78', '#78ff78', '#ffffff', '#fde047', '#fde047', '#fca5a5', '#e879f9',
    ]);

    // 2) Multi-day forecast where mapFrameCount covers ONLY Day 1 (4 frames), Day 2 is native-tail ('unavailable' fine surface),
    // and Day 3 is a 0-fpm winter mountain-wave day with strong resolved ascent aloft in statically stable air.
    const day1 = [14, 16, 18, 20];
    const day2 = [38, 40, 42, 44];
    const day3 = [62, 64, 66, 68];
    const { build, sample, profile } = fixture([...day1, ...day2, ...day3], 4);
    const sampleMap = new Map(sample.frames.map(f => [f.id, f]));
    const frames = profile.frames.map(frame => {
      const fine = sampleMap.get(frame.id);
      return fine ? { ...frame, layers: { ...frame.layers, ...fine.layers } } : frame;
    });

    // Day 1 afternoon: Frame 2 has OD spreadout (overdeveloped = true, CAPE = 400), Frame 3 has high instability (CAPE = 1450 J/kg) + 30 kt & 52 kt upper winds (no fake lightning!)
    frames[2]!.layers['usable-lift-msl']!.value = 2500;
    frames[2]!.layers['usable-lift-agl']!.value = 1000;
    frames[2]!.layers['thermal-top-msl']!.value = 2600;
    frames[2]!.layers['surface-lcl-msl'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 2450 };
    frames[2]!.layers['thermal-velocity']!.value = 2.2;
    frames[2]!.layers['cape-jkg'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 400 };
    frames[2]!.derived.overdeveloped = true;
    frames[2]!.derived.cloudCapped = true;

    frames[3]!.layers['usable-lift-msl']!.value = 2550;
    frames[3]!.layers['usable-lift-agl']!.value = 1050;
    frames[3]!.layers['thermal-top-msl']!.value = 2700;
    frames[3]!.layers['surface-lcl-msl'] = { ...frames[3]!.layers['sfc-temp-c']!, value: 2500 };
    frames[3]!.layers['thermal-velocity']!.value = 2.6;
    frames[3]!.layers['cape-jkg'] = { ...frames[3]!.layers['sfc-temp-c']!, value: 1450 };
    frames[3]!.derived.overdeveloped = true;
    frames[3]!.derived.cloudCapped = true;

    // Day 2 (indices 4..7): beyond mapFrameCount -> fine usable-lift-msl is 'unavailable', but native w* = 2.3 m/s & thermal-top-msl = 2750 m!
    for (const i of [5, 6]) {
      frames[i]!.layers['thermal-velocity']!.value = 2.3;
      frames[i]!.layers['thermal-top-msl']!.value = 2750;
      frames[i]!.derived.effectiveCloudLimitM = 2900;
    }
    frames[4]!.layers['thermal-velocity']!.value = 0;
    frames[7]!.layers['thermal-velocity']!.value = 0;

    // Day 3 (indices 8..11): 0 fpm winter mountain wave day (w* = 0) with strong 29 kt..52.5 kt upper wind & resolved wave ascent (omegaPaS = -14..-16 Pa/s at 2400..3000m)
    for (const i of [8, 9, 10, 11]) {
      frames[i]!.layers['thermal-velocity']!.value = 0;
      frames[i]!.layers['thermal-top-msl']!.value = 1500;
      frames[i]!.profile.levels[1]!.omegaPaS = -14;
      frames[i]!.profile.levels[1]!.uWindMps = 15; // 29.2 kt (#fca5a5 coral)
      frames[i]!.profile.levels[1]!.vWindMps = 0;
      frames[i]!.profile.levels[2]!.omegaPaS = -16;
      frames[i]!.profile.levels[2]!.uWindMps = 27; // 52.5 kt WMO pennant (#e879f9 magenta)
      frames[i]!.profile.levels[2]!.vWindMps = 0;
    }

    const site = createPointForecast(build, point)(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const allDays = [...new Set(site.hours.map(h => h.validAt.slice(0, 10)))];

    // Verify native-tail Day 2 keeps usableLiftTopM === null while populating nativeUsableLiftTopM, and high CAPE never synthesizes fake 'cb' lightning!
    expect(site.hours[5]!.mapLift.mslM).toBeNull();
    expect(site.hours[5]!.nativeUsableLiftTopM).toBeGreaterThan(2400);
    expect(classifyConvectiveCloudRegime(site.hours[2]!)).toBe('od');
    expect(classifyConvectiveCloudRegime(site.hours[3]!)).toBe('od');

    // Pure native-tail 1-day view on Day 2 scales to soaring ceiling (not 15 km full atmosphere!) and renders climb dome + dashed native ceiling
    const day2Scene = buildWindgramView(site, {
      unitSystem: 'metric',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      hours: { timeZone: site.site.timeZone, dateKey: allDays[1]! },
    });
    expect(day2Scene.topM).toBeLessThan(5000);
    const day2Svg = renderWindgramSvg(day2Scene);
    expect(day2Svg).toContain('class="wg-climb-');
    expect(day2Svg).toContain('data-native-lift-ceiling=""');
    const day2MidReading = readWindgram(day2Scene, 1, 2000);
    expect(day2MidReading.estimatedClimbMps).toBeGreaterThan(1.0);

    // Pure winter wave 1-day view on Day 3 scales to encompass wave lift at 3000 m and renders cyan wave contours without false thermal climb
    const day3Scene = buildWindgramView(site, {
      unitSystem: 'metric',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      hours: { timeZone: site.site.timeZone, dateKey: allDays[2]! },
    });
    expect(day3Scene.topM).toBeGreaterThanOrEqual(3000);
    const day3Svg = renderWindgramSvg(day3Scene);
    expect(day3Svg).toContain('class="wg-wave-lift"');
    expect(day3Svg).toContain('class="wg-wave-strong"');
    expect(day3Svg).not.toContain('class="wg-climb-');
    const waveReading = readWindgram(day3Scene, 1, 2400);
    expect(waveReading.estimatedClimbMps).toBeNull();
    expect(waveReading.waveVelocityMps).toBeGreaterThan(1.2);
    expect(waveReading.lapseCPer1000Ft).toBeGreaterThan(-2.45);

    // Adversarial Scorer check: a dry-adiabatic convective chimney (-3.05 °C/1kft) must NOT emit laminar wave contours!
    const adiabaticFrames = frames.slice(8, 12).map(frame => ({
      ...frame,
      profile: {
        ...frame.profile,
        levels: [
          { ...frame.profile.levels[0]!, heightM: 1800, temperatureC: 18, dewPointC: -4, uWindMps: 14, vWindMps: 0, omegaPaS: -15 },
          { ...frame.profile.levels[1]!, heightM: 2400, temperatureC: 12, dewPointC: -6, uWindMps: 15, vWindMps: 0, omegaPaS: -16 },
          { ...frame.profile.levels[2]!, heightM: 3000, temperatureC: 6, dewPointC: -8, uWindMps: 15, vWindMps: 0, omegaPaS: -16 },
          { ...frame.profile.levels[3]!, heightM: 3600, temperatureC: 0, dewPointC: -10, uWindMps: 15, vWindMps: 0, omegaPaS: -14 },
        ],
      },
    }));
    const adiabaticSite = createPointForecast(build, point)(build.manifest.frames.slice(8, 12), new Map(adiabaticFrames.map(f => [f.id, f])));
    const adiabaticScene = buildWindgramView(adiabaticSite, {
      unitSystem: 'metric',
      compact: true,
      heightRange: 'soaring',
      timeZone: adiabaticSite.site.timeZone,
      hours: adiabaticSite.hours,
    });
    expect(renderWindgramSvg(adiabaticScene)).not.toContain('class="wg-wave-lift"');

    // Stitched 3-day SVG renders OD cloud (zero fake lightning bolts), coral 30kt & magenta 50kt+ wind barbs, dashed native Day 2 ceiling, and Day 3 wave band
    const stitched = buildStitchedWindgramView(site, {
      unitSystem: 'imperial',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      widthPx: 640,
      heightPx: 340,
      dateKeys: allDays.slice(0, 3),
    });
    const stitchedSvg = renderWindgramSvg(stitched);
    expect(stitchedSvg).toContain('data-cumulus="od"');
    expect(stitchedSvg).not.toContain('data-cumulus="cb"');
    expect(stitchedSvg).not.toContain('wg-cloud-cb-bolt');
    expect(stitchedSvg).toContain('wg-barb-danger');
    expect(stitchedSvg).toContain('wg-barb-pennant');
    expect(stitchedSvg).toContain('--wg-wind-danger: #fca5a5');
    expect(stitchedSvg).toContain('--wg-wind-pennant: #e879f9');
    expect(stitchedSvg).not.toContain('style="color:');
    expect(stitchedSvg).toContain('data-native-lift-ceiling=""');
    expect(stitchedSvg).toContain('class="wg-wave-lift"');

    // Verify tile-2x2 hover callout across Cu-base TOL, Wave vs Ascent, -20..0°C SLW icing vs -35°C cirrus, plain CAPE, Inversion, and unit-aware shear
    const climbVal = new FakeElement('text');
    const climbSub = new FakeElement('text');
    const climbFill = new FakeElement('rect');
    const tempEl = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const tileMap = new Map<string, FakeElement>([
      ['[data-tile-climb-val]', climbVal],
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-climb-fill]', climbFill],
      ['[data-tile-temp]', tempEl],
      ['[data-tile-hazard]', hazardEl],
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileMap.get(sel) ?? null,
    } as unknown as ParentNode);
    const dummyTelemetry = {
      timeChip: '2:00 PM', altChip: '', snappedToTol: false, canSnapToTol: false,
      calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false,
    };

    // a) Cu-capped TOL + OD spreadout
    const odTolReading = readWindgram(stitched, 2, 2500);
    bound.paint({ aglText: '3,280 ft AGL', mslText: '8,200 ft MSL', useTol: true, telemetry: dummyTelemetry, reading: odTolReading, unitSystem: 'imperial' });
    expect(climbSub.textContent).toBe('▲ Cu base');
    expect(hazardEl.textContent).toBe('OD spreadout');

    // b) High CAPE instability (plain CAPE text, zero fake lightning bolt!)
    const capeReading = readWindgram(stitched, 3, 2200);
    bound.paint({ aglText: '2,300 ft AGL', mslText: '7,200 ft MSL', useTol: false, telemetry: dummyTelemetry, reading: capeReading, unitSystem: 'imperial' });
    expect(hazardEl.textContent).toBe('CAPE 1450');
    expect(hazardEl.textContent).not.toContain('⚡');

    // c) Neutral model vertical motion ('▲ Model ascent' / '▼ Model descent')
    bound.paint({ aglText: '2,950 ft AGL', mslText: '7,870 ft MSL', useTol: false, telemetry: dummyTelemetry, reading: waveReading, unitSystem: 'imperial' });
    expect(climbSub.textContent).toBe('▲ Model ascent');
    expect(climbFill.getAttribute('class')).toContain('is-wave');
    bound.paint({
      aglText: '2,950 ft AGL', mslText: '7,870 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, lapseCPer1000Ft: -2.9 },
      unitSystem: 'imperial',
    });
    expect(climbSub.textContent).toBe('▲ Model ascent');
    bound.paint({
      aglText: '2,950 ft AGL', mslText: '7,870 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, waveVelocityMps: -1.4 },
      unitSystem: 'imperial',
    });
    expect(climbVal.textContent).toMatch(/^-\d+ fpm$/);
    expect(climbSub.textContent).toBe('▼ Model descent');

    // d) Supercooled liquid water icing (-4°C with liquid RH >= 94% -> '❄ Icing risk') vs -35°C glaciated cirrus (no icing risk)
    bound.paint({
      aglText: '4,000 ft AGL', mslText: '8,900 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, waveVelocityMps: 0, temperatureF: 24.8, relativeHumidityPercent: 96, cloud: 'humidity', precipitationMmHr: 0 },
      unitSystem: 'metric',
    });
    expect(tempEl.textContent).toBe('❄ -4°C');
    expect(hazardEl.textContent).toBe('❄ Icing risk');
    expect(climbSub.textContent).toBe('No thermal');

    bound.paint({
      aglText: '28,000 ft AGL', mslText: '33,000 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, temperatureF: -31, cloud: 'humidity', precipitationMmHr: 0, capeJkg: 0, windShear: null, overdeveloped: false },
      unitSystem: 'metric',
    });
    expect(tempEl.textContent).toBe('❄ -35°C');
    expect(hazardEl.textContent).toBe('Dry');

    // e) Temperature inversion lid & unit-aware vertical wind shear
    bound.paint({
      aglText: '1,200 ft AGL', mslText: '6,100 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, waveVelocityMps: 0, lapseCPer1000Ft: 1.2, cloud: null, relativeHumidityPercent: 42, windShear: null, capeJkg: 0, overdeveloped: false },
      unitSystem: 'imperial',
    });
    expect(climbSub.textContent).toBe('Inversion lid');
    expect(hazardEl.textContent).toBe('Inversion');

    bound.paint({
      aglText: '2,000 ft AGL', mslText: '6,900 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, waveVelocityMps: 0, lapseCPer1000Ft: -1.5, cloud: null, relativeHumidityPercent: 45, windShear: { lowerM: 1800, upperM: 2400, vectorChangeMps: 4.5, perKmMps: 7.5 }, capeJkg: 0, overdeveloped: false },
      unitSystem: 'imperial',
    });
    expect(hazardEl.textContent).toBe('Shear 5.1 mph/kft');
  });

  it('Finding 1: converts liquid-vapor-pressure builds and preserves 2 m and positive-control clouds', () => {
    const { build: normBuild, profile: normProfile } = fixture([18, 20], 2);
    normBuild.manifest.tool.profileDewpointReference = 'liquid-vapor-pressure';
    // Hour 0: Cascades SPFH liquid dewpoints (q = 2.3565e-4 @ 450 hPa, q = 1.0778e-4 @ 400 hPa -> 71.53% / 66.79% mixed-phase RH, no cloud)
    normProfile.frames[0]!.profile.levels = [
      { pressureHpa: 850, heightM: 1500, temperatureC: 2, dewPointC: -8, uWindMps: 5, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 450, heightM: 6200, temperatureC: -34.406195, dewPointC: dewPointFromSpecificHumidityC(0.0002356488985, 450), uWindMps: 14, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 400, heightM: 7050, temperatureC: -41.870703, dewPointC: dewPointFromSpecificHumidityC(0.0001077765628, 400), uWindMps: 16, vWindMps: 0, omegaPaS: 0 },
    ];
    // Hour 1: Positive control (38.75°N, 78.25°W @ 400 hPa: T = -27.19 °C, q = 0.00078861 kg/kg -> 76.45% liquid RH -> ~100% ice cloud)
    normProfile.frames[1]!.profile.levels = [
      { pressureHpa: 820, heightM: 1800, temperatureC: 4, dewPointC: -6, uWindMps: 5, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 400, heightM: 7200, temperatureC: -27.19, dewPointC: dewPointFromSpecificHumidityC(0.00078861, 400), uWindMps: 18, vWindMps: 0, omegaPaS: 0 },
    ];
    const normSite = createPointForecast(normBuild, { lat: 38.75, lon: -78.25 })(normBuild.manifest.frames, new Map(normProfile.frames.map(f => [f.id, f])));
    expect(normSite.hours[0]!.upperAirDewpointReference).toBe('liquid-vapor-pressure');
    const normScene = buildWindgramView(normSite, { unitSystem: 'metric', compact: false, heightRange: 'full', timeZone: normSite.site.timeZone, hours: normSite.hours });
    expect(readWindgram(normScene, 0, 6200).cloud).toBeNull();
    expect(readWindgram(normScene, 0, 6200).cloudHumidityPercent).toBeCloseTo(71.53, 0);
    expect(readWindgram(normScene, 0, 7050).cloudHumidityPercent).toBeCloseTo(66.79, 0);
    const posControl = readWindgram(normScene, 1, 7200);
    expect(posControl.relativeHumidityPercent).toBeCloseTo(76.45, 0);
    expect(posControl.cloudHumidityPercent!).toBeGreaterThan(99);
    expect(posControl.cloud).toBe('humidity');
  });

  it('Finding 2: resolves Mount Ara fine DSM site clearance on interpolated hours, keeps native fallback lift invariant to fine terrain, and labels model AGL when fine terrain is absent', () => {
    const ara = { lat: 40.4186, lon: 44.4547 };
    const { build, sample, profile } = fixture([9, 12, 36], 2);
    build.manifest.model = 'icon-eu';
    const frames = profile.frames.map((frame, i) => {
      const fine = sample.frames[i];
      return fine ? { ...frame, layers: { ...frame.layers, ...fine.layers } } : frame;
    });
    for (const f of frames) f.profile.modelTerrainM = 1794;
    // Hour 0 (mapped, interpolated: true -> pointMapLift.terrainM === null)
    frames[0]!.layers['usable-lift-msl'] = { ...frames[0]!.layers['usable-lift-msl']!, value: 2427.4957, interpolated: true };
    frames[0]!.layers['usable-lift-agl'] = { ...frames[0]!.layers['usable-lift-agl']!, value: 130.2237, interpolated: true };
    // Hour 1 (mapped, no-usable-lift)
    frames[1]!.layers['usable-lift-msl'] = { ...frames[1]!.layers['usable-lift-msl']!, value: null, status: 'no-usable-lift', interpolated: true };
    frames[1]!.layers['usable-lift-agl'] = { ...frames[1]!.layers['usable-lift-agl']!, value: 0, status: 'no-usable-lift', interpolated: true };

    const loadedMap = new Map(frames.map(f => [f.id, f]));
    const araTerrain = {
      elevationM: 2297.272,
      status: 'valid' as const,
      interpolated: true,
      surfaceId: 'gfs-fine',
      surface: 'DSM',
      verticalDatum: 'EGM2008',
    };
    const siteWithDsm = createPointForecast(build, ara, { siteTerrain: araTerrain })(build.manifest.frames, loadedMap);
    const dayScene = buildWindgramView(siteWithDsm, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: siteWithDsm.site.timeZone, hours: siteWithDsm.hours.slice(0, 2) });
    const stitchedScene = buildStitchedWindgramView(siteWithDsm, {
      unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: siteWithDsm.site.timeZone,
      dateKeys: [...new Set(siteWithDsm.hours.map(h => h.validAt.slice(0, 10)))],
    });
    for (const scene of [dayScene, stitchedScene]) {
      const freeAtTol = readWindgram(scene, 0, 2427.4957);
      expect(freeAtTol.heightAglM).toBeCloseTo(130.2237, 2);
      expect(freeAtTol.heightAglReference).toBe('terrain');
      expect(freeAtTol.terrainDeltaM).toBeCloseTo(503.272, 2);
    }
    expect(siteWithDsm.hours[1]!.fineTerrainM).toBeCloseTo(2297.272, 3);
    expect(siteWithDsm.hours[2]!.fineTerrainM).toBeCloseTo(2297.272, 3);

    // Retained build lacking fine terrain labels free cursor explicitly as 'model AGL'
    const siteNoFine = createPointForecast(build, ara)(build.manifest.frames, loadedMap, null);
    const noFineScene = buildWindgramView(siteNoFine, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: siteNoFine.site.timeZone, hours: [siteNoFine.hours[0]!] });
    const modelRefReading = readWindgram(noFineScene, 0, 2427.4957);
    expect(modelRefReading.heightAglM).toBeCloseTo(633.4957, 2);
    expect(modelRefReading.heightAglReference).toBe('model');

    // Native usable lift top stays fixed at ~1,521.35 m MSL before and after loading a 1,450 m site DEM
    const { build: tailBuild, profile: tailProfile } = fixture([14, 30], 1);
    const tailFrame = tailProfile.frames[1]!;
    tailFrame.profile.modelTerrainM = 1000;
    tailFrame.layers['thermal-top-msl']!.value = 2000;
    tailFrame.layers['thermal-velocity']!.value = 0.639445;
    tailFrame.derived.effectiveCloudLimitM = 4000;
    tailFrame.derived.usableLiftTopV2M = null;
    const toTailForecast = createPointForecast(tailBuild, point);
    const tailLoaded = new Map([[tailProfile.frames[0]!.id, tailProfile.frames[0]!], [tailFrame.id, tailFrame]]);
    const beforeDem = toTailForecast(tailBuild.manifest.frames, tailLoaded, null);
    expect(beforeDem.hours[1]!.nativeUsableLiftTopM).toBeCloseTo(1521.35, 1);
    const afterDem = toTailForecast(tailBuild.manifest.frames, tailLoaded, {
      elevationM: 1450,
      status: 'valid',
      interpolated: false,
      surfaceId: 'gfs-fine',
      surface: 'DSM',
      verticalDatum: 'EGM2008',
    });
    expect(afterDem.hours[1]!.nativeUsableLiftTopM).toBeCloseTo(1521.35, 1);
    const afterDemScene = buildWindgramView(afterDem, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: afterDem.site.timeZone, hours: [afterDem.hours[1]!] });
    expect(readWindgram(afterDemScene, 0, afterDem.hours[1]!.nativeUsableLiftTopM!).heightAglM).toBeCloseTo(71.35, 1);
  });

  it('Finding 3: preserves endpoint surface-to-layer-top shear while reporting maximum wind difference from surface within layer separately', () => {
    const { build, profile } = fixture([18], 1);
    const frame = profile.frames[0]!;
    frame.profile.modelTerrainM = 1000;
    frame.layers['wind-10m-u'] = { ...frame.layers['sfc-temp-c']!, value: 5 };
    frame.layers['wind-10m-v'] = { ...frame.layers['sfc-temp-c']!, value: 0 };
    frame.layers['thermal-top-msl']!.value = 2200;
    frame.layers['thermal-velocity']!.value = 2.0;
    frame.derived.blWindShearMps = 0;
    frame.profile.levels = [
      { pressureHpa: 850, heightM: 1600, temperatureC: 10, dewPointC: 0, uWindMps: 17, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 780, heightM: 2200, temperatureC: 4, dewPointC: -4, uWindMps: 5, vWindMps: 0, omegaPaS: 0 },
    ];
    const site = createPointForecast(build, point)(build.manifest.frames, new Map([[frame.id, frame]]));
    const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: site.site.timeZone, hours: site.hours });
    const reading = readWindgram(scene, 0, 1600);
    expect(reading.publishedLayerWind?.surfaceToTopShearMps).toBe(0);
    expect(reading.publishedLayerWind?.maxDepartureFromSurfaceMps).toBeCloseTo(12, 5);
    const lines = formatWindgramReading(sceneData(scene), reading, 'surface').join(' · ');
    expect(lines).toContain('Surface-to-layer-top shear 0.0 km/h');
    expect(lines).toContain('Maximum wind difference from surface within layer 43.2 km/h');
  });

  it('Finding 4: separates ice cloud from liquid icing and visibility, preserves missing sub-ground T and total precip, gates launch gusts by site AGL, uses neutral descent and OD cold-top wording, and renders Rain+CAPE+Shear', () => {
    const { build, sample, profile } = fixture([15, 16, 17], 3);
    build.manifest.tool.profileDewpointReference = 'liquid-vapor-pressure';
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));

    // Hour 0: Ice-saturated (-18 °C, 80% liquid RH -> 94.66% mixed-phase RH), plus sub-ground warm-nose precip
    frames[0]!.profile.modelTerrainM = 1500;
    frames[0]!.layers['usable-lift-msl']!.value = 1900;
    frames[0]!.layers['usable-lift-agl']!.value = 900; // fineTerrainM = 1000 m
    frames[0]!.layers['sfc-temp-c']!.value = -3;
    frames[0]!.layers['precip-rate'] = { ...frames[0]!.layers['sfc-temp-c']!, value: 0.6 };
    frames[0]!.layers['wind-10m-u'] = { ...frames[0]!.layers['sfc-temp-c']!, value: 5 };
    frames[0]!.layers['wind-10m-v'] = { ...frames[0]!.layers['sfc-temp-c']!, value: 0 };
    const tdIce80 = dewpointFromTempAndRhC(-18, 80);
    frames[0]!.profile.levels = [
      { pressureHpa: 840, heightM: 1600, temperatureC: 1.1, dewPointC: 0.5, uWindMps: 6, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 540, heightM: 5000, temperatureC: -18, dewPointC: tdIce80, uWindMps: 14, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 520, heightM: 5300, temperatureC: -18, dewPointC: tdIce80, uWindMps: 15, vWindMps: 0, omegaPaS: 0 },
    ];

    // Hour 1: Dry valley wind turn (5 m/s E -> 10 m/s W => >29 kt vector change!) with 25 kt 10 m gust, unresolved high OD top (5500 m above 3600 m highest level)
    frames[1]!.profile.modelTerrainM = 1200;
    frames[1]!.layers['usable-lift-msl']!.value = 2100;
    frames[1]!.layers['usable-lift-agl']!.value = 1100; // fineTerrainM = 1000 m
    frames[1]!.layers['wind-10m-u'] = { ...frames[1]!.layers['sfc-temp-c']!, value: -10 };
    frames[1]!.layers['wind-10m-v'] = { ...frames[1]!.layers['sfc-temp-c']!, value: 0 };
    frames[1]!.layers['wind-gust-10m']!.value = 25 / mpsToKnots(1);
    frames[1]!.layers['surface-lcl-msl'] = { ...frames[1]!.layers['sfc-temp-c']!, value: 2100 };
    frames[1]!.layers['thermal-top-msl']!.value = 5500;
    frames[1]!.layers['thermal-velocity']!.value = 2.4;
    frames[1]!.derived.effectiveCloudLimitM = 2100;
    frames[1]!.derived.cuPotentialM = 3400;
    frames[1]!.derived.cloudCapped = true;
    frames[1]!.derived.overdeveloped = true;
    frames[1]!.profile.levels = [
      { pressureHpa: 820, heightM: 1800, temperatureC: 12, dewPointC: 4, uWindMps: -10, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 650, heightM: 3600, temperatureC: -4, dewPointC: -10, uWindMps: -12, vWindMps: 0, omegaPaS: 0 },
    ];

    // Hour 2: Resolved cold OD top (-24 °C at 5400 m) + Rain + CAPE + Shear
    frames[2]!.profile.modelTerrainM = 1200;
    frames[2]!.layers['usable-lift-msl']!.value = 2300;
    frames[2]!.layers['usable-lift-agl']!.value = 1300;
    frames[2]!.layers['surface-lcl-msl'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 2300 };
    frames[2]!.layers['thermal-top-msl']!.value = 5400;
    frames[2]!.layers['thermal-velocity']!.value = 2.8;
    frames[2]!.layers['cape-jkg'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 1200 };
    frames[2]!.layers['precip-rate'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 1.4 };
    frames[2]!.derived.effectiveCloudLimitM = 2300;
    frames[2]!.derived.cuPotentialM = 3100;
    frames[2]!.derived.cloudCapped = true;
    frames[2]!.derived.overdeveloped = true;
    frames[2]!.profile.levels = [
      { pressureHpa: 820, heightM: 1800, temperatureC: 14, dewPointC: 8, uWindMps: 4, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 760, heightM: 2400, temperatureC: 8, dewPointC: 7, uWindMps: 12, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 520, heightM: 5400, temperatureC: -24, dewPointC: -25, uWindMps: 18, vWindMps: 0, omegaPaS: 0 },
    ];

    const site = createPointForecast(build, point, {
      siteTerrain: {
        elevationM: 1000,
        status: 'valid',
        interpolated: true,
        surfaceId: 'gfs-fine',
        surface: 'DSM',
        verticalDatum: 'EGM2008',
      },
    })(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, heightRange: 'full', timeZone: site.site.timeZone, hours: site.hours });
    const fullSvg = renderWindgramSvg(scene);
    expect(fullSvg).toContain('class="wg-barb-rim"');
    expect(fullSvg).toContain('wg-cloud-od-glaciated');
    expect(fullSvg).not.toContain('data-cu-tower=');
    expect(fullSvg).not.toContain('IMC whiteout');
    expect(fullSvg).not.toContain('Deep glaciated OD anvil');

    const back = new FakeElement('rect');
    const windDir = new FakeElement('text');
    const climbSub = new FakeElement('text');
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const tempEl = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const tileMap = new Map<string, FakeElement>([
      ['[data-cursor-back]', back],
      ['[data-tile-wind-dir]', windDir],
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-sky-code]', skyCodeEl],
      ['[data-tile-cloud-text]', cloudText],
      ['[data-tile-temp]', tempEl],
      ['[data-tile-hazard]', hazardEl],
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileMap.get(sel) ?? null,
    } as unknown as ParentNode);
    const dummyTel = {
      timeChip: '11:00 AM', altChip: '', snappedToTol: false, canSnapToTol: false,
      calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false,
    };

    // 1) -18 °C with 80% liquid RH (94.66% mixed-phase RH): inferred cold cloud, zero icing risk, zero IMC/Whiteout
    const iceCloudReading = { ...readWindgram(scene, 0, 5150), precipitationMmHr: 0 };
    expect(iceCloudReading.relativeHumidityPercent).toBeCloseTo(80, 0);
    expect(iceCloudReading.cloudHumidityPercent).toBeCloseTo(94.66, 0);
    bound.paint({ aglText: '4,150 m AGL', mslText: '5,150 m MSL', useTol: false, telemetry: dummyTel, reading: iceCloudReading, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).not.toBe('IMC');
    expect(cloudText.textContent).toContain('☁ Cold cloud');
    expect(cloudText.textContent).not.toContain('Whiteout');
    expect(hazardEl.textContent).not.toContain('Icing');

    // 2) Sub-ground 1,200 m cursor below 1,500 m model ground with surface -3 °C, +1.1 °C at 1,600 m, and 0.6 mm/h total precip
    const subGroundReading = readWindgram(scene, 0, 1200);
    expect(subGroundReading.temperatureF).toBeNull();
    expect(subGroundReading.warmLayerAloft).toBe(true);
    bound.paint({ aglText: '200 m AGL', mslText: '1,200 m MSL', useTol: false, telemetry: dummyTel, reading: subGroundReading, unitSystem: 'metric' });
    expect(tempEl.textContent).toBe('—');
    expect(hazardEl.textContent).toBe('0.6 mm/h · Warm aloft');
    expect(hazardEl.textContent).not.toContain('Frz rain');

    // 3) Cursor at 1,260 m MSL (260 m above 1,000 m site ground, 60 m above 1,200 m model ground): NOT nearSurface!
    const aloft260Reading = readWindgram(scene, 1, 1260);
    expect(aloft260Reading.heightAglM).toBe(260);
    expect(aloft260Reading.surfaceWindShift).not.toBeNull();
    bound.paint({ aglText: '260 m AGL', mslText: '1,260 m MSL', useTol: false, telemetry: dummyTel, reading: { ...aloft260Reading, speedKt: 10, directionDeg: 90, overdeveloped: false }, unitSystem: 'metric' });
    expect(windDir.textContent).toBe('E · Sfc G46');
    expect(back.getAttribute('class')).not.toContain('is-caution');
    expect(hazardEl.textContent).not.toContain('Gust front');
    expect(hazardEl.textContent).not.toBe('Wind shift');
    // Near site surface (80 m AGL): shows 'Wind shift' and surface gust 'E · G46'
    bound.paint({ aglText: '80 m AGL', mslText: '1,080 m MSL', useTol: false, telemetry: dummyTel, reading: { ...aloft260Reading, heightM: 1080, heightAglM: 80, speedKt: 10, directionDeg: 90, overdeveloped: false }, unitSystem: 'metric' });
    expect(windDir.textContent).toBe('E · G46');
    expect(hazardEl.textContent).toBe('Wind shift');
    const shiftSurfaceText = formatWindgramReading(sceneData(scene), aloft260Reading, 'surface').join(' · ');
    expect(shiftSurfaceText).toContain('1h surface wind shift');

    // 4) Unresolved OD top (5,500 m above 3,600 m highest resolved T) keeps topTempC null and shows 'OD spreadout', while resolved -24 °C top shows 'OD · Cold top'
    expect(aloft260Reading.cloudLayers?.[0]?.topTempC).toBeNull();
    bound.paint({ aglText: '260 m AGL', mslText: '1,260 m MSL', useTol: false, telemetry: dummyTel, reading: aloft260Reading, unitSystem: 'metric' });
    expect(hazardEl.textContent).toBe('OD spreadout');

    const resolvedColdOd = { ...readWindgram(scene, 2, 1600), precipitationMmHr: 0, capeJkg: 200, windShear: null };
    expect(resolvedColdOd.cloudLayers?.[0]?.topTempC).toBeLessThanOrEqual(-20);
    bound.paint({ aglText: '600 m AGL', mslText: '1,600 m MSL', useTol: false, telemetry: dummyTel, reading: resolvedColdOd, unitSystem: 'metric' });
    expect(hazardEl.textContent).toBe('OD · Cold top');

    // 5) Flat-terrain strong wind + dry modeled descent (-1.4 m/s) shows '▼ Model descent'
    bound.paint({
      aglText: '120 m AGL', mslText: '1,120 m MSL', useTol: false, telemetry: dummyTel,
      reading: { ...resolvedColdOd, heightAglM: 120, speedKt: 22, estimatedClimbMps: null, waveVelocityMps: -1.4, overdeveloped: false },
      unitSystem: 'metric',
    });
    expect(climbSub.textContent).toBe('▼ Model descent');

    // 6) Compound untyped precip + CAPE + Shear preserves rate and phase uncertainty ('1.4 mm/h · CAPE 1200 · Shr') alongside preserved touch clearance
    const rainCapeShear = readWindgram(scene, 2, 2000);
    bound.paint({ aglText: '1,000 m AGL', mslText: '2,000 m MSL', useTol: false, telemetry: dummyTel, reading: { ...rainCapeShear, peakClimbMps: 1.0 }, unitSystem: 'metric' });
    expect(hazardEl.textContent).toBe('1.4 mm/h · CAPE 1200 · Shr');

    const touchPlaced = placeWindgramCallout({
      cursorX: 220, cursorY: 220, width: 204, height: 74,
      bounds: { left: 40, top: 20, right: 400, bottom: 300 },
      ceilingSamples: [], touchMode: true,
    });
    expect(touchPlaced.y + 74).toBeLessThanOrEqual(220 - 44);
  });

  it('Finding 5: preserves signed model vertical motion across directional turns and saturated air, keeps missing omega unavailable, and avoids quadratic scans', async () => {
    const mod = await import('./index.ts');
    expect('hasWaveCriticalLevelBelow' in mod).toBe(false);

    const { build, profile } = fixture([14, 15, 16, 17], 4);
    // Hour 0: (5, 10) -> (5, -10) directional change; Hour 1: (-1, 10) -> (1, 10); Hour 2: saturated 98% RH ascent; Hour 3: missing omega
    profile.frames[0]!.layers['thermal-velocity']!.value = 0;
    profile.frames[0]!.profile.levels = [
      { pressureHpa: 850, heightM: 1800, temperatureC: 6, dewPointC: -4, uWindMps: 5, vWindMps: 10, omegaPaS: -12 },
      { pressureHpa: 750, heightM: 2800, temperatureC: 2, dewPointC: -8, uWindMps: 5, vWindMps: -10, omegaPaS: -14 },
    ];
    profile.frames[1]!.layers['thermal-velocity']!.value = 0;
    profile.frames[1]!.profile.levels = [
      { pressureHpa: 850, heightM: 1800, temperatureC: 6, dewPointC: -4, uWindMps: -1, vWindMps: 10, omegaPaS: -12 },
      { pressureHpa: 750, heightM: 2800, temperatureC: 2, dewPointC: -8, uWindMps: 1, vWindMps: 10, omegaPaS: -14 },
    ];
    profile.frames[2]!.layers['thermal-velocity']!.value = 0;
    profile.frames[2]!.profile.levels = [
      { pressureHpa: 850, heightM: 1800, temperatureC: 6, dewPointC: 5.8, uWindMps: 12, vWindMps: 0, omegaPaS: -14 },
      { pressureHpa: 750, heightM: 2800, temperatureC: 2, dewPointC: 1.8, uWindMps: 14, vWindMps: 0, omegaPaS: -15 },
    ];
    profile.frames[3]!.layers['thermal-velocity']!.value = 0;
    profile.frames[3]!.profile.levels = [
      { pressureHpa: 850, heightM: 1800, temperatureC: 6, dewPointC: -4, uWindMps: 12, vWindMps: 0, omegaPaS: null },
      { pressureHpa: 750, heightM: 2800, temperatureC: 2, dewPointC: -8, uWindMps: 14, vWindMps: 0, omegaPaS: null },
    ];

    const site = createPointForecast(build, point)(build.manifest.frames, new Map(profile.frames.map(f => [f.id, f])));
    const scene = buildWindgramView(site, { unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: site.site.timeZone, hours: site.hours });
    expect(scene.topM).toBeGreaterThanOrEqual(2800);
    expect(readWindgram(scene, 0, 2800).waveVelocityMps).toBeGreaterThan(1.0);
    expect(readWindgram(scene, 1, 2800).waveVelocityMps).toBeGreaterThan(1.0);
    expect(readWindgram(scene, 2, 2400).waveVelocityMps).toBeGreaterThan(1.0);
    expect(readWindgram(scene, 2, 2400).cloud).toBe('humidity');
    const missingOmega = readWindgram(scene, 3, 2400);
    expect(missingOmega.verticalVelocityPaS).toBeNull();
    expect(missingOmega.waveVelocityMps).toBeNull();

    // Structural & timing check on 72-hour x 40-level dry missing-omega forecast
    let omegaReads = 0;
    const dryHours = Array.from({ length: 72 }, (_, h) => {
      const base = site.hours[3]!;
      const levels = Array.from({ length: 40 }, (_, k) => {
        const lvl = {
          pressureHpa: 1000 - k * 20,
          heightM: 500 + k * 250,
          temperatureC: 15 - k * 1.2,
          dewPointC: -20 - k,
          uWindMps: k % 2 === 0 ? 10 : -10,
          vWindMps: 5,
        };
        Object.defineProperty(lvl, 'omegaPaS', {
          enumerable: true,
          get() { omegaReads++; return null; },
        });
        return lvl as PublishedLevel;
      });
      return { ...base, validAt: new Date(Date.UTC(2026, 10, 1, h)).toISOString(), levels };
    });
    type PublishedLevel = (typeof site.hours)[number]['levels'][number];
    const syntheticSite = { ...site, hours: dryHours };
    const { buildWindgramVerticalScale } = await import('./windgram-scale.ts');
    omegaReads = 0;
    const t0 = performance.now();
    buildWindgramVerticalScale(syntheticSite, dryHours, { compact: true, heightRange: 'soaring', top: 44, bottom: 280, plotHeight: 236 });
    const elapsedMs = performance.now() - t0;
    // Linear single-pass scan touches each of the 72 * 40 = 2,880 levels exactly once!
    expect(omegaReads).toBe(72 * 40);
    expect(elapsedMs).toBeLessThan(20);
  });

  it('Finding 6: resolves geographic civil zones, per-frame DST transitions, half-hour offsets, and labeled UTC fallback across day and stitched views', async () => {
    expect(resolveCivilTimeZone(40.179, 44.499)).toBe('Asia/Yerevan');
    expect(resolveCivilTimeZone(38.8473, -78.4121)).toBe('America/New_York');
    expect(resolveCivilTimeZone(40.4168, -3.7038)).toBe('Europe/Madrid');
    expect(resolveCivilTimeZone(38.7223, -9.1393)).toBe('Europe/Lisbon');
    expect(resolveCivilTimeZone(43.615, -116.202)).toBe('America/Boise');
    expect(resolveCivilTimeZone(33.45, -112.07)).toBe('America/Phoenix');
    expect(resolveCivilTimeZone(47.56, -52.71)).toBe('America/St_Johns');
    expect(resolveCivilTimeZone(27.7172, 85.324)).toBe('Asia/Kathmandu');
    expect(resolveCivilTimeZone(-31.676, 128.885)).toBe('Australia/Eucla');
    expect(resolveCivilTimeZone(-32.8895, -68.8458)).toBe('America/Argentina/Mendoza');
    expect(resolveCivilTimeZone(30.0, -40.0)).toBe('UTC');

    const { buildWindgramTelemetry } = await import('./windgram-readout.ts');
    const { build, profile } = fixture([1, 2, 3, 4], 4);

    // US Nov 1, 2026 fall-back at New York (05Z -> 01:00 EDT, 06Z -> 01:00 EST)
    const dstFrames = [
      { id: 'f001', validTime: '2026-11-01T05:00:00.000Z', intervalStart: '2026-11-01T04:00:00.000Z', intervalEnd: '2026-11-01T05:00:00.000Z' },
      { id: 'f002', validTime: '2026-11-01T06:00:00.000Z', intervalStart: '2026-11-01T05:00:00.000Z', intervalEnd: '2026-11-01T06:00:00.000Z' },
      { id: 'f003', validTime: '2026-11-01T15:00:00.000Z', intervalStart: '2026-11-01T14:00:00.000Z', intervalEnd: '2026-11-01T15:00:00.000Z' },
      { id: 'f004', validTime: '2026-11-02T15:00:00.000Z', intervalStart: '2026-11-02T14:00:00.000Z', intervalEnd: '2026-11-02T15:00:00.000Z' },
    ];
    build.manifest.frames = dstFrames;
    const mappedFrames = profile.frames.map((f, i) => ({ ...f, ...dstFrames[i]! }));
    const nySite = createPointForecast(build, { lat: 40.7128, lon: -74.006 })(dstFrames, new Map(mappedFrames.map(f => [f.id, f])));
    const nyFullDay = buildWindgramView(nySite, { unitSystem: 'metric', compact: true, timeZone: nySite.site.timeZone, hours: nySite.hours.slice(0, 3) });
    const tel05Z = buildWindgramTelemetry(sceneData(nyFullDay), readWindgram(nyFullDay, 0, 1800), nySite.hours[0]!.mapLift, false, false);
    const tel06Z = buildWindgramTelemetry(sceneData(nyFullDay), readWindgram(nyFullDay, 1, 1800), nySite.hours[1]!.mapLift, false, false);
    expect(tel05Z.timeChip).toBe('01:00 EDT');
    expect(tel06Z.timeChip).toBe('01:00 EST');
    expect(tel05Z.compactTime).toBe('1a EDT');
    expect(tel06Z.compactTime).toBe('1a EST');

    // Offshore (30°N, 40°W) labeled UTC fallback in both 1-day and stitched views
    const offshoreSite = createPointForecast(build, { lat: 30.0, lon: -40.0 })(dstFrames, new Map(mappedFrames.map(f => [f.id, f])));
    expect(offshoreSite.site.isUtcFallback).toBe(true);
    const offshoreDay = buildWindgramView(offshoreSite, { unitSystem: 'metric', compact: true, timeZone: offshoreSite.site.timeZone, hours: offshoreSite.hours.slice(2, 3) });
    const offshoreStitched = buildStitchedWindgramView(offshoreSite, {
      unitSystem: 'metric', compact: true, timeZone: offshoreSite.site.timeZone,
      dateKeys: ['2026-11-01', '2026-11-02'],
    });
    const offshoreTel = buildWindgramTelemetry(sceneData(offshoreDay), readWindgram(offshoreDay, 0, 1800), offshoreSite.hours[2]!.mapLift, false, false);
    expect(offshoreTel.timeChip).toBe('15:00 UTC');
    expect(offshoreTel.compactTime).toBe('3p UTC');
    expect(renderWindgramSvg(offshoreDay)).toContain('time UTC (fallback)');
    expect(renderWindgramSvg(offshoreStitched)).toContain('time UTC (fallback)');
  });

  it('preserves native-column convective depth on high-ridge fallback hours and distinguishes unpublished model omega', async () => {
    const { resolveConvectiveEnvelope, estimateThermalClimbAtHeight } = await import('./windgram-atmosphere.ts');
    // Ridge DEM 1,450 m over 1,000 m model ground with 1,521.35 m native usable ceiling (thermal top 2,000 m, w* = 0.639445 m/s)
    const wStar = 0.639445;
    const env = resolveConvectiveEnvelope(1450, 1521.35, 2000, 4000, wStar, {
      modelTerrainM: 1000,
      isNativeFallback: true,
    });
    expect(env).not.toBeNull();
    expect(env!.groundM).toBe(1000);
    expect(env!.floorM).toBe(1450);
    expect(env!.convectiveDepthM).toBeCloseTo(1000, 0);
    // Below the 1,450 m ridge is underground (0 climb); at 1,480 m MSL inside [1450, 1521.35] it follows the true 1,000 m native profile
    expect(estimateThermalClimbAtHeight(1400, 1450, 1521.35, 2000, 4000, wStar, { modelTerrainM: 1000, isNativeFallback: true }).estimatedClimbMps).toBe(0);
    const aloftClimb = estimateThermalClimbAtHeight(1480, 1450, 1521.35, 2000, 4000, wStar, { modelTerrainM: 1000, isNativeFallback: true }).estimatedClimbMps!;
    expect(aloftClimb).toBeGreaterThan(0);
    expect(aloftClimb).toBeLessThan(0.12);

    // Unpublished model omega (e.g. GFS / ICON-EU) vs missing single-level omega (e.g. RRFS / WRF)
    const { build, profile } = fixture([1, 2], 2);
    const noOmegaFrames = profile.frames.map(f => ({
      ...f,
      profile: f.profile ? { ...f.profile, levels: f.profile.levels.map(l => ({ ...l, omegaPaS: null })) } : f.profile,
    }));
    const noOmegaSite = createPointForecast(build, { lat: 38.85, lon: -78.41 })(
      build.manifest.frames.slice(0, 2),
      new Map(noOmegaFrames.slice(0, 2).map(f => [f.id, f])),
    );
    const noOmegaView = buildWindgramView(noOmegaSite, { unitSystem: 'metric', compact: true, timeZone: noOmegaSite.site.timeZone, hours: noOmegaSite.hours });
    expect(readWindgram(noOmegaView, 0, 1800).verticalVelocityUnavailableReason).toBe(
      'Vertical motion unavailable (not published for this model).',
    );

    const partialOmegaFrames = noOmegaFrames.map((f, idx) => idx === 1 && f.profile
      ? { ...f, profile: { ...f.profile, levels: f.profile.levels.map((l, j) => (j === 1 ? { ...l, omegaPaS: -0.9 } : l)) } }
      : f);
    const partialSite = createPointForecast(build, { lat: 38.85, lon: -78.41 })(
      build.manifest.frames.slice(0, 2),
      new Map(partialOmegaFrames.slice(0, 2).map(f => [f.id, f])),
    );
    const partialView = buildWindgramView(partialSite, { unitSystem: 'metric', compact: true, timeZone: partialSite.site.timeZone, hours: partialSite.hours });
    expect(readWindgram(partialView, 0, 1800).verticalVelocityUnavailableReason).toBe(
      'Vertical motion unavailable for the selected frame and height.',
    );
    expect(readWindgram(partialView, 1, 1800).verticalVelocityUnavailableReason).toBe(
      'Vertical motion unavailable at this height.',
    );
  });

  it('recovers physical liquid RH and dewpoint on GFS cold clouds without false Icing risk', () => {
    const cascades = { lat: 47.25, lon: -121.75 };
    const { build: retainedBuild, profile: retainedProfile } = fixture([18, 21], 2);

    // Frame 0: Nov 22 18Z GFS f018 at 600 hPa (4,159 m): liquid-vapor-pressure dewpoint from 99.58% GFS RH (~85.41% liquid RH)
    retainedProfile.frames[0]!.profile.modelTerrainM = 1200;
    retainedProfile.frames[0]!.layers['sfc-temp-c']!.value = 2;
    retainedProfile.frames[0]!.layers['sfc-dewpoint-c'] = { ...retainedProfile.frames[0]!.layers['sfc-temp-c']!, value: -2 };
    retainedProfile.frames[0]!.profile.levels = [
      { pressureHpa: 850, heightM: 1500, temperatureC: -2, dewPointC: dewpointFromTempAndRhC(-2, 70), uWindMps: 6, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 600, heightM: 4159, temperatureC: -17.72, dewPointC: dewpointFromGfsV16RhC(-17.72, 99.58), uWindMps: 14, vWindMps: 0, omegaPaS: 0 },
    ];
    // Frame 1: Cascades -19.82 °C with 95.12% GFS RH -> 78.29% liquid RH
    retainedProfile.frames[1]!.profile.modelTerrainM = 1200;
    retainedProfile.frames[1]!.profile.levels = [
      { pressureHpa: 850, heightM: 1500, temperatureC: -3, dewPointC: dewpointFromTempAndRhC(-3, 70), uWindMps: 6, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 600, heightM: 4170, temperatureC: -19.82, dewPointC: dewpointFromGfsV16RhC(-19.82, 95.12), uWindMps: 15, vWindMps: 0, omegaPaS: 0 },
    ];

    const retainedSite = createPointForecast(retainedBuild, cascades)(
      retainedBuild.manifest.frames,
      new Map(retainedProfile.frames.map(f => [f.id, f])),
    );
    const retainedView = buildWindgramView(retainedSite, {
      unitSystem: 'metric', compact: false, heightRange: 'full', timeZone: retainedSite.site.timeZone, hours: retainedSite.hours,
    });

    const f018 = readWindgram(retainedView, 0, 4159);
    expect(f018.relativeHumidityPercent!).toBeCloseTo(85.41, 1);
    expect(f018.cloudHumidityPercent!).toBeGreaterThanOrEqual(94);
    expect(f018.dewPointC!).toBeLessThan(-19.5);

    const archived600 = readWindgram(retainedView, 1, 4170);
    expect(archived600.relativeHumidityPercent!).toBeCloseTo(78.4, 0);
    expect(archived600.cloudHumidityPercent!).toBeGreaterThanOrEqual(94);

    // Tile callout shows cold-cloud evidence without Icing risk at both heights
    const cloudText = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => (sel === '[data-tile-cloud-text]' ? cloudText : sel === '[data-tile-hazard]' ? hazardEl : null),
    } as unknown as ParentNode);
    const dummyTel = { timeChip: '07:00', altChip: '', snappedToTol: false, canSnapToTol: false, calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false };
    for (const r of [f018, archived600]) {
      bound.paint({ aglText: '2,960 m AGL', mslText: '4,160 m MSL', useTol: false, telemetry: dummyTel, reading: { ...r, precipitationMmHr: 0 }, unitSystem: 'metric' });
      expect(cloudText.textContent).toContain('☁ Cold cloud');
      expect(hazardEl.textContent).not.toContain('Icing');
    }
  });

  it('prevents a weather donor from becoming site ground across mixed contributors, absence, outside-domain, loading-order reversal, and SVG footer', async () => {
    const { buildWindgramTelemetry } = await import('./windgram-readout.ts');
    const ara = { lat: 40.4186, lon: 44.4547 };
    const { build, sample, profile } = fixture([12, 13], 2);
    build.manifest.model = 'icon-eu';
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));
    for (const f of frames) f.profile.modelTerrainM = 1794;

    // Hour 0: 1 weather contributor missing -> nearest weather donor (2,470.101 m terrain, 2,770.101 m MSL, 300 m donor AGL, interpolated: false)
    frames[0]!.layers['usable-lift-msl'] = { ...frames[0]!.layers['usable-lift-msl']!, value: 2770.101, interpolated: false };
    frames[0]!.layers['usable-lift-agl'] = { ...frames[0]!.layers['usable-lift-agl']!, value: 300, interpolated: false };
    // Hour 1: all 4 weather contributors valid -> 2,597.272 m MSL, 300 m site AGL, interpolated: true
    frames[1]!.layers['usable-lift-msl'] = { ...frames[1]!.layers['usable-lift-msl']!, value: 2597.272, interpolated: true };
    frames[1]!.layers['usable-lift-agl'] = { ...frames[1]!.layers['usable-lift-agl']!, value: 300, interpolated: true };

    const loaded = new Map(frames.map(f => [f.id, f]));
    const araTerrain = {
      elevationM: 2297.272,
      status: 'valid' as const,
      interpolated: true,
      surfaceId: 'gfs-fine',
      surface: 'DSM',
      verticalDatum: 'EGM2008',
    };

    // 1) Mixed contributor with valid siteTerrain: snapped preserves 300 m labeled 'donor AGL', free reads 473 m site AGL
    const withSite = createPointForecast(build, ara, { siteTerrain: araTerrain })(build.manifest.frames, loaded);
    const viewWithSite = buildWindgramView(withSite, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: withSite.site.timeZone, hours: withSite.hours });
    const mixedFree = readWindgram(viewWithSite, 0, 2770.101);
    expect(mixedFree.heightAglM!).toBeCloseTo(472.829, 2);
    expect(mixedFree.heightAglReference).toBe('terrain');
    const snappedTel = buildWindgramTelemetry(sceneData(viewWithSite), mixedFree, withSite.hours[0]!.mapLift, true, true);
    expect(snappedTel.altChip).toContain('300 m donor AGL');
    expect(snappedTel.altChip).toContain('473 m site AGL');
    const freeTel = buildWindgramTelemetry(sceneData(viewWithSite), mixedFree, withSite.hours[0]!.mapLift, false, true);
    expect(freeTel.altChip).toContain('473 m AGL');

    // 2) Site terrain unavailable: donor never carries into Hour 1 (never turns 300 m into 127 m), free cursor uses 'model AGL', SVG footer never prints donor as 'Ground'
    const toForecast = createPointForecast(build, ara);
    const noSite = toForecast(build.manifest.frames, loaded, null);
    expect(noSite.hours[0]!.fineTerrainM).toBeNull();
    expect(noSite.hours[1]!.fineTerrainM).toBeNull();
    const viewNoSite = buildWindgramView(noSite, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: noSite.site.timeZone, hours: noSite.hours });
    const h1Reading = readWindgram(viewNoSite, 1, 2597.272);
    expect(h1Reading.heightAglReference).toBe('model');
    expect(h1Reading.heightAglM!).toBeCloseTo(2597.272 - 1794, 2);
    const h1SnappedTel = buildWindgramTelemetry(sceneData(viewNoSite), h1Reading, noSite.hours[1]!.mapLift, true, true);
    expect(h1SnappedTel.altChip).toBe('★ TOL 300 m AGL');
    const h1FreeTel = buildWindgramTelemetry(sceneData(viewNoSite), h1Reading, noSite.hours[1]!.mapLift, false, true);
    expect(h1FreeTel.altChip).toContain('803 m model AGL');
    const noSiteSvg = renderWindgramSvg(viewNoSite);
    expect(noSiteSvg).toContain('Model ground 1,794 m MSL');
    expect(noSiteSvg).not.toContain('Ground 2,470');

    // 3) Loading-order reversal: siteTerrain arrives after weather and recovers 300 m AGL on Hour 1
    const recovered = toForecast(build.manifest.frames, loaded, araTerrain);
    const viewRecovered = buildWindgramView(recovered, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: recovered.site.timeZone, hours: recovered.hours });
    expect(readWindgram(viewRecovered, 1, 2597.272).heightAglM!).toBeCloseTo(300, 2);
    expect(renderWindgramSvg(viewRecovered)).toContain('Ground 2,297 m MSL');

    // 4) Explicit outside-domain terrain is never overridden by current-frame weather donor
    const outsideSite = createPointForecast(build, ara, {
      siteTerrain: { ...araTerrain, elevationM: null, status: 'outside-domain', interpolated: false },
    })(build.manifest.frames, loaded);
    expect(outsideSite.hours[0]!.fineTerrainM).toBeNull();
  });

  it('keeps visual and accessible altitudes in agreement across same-hour vertical pointer motion and parent container scroll', async () => {
    vi.useFakeTimers();
    try {
      const { build, sample, profile } = fixture([18], 1);
      const frame = { ...profile.frames[0]!, layers: { ...profile.frames[0]!.layers, ...sample.frames[0]!.layers } };
      frame.profile.modelTerrainM = 500;
      frame.layers['usable-lift-msl']!.value = 2400;
      frame.layers['usable-lift-agl']!.value = 1900;
      const site = createPointForecast(build, point, {
        siteTerrain: { elevationM: 500, status: 'valid', interpolated: true, surfaceId: 'gfs-fine', surface: 'DSM', verticalDatum: 'EGM2008' },
      })(build.manifest.frames, new Map([[frame.id, frame]]));
      const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, timeZone: site.site.timeZone, hours: site.hours });

      let containerOffsetY = 0;
      const agl = new FakeElement('text');
      const readout = new FakeElement('p');
      readout.id = 'scroll-readout';
      const svg = {
        querySelector: (sel: string) => (sel === '[data-cursor-agl]' ? agl : null),
        getScreenCTM: () => ({
          inverse: () => ({ offsetY: containerOffsetY }),
        }),
      };
      const host = Object.assign(new FakeElement('div'), {
        ownerDocument: {},
        querySelector: (sel: string) => (sel === 'svg.windgram' ? svg : null),
        getBoundingClientRect: () => ({
          left: 0,
          top: containerOffsetY,
          right: scene.width,
          bottom: scene.height + containerOffsetY,
        }),
      });
      vi.stubGlobal('DOMPoint', class {
        constructor(readonly x: number, readonly y: number) {}
        matrixTransform(inv: { offsetY?: number }) {
          return new DOMPoint(this.x, this.y - (inv.offsetY ?? 0));
        }
      });

      const telemetries: import('./windgram-readout.ts').WindgramTelemetryStrip[] = [];
      const chart = mountWindgram(host as unknown as HTMLElement, {
        view: scene,
        idPrefix: 'ptr-reg',
        readout: readout as unknown as HTMLElement,
        inspectionMode: 'magnetic',
        onTelemetry: t => { if (t) telemetries.push(t); },
      });

      const yForAgl = (targetAglM: number) => {
        const msl = 500 + targetAglM;
        return scene.bottom - ((msl - scene.floorM) / (scene.topM - scene.floorM)) * scene.plotHeight;
      };

      // Move vertically within the same hour from 1,528 m AGL to 982 m AGL
      host.dispatchEvent(Object.assign(new Event('pointermove'), {
        pointerType: 'mouse', pointerId: 1, clientX: scene.hours[0]!.x, clientY: yForAgl(1528),
      }));
      expect(telemetries.at(-1)!.altChip).toContain('1,528 m AGL');
      expect(readout.textContent).toContain('1,528 m AGL');

      host.dispatchEvent(Object.assign(new Event('pointermove'), {
        pointerType: 'mouse', pointerId: 1, clientX: scene.hours[0]!.x, clientY: yForAgl(982),
      }));
      expect(telemetries.at(-1)!.altChip).toContain('982 m AGL');
      vi.advanceTimersByTime(80);
      expect(readout.textContent).toContain('982 m AGL');

      // Shift enclosing container by 70 CSS pixels and point at the exact same chart-relative position
      containerOffsetY = 70;
      host.dispatchEvent(Object.assign(new Event('pointermove'), {
        pointerType: 'mouse', pointerId: 1, clientX: scene.hours[0]!.x, clientY: yForAgl(982) + 70,
      }));
      vi.advanceTimersByTime(80);
      expect(telemetries.at(-1)!.altChip).toContain('982 m AGL');
      expect(readout.textContent).toContain('982 m AGL');

      chart.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aligns Windgram Key swatches, ranges, 15 kt white lapse barb, 50 kt pennant, scientific wording, and trigger glyph', () => {
    const hybridMetric = renderWindgramKey('metric', true, 'hybrid-climb');
    const hybridImperial = renderWindgramKey('imperial', false, 'hybrid-climb');
    const lapseMetric = renderWindgramKey('metric', false, 'lapse');

    // Hybrid: 6 quantitative climb swatches with 6 visible/accessible ranges, 1.2 m/s / 236 ft/min sink stated, sky/inversion separated
    expect(hybridMetric.match(/class="wg-key-band"/g)).toHaveLength(6);
    expect(hybridMetric).toContain('includes 1.2 m/s sink');
    expect(hybridImperial).toContain('includes 236 ft/min sink');
    expect(hybridMetric).toContain('wg-key-backdrops');
    expect(hybridMetric).toContain('Neutral sky');
    expect(hybridMetric).toContain('Inversion lid');

    // Lapse: 8 quantitative swatches with 8 visible/accessible ranges, 15 kt barb colored white (#ffffff), 50 kt filled pennant drawn
    expect(lapseMetric.match(/class="wg-key-band"/g)).toHaveLength(8);
    const barb15Match = lapseMetric.match(/data-key-barb="15"[^>]*>([\s\S]*?)<\/g>/);
    expect(barb15Match?.[1]).toContain('stroke="#ffffff"');
    expect(barb15Match?.[1]).not.toContain('#78ff78');
    const barb50Match = lapseMetric.match(/data-key-barb="50"[^>]*>([\s\S]*?)<\/g>/);
    expect(barb50Match?.[1]).toContain('Z" fill="#ffffff"');
    expect(lapseMetric).toContain('data-key-hover-dial');
    expect(lapseMetric).toContain('Barb points to wind source; hover arrow points downwind');

    // Scientific wording: modeled ascent aloft, inferred moisture ranges, separate lift line samples, missing hours or heights, secondary disclosure
    expect(hybridMetric).toContain('Modeled ascent aloft');
    expect(hybridMetric).not.toContain('stable wave');
    expect(hybridMetric).toContain('Inferred moisture');
    expect(hybridMetric).toContain('83–&lt;89%, 89–&lt;94%, ≥94%');
    expect(hybridMetric).not.toMatch(/SCT\/BKN/i);
    expect(hybridMetric).toContain('Native lift estimate');
    expect(hybridMetric).toContain('Unavailable hours or heights');
    expect(hybridMetric).toContain('<details class="wg-key-more">');
  });

  it('preserves missing-height gaps in modeled ascent contours, truthful precip/cloud labels, DST accessible clock, RRFS isolated omega wording, and stitched run-switch ticks', () => {
    // 1) Missing native level height breaks modeled ascent contour across 2,500 m
    const { build, sample, profile } = fixture([18], 1);
    const gapFrame = profile.frames[0]!;
    gapFrame.profile.modelTerrainM = 400;
    gapFrame.layers['thermal-velocity']!.value = 0;
    gapFrame.profile.levels = [
      { pressureHpa: 880, heightM: 1000, temperatureC: 8, dewPointC: -5, uWindMps: 14, vWindMps: 0, omegaPaS: -18 },
      { pressureHpa: 750, heightM: null, temperatureC: 2, dewPointC: -8, uWindMps: 15, vWindMps: 0, omegaPaS: -18 },
      { pressureHpa: 620, heightM: 4000, temperatureC: -8, dewPointC: -18, uWindMps: 18, vWindMps: 0, omegaPaS: -18 },
    ];
    const gapSite = createPointForecast(build, point)(build.manifest.frames, new Map([[gapFrame.id, gapFrame]]));
    const gapView = buildWindgramView(gapSite, { unitSystem: 'metric', compact: false, heightRange: 'full', timeZone: gapSite.site.timeZone, hours: gapSite.hours });
    expect(readWindgram(gapView, 0, 2500).waveVelocityMps).toBeNull();
    const y2500 = gapView.bottom - ((2500 - gapView.floorM) / (gapView.topM - gapView.floorM)) * gapView.plotHeight;
    const wavePaths = sceneData(gapView).fields.filter(f => f.className.startsWith('wg-wave-')).map(f => f.path);
    for (const d of wavePaths) {
      for (const ring of d.split('Z').filter(Boolean)) {
        const ys = [...ring.matchAll(/[ML][-\d.]+\s+([-\d.]+)/g)].map(m => Number(m[1]));
        if (ys.length) {
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          expect(y2500 > minY + 1 && y2500 < maxY - 1).toBe(false);
        }
      }
    }

    // 2) Callout labels: untyped 1 mm/h + CAPE 1200 + Shear, 100% sky cover with unknown local RH & precip, and dry inversion gated off Warm aloft
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) =>
        sel === '[data-tile-sky-code]' ? skyCodeEl : sel === '[data-tile-cloud-text]' ? cloudText : sel === '[data-tile-hazard]' ? hazardEl : null,
    } as unknown as ParentNode);
    const dummyTel = { timeChip: '14:00', altChip: '', snappedToTol: false, canSnapToTol: false, calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false };

    const baseR = readWindgram(gapView, 0, 1000);
    bound.paint({
      aglText: '600 m AGL', mslText: '1,000 m MSL', useTol: false, telemetry: dummyTel,
      reading: { ...baseR, precipitationMmHr: 1.0, capeJkg: 1200, windShear: { lowerM: 800, upperM: 1200, vectorChangeMps: 4, perKmMps: 10 } },
      unitSystem: 'metric',
    });
    expect(hazardEl.textContent).toBe('1.0 mm/h · CAPE 1200 · Shr');

    bound.paint({
      aglText: '600 m AGL', mslText: '1,000 m MSL', useTol: false, telemetry: dummyTel,
      reading: {
        ...baseR,
        cloud: null,
        cloudLayers: [],
        activeCloudLayer: null,
        relativeHumidityPercent: null,
        cloudHumidityPercent: null,
        cloudCoverTotalPercent: 100,
        precipitationMmHr: null,
        capeJkg: 0,
        windShear: null,
      },
      unitSystem: 'metric',
    });
    expect(skyCodeEl.textContent).toBe('SKY 100%');
    expect(cloudText.textContent).toBe('Local RH — · Sky 100%');
    expect(hazardEl.textContent).toBe('Precip —');

    // Dry post-frontal subsidence inversion (0 mm/h precip, low RH) does NOT trigger warmLayerAloft
    const dryInvFrame = structuredClone(gapFrame);
    dryInvFrame.layers['sfc-temp-c']!.value = 8;
    dryInvFrame.layers['precip-rate'] = { ...dryInvFrame.layers['sfc-temp-c']!, value: 0 };
    dryInvFrame.profile.levels = [
      { pressureHpa: 840, heightM: 1600, temperatureC: -4, dewPointC: -16, uWindMps: 8, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 790, heightM: 2100, temperatureC: 1.2, dewPointC: -15, uWindMps: 10, vWindMps: 0, omegaPaS: 0 },
    ];
    const dryInvSite = createPointForecast(build, point)(build.manifest.frames, new Map([[dryInvFrame.id, dryInvFrame]]));
    const dryInvView = buildWindgramView(dryInvSite, { unitSystem: 'metric', compact: false, timeZone: dryInvSite.site.timeZone, hours: dryInvSite.hours });
    expect(readWindgram(dryInvView, 0, 1800).warmLayerAloft).toBe(false);

    // 3) Accessible timestamp at America/New_York DST transition (Nov 1 06Z -> 01:00 EST)
    const dstFrames = [
      { id: 'f001', validTime: '2026-11-01T05:00:00.000Z', intervalStart: '2026-11-01T04:00:00.000Z', intervalEnd: '2026-11-01T05:00:00.000Z' },
      { id: 'f002', validTime: '2026-11-01T06:00:00.000Z', intervalStart: '2026-11-01T05:00:00.000Z', intervalEnd: '2026-11-01T06:00:00.000Z' },
    ];
    const dstBuild = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 2 });
    dstBuild.manifest.frames = dstFrames;
    const dstLoaded = new Map(dstFrames.map(df => [df.id, { ...profile.frames[0]!, ...df, id: df.id, layers: { ...profile.frames[0]!.layers, ...sample.frames[0]!.layers } }]));
    const nySite = createPointForecast(dstBuild, { lat: 40.7128, lon: -74.006 })(dstFrames, dstLoaded);
    const nyView = buildWindgramView(nySite, { unitSystem: 'metric', compact: true, timeZone: nySite.site.timeZone, hours: nySite.hours });
    const srEl = new FakeElement('p');
    srEl.id = 'dst-sr';
    const dstHost = new FakeElement('div');
    const dstChart = mountWindgram(dstHost as unknown as HTMLElement, {
      view: nyView,
      idPrefix: 'dst',
      readout: srEl as unknown as HTMLElement,
      selectedValidAt: '2026-11-01T06:00:00.000Z',
    });
    expect(srEl.textContent).toContain('01:00 EST (06:00 UTC)');
    dstChart.dispose();

    // 4) RRFS f018 missing omega in isolation vs alongside f021 never claims 'not published for this model'
    const rrfsBuild = fixtureProfileBuild({ frameHours: [18, 21], mapFrameCount: 2 });
    rrfsBuild.manifest.model = 'rrfs';
    const rrfsSample = fixturePointSample(rrfsBuild, `https://api.test/point?lat=${point.lat}&lon=${point.lon}&frame=f018,f021&layers=usable-lift-msl,usable-lift-agl`);
    const rrfsProfile = fixtureProfileResponse(rrfsBuild, `https://api.test/point?lat=${point.lat}&lon=${point.lon}&frame=f018,f021&layers=thermal-top-msl,pbl-height-agl,thermal-velocity,sfc-temp-c,wind-gust-10m,cloud-cover-total,cloud-cover-low`);
    rrfsProfile.frames[0]!.profile.levels = rrfsProfile.frames[0]!.profile.levels.map(l => ({ ...l, omegaPaS: null }));
    rrfsProfile.frames[1]!.profile.levels = rrfsProfile.frames[1]!.profile.levels.map(l => ({ ...l, omegaPaS: -1.5 }));
    const rrfsFrames = rrfsProfile.frames.map((f, i) => ({ ...f, layers: { ...f.layers, ...rrfsSample.frames[i]!.layers } }));
    const rrfsSiteIsolated = createPointForecast(rrfsBuild, point)([rrfsBuild.manifest.frames[0]!], new Map([[rrfsFrames[0]!.id, rrfsFrames[0]!]]));
    const rrfsIsolatedView = buildWindgramView(rrfsSiteIsolated, { unitSystem: 'metric', compact: true, timeZone: rrfsSiteIsolated.site.timeZone, hours: rrfsSiteIsolated.hours });
    const isolatedReason = readWindgram(rrfsIsolatedView, 0, 1800).verticalVelocityUnavailableReason;
    expect(isolatedReason).not.toContain('not published for this model');

    const rrfsSiteBoth = createPointForecast(rrfsBuild, point)(rrfsBuild.manifest.frames, new Map(rrfsFrames.map(f => [f.id, f])));
    const rrfsBothView = buildWindgramView(rrfsSiteBoth, { unitSystem: 'metric', compact: true, timeZone: rrfsSiteBoth.site.timeZone, hours: rrfsSiteBoth.hours });
    expect(readWindgram(rrfsBothView, 0, 1800).verticalVelocityUnavailableReason).toBe(isolatedReason);

    // 5) Stitched empty-panel ticks stay identical whether a shifted-alignment run is opened after an earlier run or fresh
    const wvPoint = { lat: 38.0, lon: -81.5 };
    const makeRunSite = (cycleIso: string, hours: readonly number[], pt = wvPoint) => {
      const cycleMs = Date.parse(cycleIso);
      const runBuild = fixtureProfileBuild({ frameHours: hours, mapFrameCount: 2 });
      runBuild.manifest.cycle = cycleIso;
      runBuild.manifest.frames = hours.map(h => ({
        id: `f${String(h).padStart(3, '0')}`,
        validTime: new Date(cycleMs + h * 3_600_000).toISOString(),
        intervalStart: new Date(cycleMs + (h - 3) * 3_600_000).toISOString(),
        intervalEnd: new Date(cycleMs + h * 3_600_000).toISOString(),
      }));
      const loadedRun = new Map(runBuild.manifest.frames.map(fr => [fr.id, { ...profile.frames[0]!, ...fr, id: fr.id }]));
      return createPointForecast(runBuild, pt)(runBuild.manifest.frames, loadedRun);
    };
    const siteRunA = makeRunSite('2026-11-24T06:00:00.000Z', [2, 5, 8, 11, 14, 17]); // aligned to 08Z (3a/6a/9a/12p/3p EST)
    const siteRunB = makeRunSite('2026-11-24T12:00:00.000Z', [1, 4, 7, 10, 13, 16]); // aligned to 13Z (8a/11a/2p EST)
    const siteRunBFresh = makeRunSite('2026-11-24T12:00:00.000Z', [1, 4, 7, 10, 13, 16], { lat: 38.0001, lon: -81.5 });
    const viewRunA = buildStitchedWindgramView(siteRunA, {
      unitSystem: 'metric', compact: true, timeZone: siteRunA.site.timeZone, widthPx: 420, heightPx: 280,
      dateKeys: ['2026-11-23', '2026-11-24', '2026-11-25'],
    });
    const viewRunBAfterA = buildStitchedWindgramView(siteRunB, {
      unitSystem: 'metric', compact: true, timeZone: siteRunB.site.timeZone, widthPx: 420, heightPx: 280,
      dateKeys: ['2026-11-23', '2026-11-24', '2026-11-25'],
    });
    const viewRunBFresh = buildStitchedWindgramView(siteRunBFresh, {
      unitSystem: 'metric', compact: true, timeZone: siteRunBFresh.site.timeZone, widthPx: 420, heightPx: 280,
      dateKeys: ['2026-11-23', '2026-11-24', '2026-11-25'],
    });
    const ticksA = sceneData(viewRunA).dayPanels![0]!.visibleAxisIndices.map(i => sceneData(viewRunA).timeAxis[i]!.label);
    const ticksBAfterA = sceneData(viewRunBAfterA).dayPanels![0]!.visibleAxisIndices.map(i => sceneData(viewRunBAfterA).timeAxis[i]!.label);
    const ticksBFresh = sceneData(viewRunBFresh).dayPanels![0]!.visibleAxisIndices.map(i => sceneData(viewRunBFresh).timeAxis[i]!.label);
    expect(ticksA).toEqual(['9a', '12p', '3p']);
    expect(ticksBAfterA).toEqual(['8a', '11a', '2p']);
    expect(ticksBAfterA).toEqual(ticksBFresh);
  });

  it('keeps 1-Day cropped to solar daylight on nocturnal frameIds, anchors chart floor at site ground without sub-model hatching, and omits vertical tower bars', () => {
    const head = new FakeElement('head');
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: new EventTarget(),
    };

    // Armenia point (Asia/Yerevan UTC+4) across 01Z..19Z (5a..11p local)
    const armPoint = { lat: 40.0096, lon: 44.6283 };
    const hours = Array.from({ length: 19 }, (_, i) => i + 1);
    const { build, sample, profile } = fixture(hours, hours.length);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));
    for (const f of frames) {
      f.profile.modelTerrainM = 1495;
      f.layers['usable-lift-msl']!.value = 2400;
      f.layers['usable-lift-agl']!.value = 920;
    }

    const container = owner.createElement('div') as unknown as HTMLElement;
    const siteTerrainValley = {
      elevationM: 1480,
      status: 'valid' as const,
      interpolated: true,
      surfaceId: 'gfs-fine',
      surface: 'DSM',
      verticalDatum: 'EGM2008',
    };
    renderPointWindgram(container, { frames, siteTerrain: siteTerrainValley }, build, {
      point: armPoint,
      frameId: 'f001', // 01:00 UTC = 05:00 local (pre-sunrise)
      unitSystem: 'imperial',
      viewMode: '1d',
      onFrame: vi.fn(),
    });
    const host = visit(container as unknown as FakeElement).find(el => el.className === 'av-windgram-host')!;
    expect(host.innerHTML).not.toContain('>5a<');
    expect(host.innerHTML).not.toContain('>11p<');
    expect(host.innerHTML).toContain('data-height-series="modelTerrainM"');
    expect(host.innerHTML).not.toContain('class="windgram-missing"');
    disposePointWindgram(container);

    // Ridge case (Ground 1,450 m > model 1,248 m): floorM anchors at 1,450 m, clipping underground air
    for (const f of frames) f.profile.modelTerrainM = 1248;
    const ridgeSite = createPointForecast(build, armPoint, {
      siteTerrain: { ...siteTerrainValley, elevationM: 1450 },
    })(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const ridgeDay = buildWindgramView(ridgeSite, {
      unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: ridgeSite.site.timeZone,
      hours: { timeZone: ridgeSite.site.timeZone, dateKey: ridgeSite.hours[0]!.validAt.slice(0, 10) },
    });
    expect(ridgeDay.floorM).toBe(1450);
  });

  it('adopts shared Constructable Stylesheets without DOM <style> nodes when supported, emits zero inline style attributes in keys/barbs, and keeps CSS band colors in sync', async () => {
    const { adoptDocumentStyleSheet } = await import('./style-registry.ts');
    const chartCss = (await import('./styles/windgram-chart.css?inline')).default;
    const panelCss = (await import('./styles/windgram-panel.css?inline')).default;
    const { WINDGRAM_CLIMB_BANDS } = await import('./windgram-atmosphere.ts');
    const { WINDGRAM_STABILITY } = await import('./windgram-stability.ts');

    // 1) Shared CSSStyleSheet adoption across multiple documents in the same realm
    let constructed = 0;
    class MockCSSStyleSheet {
      text = '';
      constructor() { constructed++; }
      replaceSync(css: string) { this.text = css; }
    }
    const win = { CSSStyleSheet: MockCSSStyleSheet };
    const docA = { defaultView: win, adoptedStyleSheets: [] as MockCSSStyleSheet[], head: new FakeElement('head') };
    const docB = { defaultView: win, adoptedStyleSheets: [] as MockCSSStyleSheet[], head: new FakeElement('head') };
    adoptDocumentStyleSheet(docA as unknown as Document, 'test-sheet', '.x{color:red}');
    adoptDocumentStyleSheet(docA as unknown as Document, 'test-sheet', '.x{color:red}');
    adoptDocumentStyleSheet(docB as unknown as Document, 'test-sheet', '.x{color:red}');
    expect(constructed).toBe(1);
    expect(docA.adoptedStyleSheets).toHaveLength(1);
    expect(docB.adoptedStyleSheets[0]).toBe(docA.adoptedStyleSheets[0]);
    expect(docA.head.children).toHaveLength(0);

    // 2) Zero inline style="..." attributes in rendered keys across modes, and no host #app selector leak in windgram-panel.css
    expect(renderWindgramKey('metric', true, 'hybrid-climb')).not.toContain('style=');
    expect(renderWindgramKey('imperial', false, 'lapse')).not.toContain('style=');
    expect(panelCss).not.toContain('#app');

    // 3) 1:1 color sync between TS band definitions and CSS stylesheets
    for (const band of WINDGRAM_CLIMB_BANDS) {
      expect(chartCss).toContain(`.${band.className} { fill: ${band.color.toLowerCase()}; }`);
      expect(panelCss).toContain(`.wg-key-seg.${band.className} { background: ${band.color.toLowerCase()}; }`);
    }
    for (const stab of WINDGRAM_STABILITY) {
      expect(chartCss).toContain(`.meteo-gram-stab-${stab.className} { fill: ${stab.color.toLowerCase()}; }`);
      expect(panelCss).toContain(`.wg-key-seg.meteo-gram-stab-${stab.className} { background: ${stab.color.toLowerCase()}; }`);
    }
  });

  it('keeps nighttime selection authoritative without daytime hour substitution, prevents wraparound on horizon stepping, clips stitched panel symbols, and enforces exact scientific callout/shear/key rules', () => {
    // 1) F01 & F04: Nighttime selection on a daylight-cropped chart never substitutes a daytime hour or wraps around on ArrowRight/ArrowLeft
    const head = new FakeElement('head');
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: new EventTarget(),
    };
    const { build, sample, profile } = fixture([1, 6, 9, 12, 18], 5);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));
    const armPoint = { lat: 40.18, lon: 44.51 }; // Asia/Yerevan (UTC+4): f001=05:00 (pre-sunrise), f006=10:00, f009=13:00, f012=16:00, f018=22:00 (post-sunset)
    // Make f012 (16:00 local) wet/convective and f018 (22:00 local) dry/calm so any hour substitution is immediately detectable
    frames[3]!.layers['precipitation-mm-hr'] = { ...frames[3]!.layers['sfc-temp-c']!, value: 0.3 };
    frames[3]!.layers['cape-jkg'] = { ...frames[3]!.layers['sfc-temp-c']!, value: 43 };
    frames[4]!.layers['precipitation-mm-hr'] = { ...frames[4]!.layers['sfc-temp-c']!, value: 0 };
    frames[4]!.layers['cape-jkg'] = { ...frames[4]!.layers['sfc-temp-c']!, value: 0 };
    frames[4]!.layers['usable-lift-msl']!.value = 1500;
    frames[4]!.layers['usable-lift-agl']!.value = 0;
    frames[4]!.layers['thermal-velocity']!.value = 0;

    const steppedFrames: string[] = [];
    const container = owner.createElement('div') as unknown as HTMLElement;
    const handle = renderPointWindgram(container, { frames }, build, {
      point: armPoint,
      frameId: 'f018',
      mapFrameId: 'f018',
      unitSystem: 'metric',
      viewMode: '1d',
      onFrame: id => steppedFrames.push(id),
    });
    const nodes = visit(container as unknown as FakeElement);
    const timeLine = nodes.find(el => el.className === 'av-point-time')!;
    const srReadout = nodes.find(el => el.className === 'windgram-readout')!;
    const host = nodes.find(el => el.className === 'av-windgram-host')!;

    // Clock line is visible at nighttime even when pointFrame.id === mapFrameId, and readout announces 22:00 (18:00 UTC) with CAPE 0 J/kg instead of 16:00 (CAPE 43 J/kg)
    expect(timeLine.hidden).toBe(false);
    expect(timeLine.textContent).toContain('22:00');
    expect(srReadout.textContent).toContain('22:00 (18:00 UTC)');
    expect(srReadout.textContent).not.toContain('16:00');
    expect(srReadout.textContent).toContain('CAPE 0 J/kg');
    expect(srReadout.textContent).not.toContain('CAPE 43 J/kg');

    const press = (key: string) => host.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key }));
    // F04: ArrowRight at the end of the horizon (f018) is a no-op (never jumps backward to f001/f006!)
    press('ArrowRight');
    expect(steppedFrames).toEqual([]);
    // ArrowLeft from f018 steps cleanly to the preceding daylight hour (f012)
    press('ArrowLeft');
    expect(steppedFrames).toEqual(['f012']);

    // Pre-sunrise boundary (f001 = 05:00 local): ArrowLeft is a no-op, ArrowRight advances to first daylight hour (f006)
    steppedFrames.length = 0;
    handle('f001', 'metric', 'f001');
    expect(timeLine.hidden).toBe(false);
    expect(srReadout.textContent).toContain('05:00 (01:00 UTC)');
    press('ArrowLeft');
    expect(steppedFrames).toEqual([]);
    press('ArrowRight');
    expect(steppedFrames).toEqual(['f006']);
    disposePointWindgram(container);

    // 2) F02: Peak climb fallback in tile-2x2 never labels a column peak as "▲ Cu base"
    const climbVal = new FakeElement('text');
    const climbSub = new FakeElement('text');
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const rainBg = new FakeElement('rect');
    const tileMap = new Map<string, FakeElement>([
      ['[data-tile-climb-val]', climbVal],
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-sky-code]', skyCodeEl],
      ['[data-tile-cloud-text]', cloudText],
      ['[data-tile-hazard]', hazardEl],
      ['[data-tile-rain-bg]', rainBg],
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileMap.get(sel) ?? null,
    } as unknown as ParentNode);
    const site = createPointForecast(build, armPoint)(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const view = buildWindgramView(site, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: site.site.timeZone, hours: site.hours });
    const baseR = readWindgram(view, 1, 2000);
    const dummyLift = site.hours[1]!.mapLift;

    const belowGateReading = {
      ...baseR,
      cloudCapped: true,
      nativeThermalTopM: 2600,
      heightM: 2000,
      estimatedClimbMps: 0.07999,
      peakClimbMps: 1.7,
    };
    const belowGateTel = buildWindgramTelemetry(sceneData(view), belowGateReading, dummyLift, true, true);
    expect(belowGateTel.calloutSoar).toContain('Peak +1.7 m/s');
    bound.paint({ aglText: '500 m AGL', mslText: '2,000 m MSL', useTol: true, telemetry: belowGateTel, reading: belowGateReading, unitSystem: 'metric' });
    expect(climbVal.textContent).toBe('+1.7 m/s');
    expect(climbSub.textContent).toBe('▲ Peak lift');

    const aboveGateReading = { ...belowGateReading, estimatedClimbMps: 0.08 };
    const aboveGateTel = buildWindgramTelemetry(sceneData(view), aboveGateReading, dummyLift, true, true);
    expect(aboveGateTel.calloutSoar).toContain('Climb +0.1 m/s');
    bound.paint({ aglText: '500 m AGL', mslText: '2,000 m MSL', useTol: true, telemetry: aboveGateTel, reading: aboveGateReading, unitSystem: 'metric' });
    expect(climbVal.textContent).toBe('+0.1 m/s');
    expect(climbSub.textContent).toBe('▲ Cu base');

    // 3) F03: Stitched multi-day panels never spill discrete barbs, freezing marks, or cloud glyphs outside their own panel bounds
    const multiDayHours = [6, 9, 12, 15, 18, 30, 33, 36, 39, 42];
    const multiFix = fixture(multiDayHours, multiDayHours.length);
    const multiFrames = multiFix.profile.frames.map((frame, i) => ({
      ...frame,
      layers: { ...frame.layers, ...multiFix.sample.frames[i]!.layers },
    }));
    for (const f of multiFrames) {
      f.layers['surface-lcl-msl'] = { ...f.layers['sfc-temp-c']!, value: 2100 };
      f.profile.levels = [
        { pressureHpa: 880, heightM: 1700, temperatureC: 6, dewPointC: 5.8, uWindMps: 6, vWindMps: 3, omegaPaS: 0 },
        { pressureHpa: 800, heightM: 2300, temperatureC: -2, dewPointC: -2.2, uWindMps: 8, vWindMps: 4, omegaPaS: 0 },
      ];
    }
    const multiSite = createPointForecast(multiFix.build, armPoint)(
      multiFix.build.manifest.frames,
      new Map(multiFrames.map(f => [f.id, f])),
    );
    const dayKeys = [...new Set(multiSite.hours.map(h => localDateKey(h.validAt, multiSite.site.timeZone)))];
    const stitched = sceneData(
      buildStitchedWindgramView(multiSite, {
        unitSystem: 'metric',
        timeZone: multiSite.site.timeZone,
        dateKeys: dayKeys,
      }),
    );
    const panelForHour = (hourIdx: number) =>
      stitched.dayPanels!.find(p => hourIdx >= p.startHourIndex && hourIdx <= p.endHourIndex)!;
    for (const barb of stitched.barbs) {
      const p = panelForHour(barb.hourIndex);
      expect(barb.x).toBeGreaterThanOrEqual(p.left);
      expect(barb.x).toBeLessThanOrEqual(p.left + p.width);
    }
    for (const frz of stitched.freezing) {
      const p = panelForHour(frz.hourIndex);
      expect(frz.x).toBeGreaterThanOrEqual(p.left);
      expect(frz.x).toBeLessThanOrEqual(p.left + p.width);
    }
    for (const cld of stitched.clouds) {
      const p = panelForHour(cld.hourIndex);
      expect(cld.x).toBeGreaterThanOrEqual(p.left);
      expect(cld.x).toBeLessThanOrEqual(p.left + p.width);
    }

    // 4) F05A, F05B, F06, F07: Cloud fraction vs RH moist layer, missing humidity with 80% sky cover, dry top at LCL, and full-precision icing + precip
    // F05A: Supplied 0.5% cloud cover + 95% RH moist layer preserves SKY 1% and reports Moist RH instead of OVC 90% or Clear
    const f05aHour = {
      ...site.hours[1]!,
      surface: {
        ...site.hours[1]!.surface,
        cloudCoverTotalPercent: 0.5,
        cloudCoverLowPercent: 0.5,
      },
      levels: [
        { pressureHpa: 880, heightM: 1700, temperatureC: 10, dewPointC: 9.3, uWindMps: 3, vWindMps: 2, omegaPaS: 0 },
        { pressureHpa: 850, heightM: 2000, temperatureC: 8, dewPointC: 7.3, uWindMps: 4, vWindMps: 2, omegaPaS: 0 },
      ],
    };
    const f05aAnalysis = analyzeHourCloudLayers(f05aHour, hourSampling(f05aHour), 4000);
    bound.paint({
      aglText: '100 m AGL',
      mslText: '1,600 m MSL',
      useTol: false,
      telemetry: belowGateTel,
      reading: {
        ...baseR,
        heightM: 1600,
        cloudCoverTotalPercent: 0.5,
        cloudCoverLowPercent: 0.5,
        relativeHumidityPercent: 70,
        cloudHumidityPercent: 70,
        cloud: null,
        cloudLayers: f05aAnalysis.layers,
        activeCloudLayer: null,
        nearestCloudBaseAboveM: 1700,
      },
      unitSystem: 'metric',
    });
    expect(skyCodeEl.textContent).toBe('SKY 1%');
    expect(cloudText.textContent).toBe('Moist RH · Base +100 m');

    // F05B: 80% total cloud cover with all humidity/dewpoint absent renders SKY 80% + Local RH — · Sky 80% (never HI 80% / Clear · High cirrus)
    const f05bHour = {
      ...site.hours[1]!,
      surface: {
        ...site.hours[1]!.surface,
        cloudCoverTotalPercent: 80,
        cloudCoverLowPercent: null,
      },
      levels: site.hours[1]!.levels.map(l => ({ ...l, dewPointC: null })),
    };
    const f05bAnalysis = analyzeHourCloudLayers(f05bHour, hourSampling(f05bHour), 4000);
    expect(f05bAnalysis.highCloudOnly).toBe(false);
    bound.paint({
      aglText: '500 m AGL',
      mslText: '2,000 m MSL',
      useTol: false,
      telemetry: belowGateTel,
      reading: {
        ...baseR,
        cloudCoverTotalPercent: 80,
        cloudCoverLowPercent: null,
        relativeHumidityPercent: null,
        cloudHumidityPercent: null,
        cloud: null,
        cloudLayers: [],
        activeCloudLayer: null,
        highCloudOnly: f05bAnalysis.highCloudOnly,
      },
      unitSystem: 'metric',
    });
    expect(skyCodeEl.textContent).toBe('SKY 80%');
    expect(cloudText.textContent).toBe('Local RH — · Sky 80%');

    // F06: Dry parcel top exactly at LCL (1,800 m) with cuPotentialM = 0 has depthM = 0 (no artificial 120 m cloud thickness)
    const f06Hour = {
      ...site.hours[1]!,
      surfaceLclM: 1800,
      effectiveCloudLimitM: 1800,
      thermalTopM: 1800,
      cuPotentialM: 0,
      cloudCapped: true,
      overdeveloped: false,
      levels: site.hours[1]!.levels.map(l => ({ ...l, dewPointC: l.temperatureC !== null ? l.temperatureC - 12 : null })),
    };
    const f06Analysis = analyzeHourCloudLayers(f06Hour, hourSampling(f06Hour), 4000);
    expect(f06Analysis.convectiveLayer?.depthM).toBe(0);
    expect(f06Analysis.convectiveLayer?.topM).toBe(1800);

    // F07: Exact 4-row table at -10 °C (14 °F)
    const paintF07 = (rh: number, precipMmHr: number) => {
      bound.paint({
        aglText: '900 m AGL',
        mslText: '2,400 m MSL',
        useTol: false,
        telemetry: belowGateTel,
        reading: {
          ...baseR,
          temperatureF: 14, // -10 °C
          dewPointC: -10.5,
          relativeHumidityPercent: rh,
          cloudHumidityPercent: rh,
          cloud: rh >= 94 ? 'humidity' : null,
          precipitationMmHr: precipMmHr,
          capeJkg: 0,
          windShear: null,
        },
        unitSystem: 'metric',
      });
      return hazardEl.textContent;
    };
    expect(paintF07(93.49, 0)).toBe('Dry');
    expect(paintF07(93.51, 0)).toBe('Dry');
    expect(paintF07(94.0, 0)).toBe('❄ Icing risk');
    expect(paintF07(96.0, 1.0)).toBe('1.0 mm/h · ❄ Icing risk');
    expect(rainBg.getAttribute('class')).toContain('is-danger');

    // 5) F08: Low-level wind jet at 15 m and 20 m model AGL is captured in maxDepartureFromSurfaceMps
    for (const aglM of [15, 20, 21]) {
      const jetFix = fixture([12], 1);
      const jf = {
        ...jetFix.profile.frames[0]!,
        layers: { ...jetFix.profile.frames[0]!.layers, ...jetFix.sample.frames[0]!.layers },
      };
      jf.profile.modelTerrainM = 100;
      jf.layers['usable-lift-msl']!.value = 1000;
      jf.layers['thermal-top-msl']!.value = 1000;
      jf.layers['thermal-velocity']!.value = 2.0;
      jf.layers['wind-10m-u'] = { ...jf.layers['sfc-temp-c']!, value: 2 };
      jf.layers['wind-10m-v'] = { ...jf.layers['sfc-temp-c']!, value: 0 };
      jf.profile.levels = [
        { pressureHpa: 990, heightM: 100 + aglM, temperatureC: 15, dewPointC: 5, uWindMps: 25, vWindMps: 0, omegaPaS: 0 },
        { pressureHpa: 900, heightM: 1000, temperatureC: 6, dewPointC: 0, uWindMps: 2, vWindMps: 0, omegaPaS: 0 },
      ];
      const jetSite = createPointForecast(jetFix.build, armPoint)(
        jetFix.build.manifest.frames,
        new Map([[jf.id, jf]]),
      );
      const jetScene = buildWindgramView(jetSite, {
        unitSystem: 'metric',
        compact: false,
        heightRange: 'soaring',
        timeZone: jetSite.site.timeZone,
        hours: jetSite.hours,
      });
      expect(readWindgram(jetScene, 0, 500).publishedLayerWind?.maxDepartureFromSurfaceMps).toBeCloseTo(23, 5);
    }

    // 6) F16 & F17: Southern Hemisphere key barb mirroring and "Weak inv" lapse label
    const northKey = renderWindgramKey('metric', false, 'hybrid-climb', false);
    const southKey = renderWindgramKey('metric', false, 'hybrid-climb', true);
    expect(southKey).not.toBe(northKey);
    const lapseKey = renderWindgramKey('metric', false, 'lapse', false);
    expect(lapseKey).toContain('Weak inv');
    expect(lapseKey).not.toContain('Very stbl');
  });
});
