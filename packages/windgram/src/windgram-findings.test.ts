import { describe, expect, it } from 'vitest';
import { dewPointFromSpecificHumidityC, dewpointFromTempAndRhC } from '@av/thermodynamics';
import { buildStitchedWindgramView, buildWindgramView, createPointForecast, readWindgram, resolveCivilTimeZone } from './model.ts';
import { sceneData } from './scene-store.ts';
import { renderWindgramSvg } from './svg.ts';
import { formatWindgramReading } from './windgram-readout.ts';
import { getWindgramCalloutRenderer } from './windgram-callout.ts';
import { placeWindgramCallout } from './windgram-callout-placement.ts';
import { mpsToKnots } from './windgram-format.ts';
import { FakeElement, fixture, point } from './windgram-test-fixture.ts';

describe('Windgram review findings', () => {
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
});
