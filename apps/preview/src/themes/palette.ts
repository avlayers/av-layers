import { LIFT_COLORS, LIFT_EDGES } from '@av/contracts/layers';
import { themeOption, type MapTheme } from './registry';
import type { RgbaStop } from './theme';

/** Colour ramps and legends derived from a theme record. */

export function sampleStops(stops: readonly RgbaStop[], value: number, out: Uint8Array | Uint8ClampedArray, offset = 0): void {
  if (value <= stops[0]!.at) {
    const first = stops[0]!;
    out[offset] = first.r; out[offset + 1] = first.g; out[offset + 2] = first.b; out[offset + 3] = first.a;
    return;
  }
  const last = stops[stops.length - 1]!;
  if (value >= last.at) {
    out[offset] = last.r; out[offset + 1] = last.g; out[offset + 2] = last.b; out[offset + 3] = last.a;
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    const right = stops[i]!;
    if (value <= right.at) {
      const left = stops[i - 1]!;
      const t = (value - left.at) / Math.max(1e-6, right.at - left.at);
      out[offset] = Math.round(left.r + (right.r - left.r) * t);
      out[offset + 1] = Math.round(left.g + (right.g - left.g) * t);
      out[offset + 2] = Math.round(left.b + (right.b - left.b) * t);
      out[offset + 3] = Math.round(left.a + (right.a - left.a) * t);
      return;
    }
  }
}

function rgbaCss(r: number, g: number, b: number, a = 255): string {
  return a >= 254 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}

export function themeLiftLegendColors(theme: MapTheme, edges: readonly number[] = LIFT_EDGES, count = 22): string[] {
  const opt = themeOption(theme);
  if (!opt.remap) return LIFT_COLORS.slice(0, count);
  const stops = opt.liftStops;
  const pixel = new Uint8Array(4);
  const colors: string[] = [];
  for (let i = 0; i < count; i++) {
    const lo = edges[i] ?? 0;
    const hi = edges[i + 1] ?? (lo + 300);
    const mid = (lo + hi) * 0.5;
    const sampleAt = opt.liftMode === 'stepped-contour' && opt.liftContourStepM > 0
      ? Math.floor(mid / opt.liftContourStepM) * opt.liftContourStepM + opt.liftContourStepM * 0.5
      : mid;
    sampleStops(stops, sampleAt, pixel, 0);
    colors.push(rgbaCss(pixel[0]!, pixel[1]!, pixel[2]!, Math.max(96, pixel[3]!)));
  }
  return colors;
}
