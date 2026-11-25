"""Project geographic policy geometry onto configured spherical Lambert or rotated lat-lon cells."""
import math

import numpy as np
from pyproj import CRS, Transformer
from shapely import make_valid, prepare, segmentize
from shapely.geometry import box
from shapely.ops import transform


class ProjectedFootprints:
    def __init__(self, grid, bounds):
        if grid['kind'] not in ('lambert-conformal', 'rotated-latlon') or grid['wrapLongitude']:
            raise ValueError('Expected a non-wrapping projected grid')
        self.grid, self.bounds = grid, bounds
        if grid['kind'] == 'lambert-conformal':
            if not all(math.isfinite(grid[key]) and grid[key] != 0 for key in ('dxM', 'dyM')):
                raise ValueError('Projected grid spacing must be finite and nonzero')
            sphere = CRS.from_proj4(f"+proj=longlat +R={grid['earthRadiusM']} +no_defs")
            projected = CRS.from_proj4(
                f"+proj=lcc +R={grid['earthRadiusM']} +lon_0={grid['centralMeridianDeg']} "
                f"+lat_0={grid['latitudeOfOriginDeg']} +lat_1={grid['standardParallel1Deg']} "
                f"+lat_2={grid['standardParallel2Deg']} +units=m +no_defs")
            self.forward_transform = Transformer.from_crs(sphere, projected, always_xy=True).transform
            self.inverse_transform = Transformer.from_crs(projected, sphere, always_xy=True).transform
            self.x0, self.dx = grid['x0M'], grid['dxM']
            self.y0, self.dy = grid['y0M'], grid['dyM']
            self.step_m = min(abs(self.dx), abs(self.dy))
            self.step_deg = math.degrees(self.step_m / grid['earthRadiusM'])
            self.step_proj = self.step_m
        else:
            if not all(math.isfinite(grid[key]) and grid[key] > 0 for key in ('dx', 'dy')):
                raise ValueError('Rotated grid spacing must be finite and positive')
            if not (math.isfinite(grid['southPoleLatDeg']) and -90 <= grid['southPoleLatDeg'] < 90):
                raise ValueError('Rotated grid southPoleLatDeg must be in [-90, 90)')
            if not (math.isfinite(grid['southPoleLonDeg']) and -180 <= grid['southPoleLonDeg'] <= 180):
                raise ValueError('Rotated grid southPoleLonDeg must be in [-180, 180]')
            self.x0, self.dx = grid['lon0'], grid['dx']
            self.y0, self.dy = grid['lat0'], grid['dy']
            self.step_deg = min(abs(self.dx), abs(self.dy))
            self.step_proj = self.step_deg
            theta = math.radians(90.0 + grid['southPoleLatDeg'])
            phi = math.radians(grid['southPoleLonDeg'])
            st, ct = math.sin(theta), math.cos(theta)
            def forward_transform(lon, lat, z=None):
                lon_r = np.radians(lon) - phi
                lat_r = np.radians(lat)
                cl, sl = np.cos(lat_r), np.sin(lat_r)
                x = ct * cl * np.cos(lon_r) + st * sl
                y = -cl * np.sin(lon_r)
                z_ = -st * cl * np.cos(lon_r) + ct * sl
                return np.degrees(np.arctan2(-y, x)), np.degrees(np.arcsin(np.clip(z_, -1.0, 1.0)))
            def inverse_transform(rlon, rlat, z=None):
                rlon_r = np.radians(rlon)
                rlat_r = np.radians(rlat)
                cr, sr = np.cos(rlat_r), np.sin(rlat_r)
                xr, yr = cr * np.cos(rlon_r), cr * np.sin(rlon_r)
                x = ct * xr - st * sr
                y = yr
                z_ = st * xr + ct * sr
                lon = (np.degrees(np.arctan2(y, x)) + grid['southPoleLonDeg'] + 540.0) % 360.0 - 180.0
                lat = np.degrees(np.arcsin(np.clip(z_, -1.0, 1.0)))
                return lon, lat
            self.forward_transform = forward_transform
            self.inverse_transform = inverse_transform
        self.region = self.project(box(*bounds)).intersection(self.rectangle(0, grid['width'] - 1, 0, grid['height'] - 1))
        prepare(self.region)

    def project(self, geometry):
        clipped = geometry.intersection(box(*self.bounds))
        return make_valid(transform(self.forward_transform, segmentize(clipped, self.step_deg))) if not clipped.is_empty else clipped

    def rectangle(self, x0, x1, y0, y1):
        xs = [self.x0 + (x0 - .5) * self.dx, self.x0 + (x1 + .5) * self.dx]
        ys = [self.y0 + (y0 - .5) * self.dy, self.y0 + (y1 + .5) * self.dy]
        return box(min(xs), min(ys), max(xs), max(ys))

    def footprints(self, x0, x1, y0, y1):
        clipped = self.rectangle(x0, x1, y0, y1).intersection(self.region)
        return [] if clipped.is_empty else [clipped]

    def geographic(self, geometry):
        return transform(self.inverse_transform, segmentize(geometry, self.step_proj))

    def nearest(self, lat, lon):
        x, y = self.forward_transform(lon, lat)
        return float((x - self.x0) / self.dx), float((y - self.y0) / self.dy)
