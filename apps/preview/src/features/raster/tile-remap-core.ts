import { LIFT_COLORS, LIFT_EDGES, RAIN_COLORS, RAIN_EDGES } from '@av/contracts/layers';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { liftStopsForTheme, rainStopsForTheme, sampleStops, themeOption, type MapTheme } from '../map/visual-theme';

export type RemapKind = 'lift' | 'rain';

const LUT_SIZE = 32_768;
const MAX_COLOR_DIST_SQ = 1_200;
const STOP_RAMP_SIZE = 1_024;
const MAX_LIFT_VAL = 6_700;
const MAX_RAIN_VAL = 55;

let liftDecodeLut: Float32Array | null = null;
let rainDecodeLut: Float32Array | null = null;
const rampCache = new Map<string, Uint8Array>();

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16)
  ];
}

function buildRgb555Lut(colors: readonly string[], edges: readonly number[], topSpan: number): Float32Array {
  const lut = new Float32Array(LUT_SIZE).fill(-1);
  const rgb = colors.map(parseHexRgb);
  const midpoints = colors.map((_, i) => {
    const lo = edges[i] ?? 0;
    const hi = edges[i + 1] ?? (lo + topSpan);
    return (lo + hi) * 0.5;
  });
  for (let r5 = 0; r5 < 32; r5++) {
    const r = (r5 << 3) | (r5 >> 2);
    for (let g5 = 0; g5 < 32; g5++) {
      const g = (g5 << 3) | (g5 >> 2);
      for (let b5 = 0; b5 < 32; b5++) {
        const b = (b5 << 3) | (b5 >> 2);
        let bestIdx = -1;
        let bestDist = MAX_COLOR_DIST_SQ + 1;
        for (let i = 0; i < rgb.length; i++) {
          const [cr, cg, cb] = rgb[i]!;
          const dr = r - cr, dg = g - cg, db = b - cb;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0 && bestDist <= MAX_COLOR_DIST_SQ) {
          lut[(r5 << 10) | (g5 << 5) | b5] = midpoints[bestIdx]!;
        }
      }
    }
  }
  return lut;
}

function decodeLutFor(kind: RemapKind): Float32Array {
  if (kind === 'rain') {
    rainDecodeLut ??= buildRgb555Lut(RAIN_COLORS, RAIN_EDGES, 20);
    return rainDecodeLut;
  }
  liftDecodeLut ??= buildRgb555Lut(LIFT_COLORS, LIFT_EDGES, 300);
  return liftDecodeLut;
}

function rampLutFor(kind: RemapKind, theme: MapTheme): Uint8Array {
  const key = `${kind}:${theme}`;
  let ramp = rampCache.get(key);
  if (ramp) return ramp;
  ramp = new Uint8Array(STOP_RAMP_SIZE * 4);
  const stops = kind === 'rain' ? rainStopsForTheme(theme) : liftStopsForTheme(theme);
  const maxVal = kind === 'rain' ? MAX_RAIN_VAL : MAX_LIFT_VAL;
  for (let i = 0; i < STOP_RAMP_SIZE; i++) {
    const val = (i / (STOP_RAMP_SIZE - 1)) * maxVal;
    sampleStops(stops, val, ramp, i * 4);
  }
  rampCache.set(key, ramp);
  return ramp;
}

export interface RemapScratch {
  scalarA: Float32Array;
  scalarB: Float32Array;
  coverageA: Float32Array;
  coverageB: Float32Array;
}

export function createRemapScratch(initialPixels = RASTER_TILE_SIZE * RASTER_TILE_SIZE): RemapScratch {
  return {
    scalarA: new Float32Array(initialPixels),
    scalarB: new Float32Array(initialPixels),
    coverageA: new Float32Array(initialPixels),
    coverageB: new Float32Array(initialPixels)
  };
}

function ensureScratchCapacity(scratch: RemapScratch, pixelCount: number): void {
  if (scratch.scalarA.length >= pixelCount) return;
  scratch.scalarA = new Float32Array(pixelCount);
  scratch.scalarB = new Float32Array(pixelCount);
  scratch.coverageA = new Float32Array(pixelCount);
  scratch.coverageB = new Float32Array(pixelCount);
}

let defaultScratch: RemapScratch | null = null;

function crossesStep(v: number, vr: number, vd: number, invStep: number): boolean {
  const band = (v * invStep) | 0;
  return (vr >= 0 && ((vr * invStep) | 0) !== band) || (vd >= 0 && ((vd * invStep) | 0) !== band);
}

function crossesThreshold(v: number, vr: number, vd: number, threshold: number): boolean {
  return (vr >= 0 && (v < threshold) !== (vr < threshold)) || (vd >= 0 && (v < threshold) !== (vd < threshold));
}

/**
 * Remaps discrete server palette pixels into theme-specific continuous, terraced,
 * isoline, or hatched meteorological encodings using O(1) prebaked ramp LUTs.
 */
export function remapRgbaInPlace(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  kind: RemapKind,
  theme: MapTheme,
  maskPixels?: Uint8ClampedArray | null,
  scratchArg?: RemapScratch
): void {
  if (theme === 'classic') return;
  const count = width * height;
  if (count <= 0) return;
  const scratch = scratchArg ?? (defaultScratch ??= createRemapScratch(count));
  ensureScratchCapacity(scratch, count);

  const opt = themeOption(theme);
  const lut = decodeLutFor(kind);
  const ramp = rampLutFor(kind, theme);
  const invMax = (STOP_RAMP_SIZE - 1) / (kind === 'rain' ? MAX_RAIN_VAL : MAX_LIFT_VAL);
  const raw = scratch.scalarA;
  const cov = scratch.coverageA;

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const off = i * 4;
      const a = pixels[off + 3]!;
      if (a < 20 || (maskPixels && maskPixels[off + 3]! < 20)) {
        raw[i] = -1;
        cov[i] = 0;
        continue;
      }
      const key = ((pixels[off]! >> 3) << 10) | ((pixels[off + 1]! >> 3) << 5) | (pixels[off + 2]! >> 3);
      const val = lut[key]!;
      raw[i] = val;
      if (val >= 0) {
        cov[i] = a * (1 / 255);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else {
        cov[i] = 0;
      }
    }
  }

  if (maxX < minX) {
    pixels.fill(0, 0, count * 4);
    return;
  }

  const bx0 = minX > 1 ? minX - 2 : 0;
  const bx1 = maxX + 2 < width ? maxX + 2 : width - 1;
  const by0 = minY > 1 ? minY - 2 : 0;
  const by1 = maxY + 2 < height ? maxY + 2 : height - 1;

  const horizVal = scratch.scalarB;
  const horizCov = scratch.coverageB;
  for (let y = by0; y <= by1; y++) {
    const row = y * width;
    for (let x = bx0; x <= bx1; x++) {
      const i = row + x;
      const xl = x > 0 ? i - 1 : i;
      const xr = x + 1 < width ? i + 1 : i;
      horizCov[i] = (cov[xl]! + 2 * cov[i]! + cov[xr]!) * 0.25;
      let sum = 0, w = 0;
      const v0 = raw[xl]!, v1 = raw[i]!, v2 = raw[xr]!;
      if (v0 >= 0) { sum += v0; w += 1; }
      if (v1 >= 0) { sum += v1 * 2; w += 2; }
      if (v2 >= 0) { sum += v2; w += 1; }
      horizVal[i] = w > 0 ? sum / w : -1;
    }
  }

  const smoothVal = scratch.scalarA;
  const smoothCov = scratch.coverageA;
  const oy0 = minY > 0 ? minY - 1 : 0;
  const oy1 = maxY + 1 < height ? maxY + 1 : height - 1;
  const ox0 = minX > 0 ? minX - 1 : 0;
  const ox1 = maxX + 1 < width ? maxX + 1 : width - 1;
  for (let y = oy0; y <= oy1; y++) {
    const row = y * width;
    const up = y > by0 ? row - width : row;
    const dn = y < by1 ? row + width : row;
    for (let x = ox0; x <= ox1; x++) {
      const i = row + x;
      smoothCov[i] = (horizCov[up + x]! + 2 * horizCov[i]! + horizCov[dn + x]!) * 0.25;
      let sum = 0, w = 0;
      const v0 = horizVal[up + x]!, v1 = horizVal[i]!, v2 = horizVal[dn + x]!;
      if (v0 >= 0) { sum += v0; w += 1; }
      if (v1 >= 0) { sum += v1 * 2; w += 2; }
      if (v2 >= 0) { sum += v2; w += 1; }
      smoothVal[i] = w > 0 ? sum / w : -1;
    }
  }

  if (oy0 > 0) pixels.fill(0, 0, oy0 * width * 4);
  if (oy1 + 1 < height) pixels.fill(0, (oy1 + 1) * width * 4, count * 4);

  const isLift = kind === 'lift';
  const mode = opt.liftMode;
  const step = opt.liftContourStepM;
  const invStep = step > 0 ? 1 / step : 0;
  const rMode = opt.rainMode;
  const dark = opt.darkChrome;

  for (let y = oy0; y <= oy1; y++) {
    const row = y * width;
    if (ox0 > 0) pixels.fill(0, row * 4, (row + ox0) * 4);
    if (ox1 + 1 < width) pixels.fill(0, (row + ox1 + 1) * 4, (row + width) * 4);
    for (let x = ox0; x <= ox1; x++) {
      const i = row + x;
      const off = i * 4;
      const origAlpha = pixels[off + 3]!;
      if (origAlpha < 20 || (maskPixels && maskPixels[off + 3]! < 20)) {
        pixels[off] = 0; pixels[off + 1] = 0; pixels[off + 2] = 0; pixels[off + 3] = 0;
        continue;
      }
      const covAlpha = smoothCov[i]!;
      const val = smoothVal[i]!;
      if (covAlpha <= 0.04 || val < 0) {
        pixels[off] = 0; pixels[off + 1] = 0; pixels[off + 2] = 0; pixels[off + 3] = 0;
        continue;
      }

      const vr = x + 1 < width ? smoothVal[i + 1]! : val;
      const vd = y + 1 < height ? smoothVal[i + width]! : val;
      const onOuterEdge = (x + 1 < width && vr < 0) || (y + 1 < height && vd < 0)
        || (x > 0 && smoothVal[i - 1]! < 0) || (y > 0 && smoothVal[i - width]! < 0);

      if (isLift) {
        const sampleVal = mode === 'stepped-contour' && step > 0
          ? ((val * invStep) | 0) * step + step * 0.5
          : val;
        const rIdx = Math.min(STOP_RAMP_SIZE - 1, Math.max(0, (sampleVal * invMax + 0.5) | 0)) * 4;
        let r = ramp[rIdx]!, g = ramp[rIdx + 1]!, b = ramp[rIdx + 2]!;
        const scaleA = covAlpha * 1.12;
        let a = (ramp[rIdx + 3]! * (scaleA > 1 ? 1 : scaleA) + 0.5) | 0;

        if (mode === 'stepped-contour' && invStep > 0 && crossesStep(val, vr, vd, invStep)) {
          r = r > 56 ? r - 56 : 0; g = g > 48 ? g - 48 : 0; b = b > 34 ? b - 34 : 0;
          a = a + 55 > 255 ? 255 : (a + 55 < 195 ? 195 : a + 55);
        } else if (mode === 'isoline-wash') {
          if ((invStep > 0 && crossesStep(val, vr, vd, invStep)) || (onOuterEdge && val >= 350)) {
            r = r > 38 ? r - 38 : 0; g = g > 46 ? g - 46 : 0; b = b > 32 ? b - 32 : 0;
            a = 238;
          }
        } else if (mode === 'core-rim') {
          if (crossesThreshold(val, vr, vd, 2600) || crossesThreshold(val, vr, vd, 4000)) {
            r = 255; g = 236; b = 140; a = 246;
          }
        } else if (mode === 'ink-outline') {
          if ((invStep > 0 && crossesStep(val, vr, vd, invStep)) || (onOuterEdge && val >= 450)) {
            if (dark) { r = 255; g = 244; b = 196; a = 248; }
            else { r = 28; g = 22; b = 26; a = 242; }
          }
        }
        pixels[off] = r; pixels[off + 1] = g; pixels[off + 2] = b; pixels[off + 3] = a;
        continue;
      }

      const rIdx = Math.min(STOP_RAMP_SIZE - 1, Math.max(0, (val * invMax + 0.5) | 0)) * 4;
      let r = ramp[rIdx]!, g = ramp[rIdx + 1]!, b = ramp[rIdx + 2]!;
      const scaleA = covAlpha * 1.12;
      let a = (ramp[rIdx + 3]! * (scaleA > 1 ? 1 : scaleA) + 0.5) | 0;

      if (rMode === 'hatch') {
        const stripeWidth = val >= 10 ? 5 : val >= 3 ? 3 : 2;
        const onStripe = ((x + y) & 7) < stripeWidth;
        if (onOuterEdge || crossesThreshold(val, vr, vd, 5)) {
          r = 24; g = 64; b = 172; a = 236;
        } else if (onStripe) {
          r = r > 18 ? r - 18 : 0; g = g > 14 ? g - 14 : 0; a = a + 44 > 250 ? 250 : a + 44;
        } else {
          a = (a * 0.24) | 0;
        }
      } else if (rMode === 'concentric-rings') {
        if (onOuterEdge || crossesThreshold(val, vr, vd, 1) || crossesThreshold(val, vr, vd, 4) || crossesThreshold(val, vr, vd, 12) || crossesThreshold(val, vr, vd, 25)) {
          r = r > 28 ? r - 28 : 0; g = g > 24 ? g - 24 : 0; a = 242;
        } else {
          a = (a * 0.32) | 0;
        }
      } else if (rMode === 'slant-streaks') {
        const streak = ((x * 2 + y) & 7) < (val >= 2.5 ? 3 : 2);
        if (crossesThreshold(val, vr, vd, 8)) {
          r = 103; g = 232; b = 249; a = 248;
        } else if (val < 8 && !streak) {
          a = (a * 0.28) | 0;
        }
      } else if (rMode === 'blueprint-hatch') {
        const diagA = ((x + y) & 7) < 2;
        const diagB = val >= 5 && (((x - y) & 7) < 2);
        if (onOuterEdge || crossesThreshold(val, vr, vd, 5)) {
          r = 165; g = 243; b = 252; a = 246;
        } else if (val >= 14 || diagA || diagB) {
          a = a + 32 > 252 ? 252 : a + 32;
        } else {
          a = (a * 0.20) | 0;
        }
      } else if (rMode === 'ink-hatch') {
        const stripe = ((x + y) & 7) < (val >= 4 ? 4 : 2);
        if (onOuterEdge || crossesThreshold(val, vr, vd, 8)) {
          r = 15; g = 23; b = 72; a = 250;
        } else if (val < 10 && !stripe) {
          a = (a * 0.22) | 0;
        } else {
          a = a + 36 > 255 ? 255 : a + 36;
        }
      } else if (crossesThreshold(val, vr, vd, 10) || crossesThreshold(val, vr, vd, 2)) {
        if (dark) {
          r = r + 34 > 255 ? 255 : r + 34; g = g + 38 > 255 ? 255 : g + 38; b = b + 28 > 255 ? 255 : b + 28;
        } else {
          r = r > 24 ? r - 24 : 0; g = g > 26 ? g - 26 : 0; b = b > 18 ? b - 18 : 0;
        }
        a = a + 28 > 255 ? 255 : a + 28;
      }

      pixels[off] = r;
      pixels[off + 1] = g;
      pixels[off + 2] = b;
      pixels[off + 3] = a;
    }
  }
}

export interface RemapBitmapWorkspace {
  readonly tileCanvas: OffscreenCanvas;
  readonly maskCanvas: OffscreenCanvas;
  readonly scratch: RemapScratch;
}

export function createBitmapWorkspace(): RemapBitmapWorkspace {
  return {
    tileCanvas: new OffscreenCanvas(RASTER_TILE_SIZE, RASTER_TILE_SIZE),
    maskCanvas: new OffscreenCanvas(RASTER_TILE_SIZE, RASTER_TILE_SIZE),
    scratch: createRemapScratch(RASTER_TILE_SIZE * RASTER_TILE_SIZE)
  };
}

function extractPixels(bitmap: ImageBitmap, canvas: OffscreenCanvas): { ctx: OffscreenCanvasRenderingContext2D; imageData: ImageData } {
  const w = bitmap.width || RASTER_TILE_SIZE;
  const h = bitmap.height || RASTER_TILE_SIZE;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { ctx, imageData: ctx.getImageData(0, 0, w, h) };
}

/** Decodes WebP bytes, remaps pixels in place inside `workspace`, and returns an `ImageBitmap`. */
export async function decodeAndRemapBitmap(
  workspace: RemapBitmapWorkspace,
  data: ArrayBuffer,
  kind: RemapKind,
  theme: MapTheme,
  maskData?: ArrayBuffer | null
): Promise<ImageBitmap> {
  if (theme === 'classic' || data.byteLength <= 48) {
    return createImageBitmap(new Blob([data], { type: 'image/webp' }));
  }
  const [bitmap, maskBitmap] = await Promise.all([
    createImageBitmap(new Blob([data], { type: 'image/webp' })),
    maskData && maskData.byteLength > 48
      ? createImageBitmap(new Blob([maskData], { type: 'image/webp' })).catch(() => null)
      : Promise.resolve(null)
  ]);
  try {
    const maskPixels = maskBitmap ? extractPixels(maskBitmap, workspace.maskCanvas).imageData.data : null;
    const { ctx, imageData } = extractPixels(bitmap, workspace.tileCanvas);
    remapRgbaInPlace(imageData.data, bitmap.width, bitmap.height, kind, theme, maskPixels, workspace.scratch);
    ctx.putImageData(imageData, 0, 0);
    if (typeof workspace.tileCanvas.transferToImageBitmap === 'function') {
      return workspace.tileCanvas.transferToImageBitmap();
    }
    return await createImageBitmap(imageData);
  } finally {
    bitmap.close();
    maskBitmap?.close();
  }
}
