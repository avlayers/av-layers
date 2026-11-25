import { INDEXED_GRID } from '../../../tests/model-fixtures.js';
import { NORTHERN_LAMBERT, SOUTHERN_LAMBERT } from '../../../tests/lambert-fixtures.js';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/lambert.json';
import { gridSchema } from './grid-schema.js';
import { boundsOverlap, boundsOverlapFraction, earthVectorToGrid, geographicToGrid, gridOutline, gridToGeographic, gridVectorToEarth, prepareGridGeometry, withinGeographicBounds, type Grid, type LambertConformalGrid, type RotatedLatLonGrid } from './geometry.js';
import { isCovered, type CoverageMask } from './index.js';
import { getProduct } from './products.js';

const grid = gridSchema.parse(fixture.grid) as LambertConformalGrid;

describe('native spherical grid geometry', () => {
  it('matches independent PROJ secant LCC controls in both directions', () => {
    const geometry = prepareGridGeometry(grid);
    for (const point of fixture.controlPoints) {
      const projected = geometry.geographicToGrid(point.lat, point.lon)!;
      expect(projected.x * grid.dxM + grid.x0M).toBeCloseTo(point.xM, 6);
      expect(projected.y * grid.dyM + grid.y0M).toBeCloseTo(point.yM, 6);
      const inverse = geometry.gridToGeographic((point.xM - grid.x0M) / grid.dxM, (point.yM - grid.y0M) / grid.dyM)!;
      expect(inverse.lat).toBeCloseTo(point.lat, 10);
      expect(inverse.lon).toBeCloseTo(point.lon, 10);
    }
  });

  it('handles southern and tangent cones against independently generated controls', () => {
    // PROJ 9.6.0: same command with parallels -30,-60, origin -40, meridian 140.
    const south = prepareGridGeometry({ ...grid, centralMeridianDeg: 140, latitudeOfOriginDeg: -40, standardParallel1Deg: -30, standardParallel2Deg: -60, x0M: 0, y0M: 0, dxM: 1, dyM: -1 });
    const p = south.geographicToGrid(-45, 150)!;
    expect(p.x).toBeCloseTo(757366.5627555274, 6);
    expect(p.y).toBeCloseTo(585230.9026221951, 6);
    expect(south.gridToGeographic(p.x, p.y)!.lat).toBeCloseTo(-45, 10);
    expect(south.gridToGeographic(p.x, p.y)!.lon).toBeCloseTo(150, 10);
    // PROJ 9.6.0: parallels 40,40; origin 40; meridian -100; sphere 6371229.
    const tangent = prepareGridGeometry({ ...grid, standardParallel1Deg: 40, standardParallel2Deg: 40, x0M: 0, y0M: 0, dxM: -1, dyM: 1 });
    const t = tangent.geographicToGrid(45, -90)!;
    expect(t.x).toBeCloseTo(-787721.8109120375, 6);
    expect(t.y).toBeCloseTo(600947.9564130091, 6);
    expect(tangent.gridToGeographic(t.x, t.y)!.lat).toBeCloseTo(45, 10);
  });

  // PROJ 9.6.0, +proj=lcc +R=6370000 with the parallels, origin and meridian of each grid.
  it.each([
    { region: 'Northern Hemisphere', grid: NORTHERN_LAMBERT, points: [
      [40.179, 44.499, -84.924586148, -2334.214483120],
      [40.523, 44.195, -25770.559119895, 35946.908359112],
      [40.317, 45.350, 72037.905672342, 13349.849124622]
    ] },
    { region: 'New Zealand', grid: SOUTHERN_LAMBERT, points: [
      [-44.487, 169.969, -200816.799545267, -368088.588265303],
      [-43.595, 170.142, -189772.575804235, -268565.214905415],
      [-41.2865, 174.7762, 189875.709553508, -12079.414833767]
    ] }
  ])('matches PROJ coordinates and their inverse in $region', ({ grid, points }) => {
    const geometry = prepareGridGeometry(grid);
    for (const [lat, lon, xM, yM] of points) {
      const projected = geometry.geographicToGrid(lat, lon)!;
      expect(projected.x * grid.dxM + grid.x0M).toBeCloseTo(xM, 6);
      expect(projected.y * grid.dyM + grid.y0M).toBeCloseTo(yM, 6);
      const inverse = geometry.gridToGeographic((xM - grid.x0M) / grid.dxM, (yM - grid.y0M) / grid.dyM)!;
      expect(inverse.lat).toBeCloseTo(lat, 10);
      expect(inverse.lon).toBeCloseTo(lon, 10);
    }
  });

  it.each([
    [-44.487, 169.969, 1.66124534],
    [-41.2865, 174.7762, -1.49400500]
  ])('rotates New Zealand grid winds at %s, %s using PROJ convergence', (lat, lon, convergenceDeg) => {
    const rotation = prepareGridGeometry(SOUTHERN_LAMBERT).rotationAndMetrics(lat, lon)!;
    const theta = convergenceDeg * Math.PI / 180;
    const u = gridVectorToEarth(1, 0, rotation), v = gridVectorToEarth(0, 1, rotation);
    expect(u.east).toBeCloseTo(Math.cos(theta), 8);
    expect(u.north).toBeCloseTo(-Math.sin(theta), 8);
    expect(v.east).toBeCloseTo(Math.sin(theta), 8);
    expect(v.north).toBeCloseTo(Math.cos(theta), 8);
  });

  it('keeps grid-vector rotation separate from storage direction and validates metric scale', () => {
    const metrics = prepareGridGeometry(grid).rotationAndMetrics(45, -90)!;
    // Independent `proj -V`: convergence 7.15566847 degrees, scale 0.96571753.
    const theta = 7.15566847 * Math.PI / 180;
    expect(metrics.cos).toBeCloseTo(Math.cos(theta), 8);
    expect(metrics.sin).toBeCloseTo(Math.sin(theta), 8);
    expect(metrics.mapScale).toBeCloseTo(0.96571753, 8);
    expect(gridVectorToEarth(1, 0, metrics).north).toBeCloseTo(-Math.sin(theta), 8);
    expect(gridVectorToEarth(0, 1, metrics).east).toBeCloseTo(Math.sin(theta), 8);
    const earth = gridVectorToEarth(12, -7, metrics), back = earthVectorToGrid(earth.east, earth.north, metrics);
    expect(back.u).toBeCloseTo(12, 12);
    expect(back.v).toBeCloseTo(-7, 12);
    const reversed = prepareGridGeometry({ ...grid, dxM: -grid.dxM, dyM: -grid.dyM }).rotationAndMetrics(45, -90)!;
    expect(reversed).toEqual(metrics);
    for (const lat of [30, 60]) expect(prepareGridGeometry(grid).rotationAndMetrics(lat, -100)!.mapScale).toBeCloseTo(1, 12);
    const spherical = prepareGridGeometry(INDEXED_GRID).rotationAndMetrics(60, 0)!;
    expect(spherical.metersPerColumn / spherical.metersPerRow).toBeCloseTo(0.5, 12);
    expect(prepareGridGeometry(INDEXED_GRID).rotationAndMetrics(90, 0)).toBeNull();
  });

  it('matches ECCC HRDPS Continental 2.5 km rotated lat-lon controls and orthogonal wind rotation', () => {
    const hrdpsGrid: RotatedLatLonGrid = {
      kind: 'rotated-latlon', width: 2540, height: 1290, earthRadiusM: 6371229,
      lon0: -14.82122, lat0: -12.302501, dx: 0.0225, dy: 0.0225,
      southPoleLatDeg: -36.08852, southPoleLonDeg: -114.694858, wrapLongitude: false
    };
    expect(gridSchema.parse(hrdpsGrid)).toEqual(hrdpsGrid);
    const geometry = prepareGridGeometry(hrdpsGrid);
    const controls = [
      { x: 0, y: 0, lat: 39.626034, lon: -133.62952 },
      { x: 2539, y: 0, lat: 27.284597, lon: -66.96642 },
      { x: 585, y: 346, lat: 49.364271, lon: -117.234411 },
      { x: 2539, y: 1289, lat: 47.876457, lon: -40.708557 }
    ] as const;
    for (const point of controls) {
      const geo = geometry.gridToGeographic(point.x, point.y)!;
      expect(geo.lat).toBeCloseTo(point.lat, 4);
      expect(geo.lon).toBeCloseTo(point.lon, 4);
      const fromControl = geometry.geographicToGrid(point.lat, point.lon)!;
      expect(fromControl.x).toBeCloseTo(point.x, 3);
      expect(fromControl.y).toBeCloseTo(point.y, 3);
      const gridPoint = geometry.geographicToGrid(geo.lat, geo.lon)!;
      expect(gridPoint.x).toBeCloseTo(point.x, 9);
      expect(gridPoint.y).toBeCloseTo(point.y, 9);
      const rotation = geometry.rotationAndMetrics(geo.lat, geo.lon)!;
      expect(Math.hypot(rotation.cos, rotation.sin)).toBeCloseTo(1, 12);
      expect(rotation.mapScale).toBeNull();
      const earth = gridVectorToEarth(8.5, -3.25, rotation);
      const back = earthVectorToGrid(earth.east, earth.north, rotation);
      expect(back.u).toBeCloseTo(8.5, 12);
      expect(back.v).toBeCloseTo(-3.25, 12);
    }
  });

  it('requires an explicit admitted geometry and rejects singular/oversized inputs', () => {
    for (const invalid of [
      { ...grid, kind: undefined }, { ...grid, wrapLongitude: true }, { ...grid, dxM: 0 },
      { ...grid, earthRadiusM: 0 }, { ...grid, standardParallel1Deg: 90 },
      { ...grid, standardParallel1Deg: 30, standardParallel2Deg: -30 },
      { ...grid, width: 100000, height: 100000 }
    ]) {
      expect(gridSchema.safeParse(invalid).success).toBe(false);
      expect(() => prepareGridGeometry(invalid as Grid)).toThrow('Invalid grid geometry');
    }
    const geometry = prepareGridGeometry(grid);
    expect(geometry.geographicToGrid(90, 0)).toBeNull();
    expect(geometry.geographicToGrid(NaN, 0)).toBeNull();
    expect(geometry.gridToGeographic(Infinity, 1)).toBeNull();
  });

  it('preserves periodic regular-grid nodes and removes global latitude policy from coverage', () => {
    expect(geographicToGrid(INDEXED_GRID, 10.125, 179.875)).toEqual({ x: 1439.5, y: 319.5 });
    expect(geographicToGrid(INDEXED_GRID, 90, 180)).toEqual({ x: 0, y: -0 });
    const mask: CoverageMask = { grid: { ...INDEXED_GRID, width: 2, height: 2, lon0: 0, lat0: 71, dx: 1, dy: -1, wrapLongitude: false }, output: Uint8Array.of(15), halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0 };
    expect(isCovered(mask, 70.5, 0.5)).toBe(true);
    expect(isCovered({ ...mask, bounds: [-180, -55, 180, 65] }, 70.5, 0.5)).toBe(false);
    expect(withinGeographicBounds(0, 179, [170, -10, -170, 10])).toBe(true);
    expect(withinGeographicBounds(0, -179, [170, -10, -170, 10])).toBe(true);
    expect(withinGeographicBounds(0, 0, [170, -10, -170, 10])).toBe(false);
    expect(withinGeographicBounds(0, 180, [-180, -10, -170, 10])).toBe(true);
    expect(boundsOverlap([-130, 30, -120, 40], [-125, 35, -115, 45])).toBe(true);
    expect(boundsOverlap([-130, 30, -120, 40], [-119, 35, -115, 45])).toBe(false);
    expect(boundsOverlap([170, -50, -170, -30], [175, -45, 190, -35])).toBe(true);
    expect(boundsOverlap([-180, -10, -170, 10], [170, -10, 180, 10])).toBe(true);
    expect(boundsOverlapFraction([-80, 38, -77, 40], [-79, 38, -78, 39])).toBeCloseTo(1 / 6, 6);
    expect(boundsOverlapFraction([-189.99999999999997, -50, 170, 50], [-180, -50, 180, 50])).toBeCloseTo(1, 6);
    expect(boundsOverlapFraction([-100, 40, -100, 40], [-105, 35, -95, 45])).toBe(0);
  });

  it('traces cell-center corners and bows a Lambert edge past its corners', () => {
    const icon = getProduct('icon-eu')!.grid;
    const [ring] = gridOutline(icon);
    expect(gridOutline(icon)).toHaveLength(1);
    expect(ring![0]).toEqual({ lat: 70.5, lon: -23.5 });
    expect(ring!.at(-2)).toEqual(gridToGeographic(icon, 0, icon.height - 1));
    expect(ring!.at(-1)).toEqual(ring![0]);
    expect(ring!.some(point => point.lon === 62.5 && point.lat === 29.5)).toBe(true);
    const rrfs = getProduct('rrfs')!.grid;
    if (rrfs.kind !== 'lambert-conformal') throw new Error('rrfs grid');
    const top = rrfs.height - 1, right = rrfs.width - 1;
    const corners = Math.max(gridToGeographic(rrfs, 0, top)!.lat, gridToGeographic(rrfs, right, top)!.lat);
    const outline = gridOutline(rrfs);
    expect(Math.max(...outline.flat().map(point => point.lat))).toBeGreaterThan(corners + 1);
    const polar = { ...NORTHERN_LAMBERT, width: 80, height: 40, x0M: -120_000, y0M: 7_418_672.785397771, dxM: 3_000, dyM: 3_000 };
    const poleEnds = [gridToGeographic(polar, 31, 39)!, gridToGeographic(polar, 47, 39)!];
    expect(gridToGeographic(polar, 40, 39)).toBeNull();
    expect(Math.abs(poleEnds[0]!.lon - poleEnds[1]!.lon)).toBeLessThanOrEqual(180);
    expect(gridOutline(polar).flat()).toEqual(expect.arrayContaining(poleEnds));
    expect(gridOutline(polar).some(line => line.some((point, index) => index > 0 && point.lon === poleEnds[1]!.lon && line[index - 1]!.lon === poleEnds[0]!.lon))).toBe(false);
    const split = gridOutline({ ...rrfs, centralMeridianDeg: 179 });
    expect(split.length).toBeGreaterThan(1);
    for (const line of [...outline, ...split]) {
      for (let index = 1; index < line.length; index += 1) expect(Math.abs(line[index]!.lon - line[index - 1]!.lon)).toBeLessThanOrEqual(180);
    }
    const pacific = { kind: 'regular-latlon' as const, width: 4, height: 4, earthRadiusM: 6_371_229, lon0: 178, lat0: 10, dx: 1, dy: -1, wrapLongitude: false };
    const pacificRing = gridOutline(pacific);
    expect(pacificRing).toHaveLength(1);
    expect(pacificRing[0]!.at(-1)).toEqual(pacificRing[0]![0]);
    expect(pacificRing[0]!.some(point => point.lon === 181)).toBe(true);
    const wide = gridOutline({ ...pacific, width: 3, height: 2, lon0: 0, lat0: 1, dx: 90.5 });
    expect(wide.flat().some(point => point.lon === 181)).toBe(true);
    expect(wide.some(line => line.some((point, index) => index > 0 && Math.min(point.lon, line[index - 1]!.lon) < 1 && Math.max(point.lon, line[index - 1]!.lon) > 180))).toBe(false);
    expect(gridOutline(getProduct('gfs')!.grid)).toEqual([]);
    expect(gridOutline({ ...INDEXED_GRID, width: 0 })).toEqual([]);
  });
});
