import { describe, expect, it } from 'vitest';
import { profileResponseSchema, SUPPORT_CUMULUS } from '@av/contracts';
import { formatPointMapLift, type PointFrame } from '@av/client';
import { buildWindgramView, createPointForecast, readWindgram } from './model.ts';
import { sceneData } from './scene-store.ts';
import { renderWindgramKey, renderWindgramSvg } from './svg.ts';
import { formatWindgramReading } from './windgram-readout.ts';
import { elevationTickMeters, roundedElevationLabel } from './windgram-format.ts';
import { hourSampling, sampleHeight } from './windgram-sampling.ts';
import { fixture, point } from './windgram-test-fixture.ts';

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

describe('Windgram scene', () => {
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
});
