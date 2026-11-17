import { quantizedBarbSpeed } from '@av/contracts/units';

export interface BarbIcon { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }
export type BarbMapping = Record<string, BarbIcon>;

const SCALE = 4;
const SLOT_CSS = 32;
const ICON = SLOT_CSS * SCALE;
const ORIGIN_X = 16 * SCALE;
const ORIGIN_Y = 27 * SCALE;
const COLUMNS = 11;
const SIZE = COLUMNS * ICON;
const STAFF = 21;

export const CALM_BARB_KEY = 'calm';
export const BARB_ICON_SIZE = SLOT_CSS;

const LABEL_W_CSS = 28;
const LABEL_H_CSS = 18;
const LABEL_W = LABEL_W_CSS * SCALE;
const LABEL_H = LABEL_H_CSS * SCALE;
const LABEL_COLS = 9;
const LABEL_ROWS = 8;
export const LABEL_ICON_SIZE = LABEL_H_CSS;

const staticKey = (speedKt: number, southern: boolean) => `${southern ? 's' : 'n'}${speedKt}`;

function premultiplyRegion(ctx: CanvasRenderingContext2D, target: ImageData | null, x: number, y: number, w: number, h: number, fullW: number): ImageData | null {
  if (typeof ctx.getImageData !== 'function') return null;
  const patch = ctx.getImageData(x, y, w, h);
  const src = patch.data;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!;
    if (a === 0) {
      src[i] = 0; src[i + 1] = 0; src[i + 2] = 0;
    } else if (a < 255) {
      src[i] = Math.round(src[i]! * a / 255);
      src[i + 1] = Math.round(src[i + 1]! * a / 255);
      src[i + 2] = Math.round(src[i + 2]! * a / 255);
    }
  }
  if (!target) return patch;
  const dst = target.data;
  for (let row = 0; row < h; row++) {
    const srcOff = row * w * 4;
    const dstOff = ((y + row) * fullW + x) * 4;
    dst.set(src.subarray(srcOff, srcOff + w * 4), dstOff);
  }
  return target;
}

function haloStroke(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.82)';
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
  ctx.stroke();
}

function drawIcon(ctx: CanvasRenderingContext2D, speedKt: number, southern: boolean, x: number, y: number): void {
  ctx.save();
  ctx.translate(x + ORIGIN_X, y + ORIGIN_Y);
  if (typeof ctx.scale === 'function') ctx.scale(SCALE, SCALE);
  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#0f172a';
  ctx.lineWidth = 0.9;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  if (speedKt === 0) {
    ctx.beginPath();
    ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
    haloStroke(ctx);
    ctx.restore();
    return;
  }

  const side = (southern ? -1 : 1) * 6;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -STAFF);
  haloStroke(ctx);

  const flags = Math.min(16, Math.floor(speedKt / 50));
  const feathers = Math.floor((speedKt % 50) / 10);
  const half = speedKt % 10 >= 5;
  const spacing = Math.min(4, 20 / Math.max(1, flags * 2 + feathers + Number(half)));
  let d = -STAFF;
  for (let index = 0; index < flags; index++) {
    ctx.beginPath();
    ctx.moveTo(0, d);
    ctx.lineTo(side, d);
    ctx.lineTo(0, d + spacing * 2);
    ctx.closePath();
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.82)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
    ctx.fill();
    d += spacing * 2;
  }
  ctx.beginPath();
  for (let index = 0; index < feathers; index++) {
    ctx.moveTo(0, d);
    ctx.lineTo(side, d - 3);
    d += spacing;
  }
  if (half) {
    ctx.moveTo(0, d);
    ctx.lineTo(side / 2, d - 1.5);
  }
  haloStroke(ctx);
  ctx.restore();
}

export class WindBarbAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly mapping: BarbMapping = {};
  readonly dynamicCanvas: HTMLCanvasElement;
  readonly dynamicMapping: BarbMapping = {};
  readonly labelCanvas: HTMLCanvasElement;
  readonly labelMapping: BarbMapping = {};
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dynamicCtx: CanvasRenderingContext2D;
  private readonly labelCtx: CanvasRenderingContext2D;
  private next = 0;
  private dynamicNext = 0;
  private labelNext = 0;
  private readonly dynamicKeys: Array<string | undefined> = [];
  private readonly labelKeys: Array<string | undefined> = [];
  private dynamicData: ImageData | null = null;
  private labelData: ImageData | null = null;
  private labelDirty = false;
  staticImage: ImageData | HTMLCanvasElement;
  dynamicImage: ImageData | HTMLCanvasElement;
  labelImage: ImageData | HTMLCanvasElement;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    this.ctx = ctx;

    this.dynamicCanvas = document.createElement('canvas');
    this.dynamicCanvas.width = 8 * ICON;
    this.dynamicCanvas.height = 8 * ICON;
    const dynamicCtx = this.dynamicCanvas.getContext('2d', { willReadFrequently: true });
    if (!dynamicCtx) throw new Error('Canvas 2D is unavailable');
    this.dynamicCtx = dynamicCtx;

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = LABEL_COLS * LABEL_W;
    this.labelCanvas.height = LABEL_ROWS * LABEL_H;
    const labelCtx = this.labelCanvas.getContext('2d', { willReadFrequently: true });
    if (!labelCtx) throw new Error('Canvas 2D is unavailable');
    this.labelCtx = labelCtx;

    this.add(CALM_BARB_KEY, 0, false, false);
    for (const southern of [false, true]) {
      for (let speed = 5; speed <= 280; speed += 5) this.add(staticKey(speed, southern), speed, southern, false);
    }
    this.staticImage = premultiplyRegion(this.ctx, null, 0, 0, SIZE, SIZE, SIZE) ?? this.canvas;
    this.dynamicData = typeof this.dynamicCtx.getImageData === 'function'
      ? this.dynamicCtx.getImageData(0, 0, this.dynamicCanvas.width, this.dynamicCanvas.height)
      : null;
    this.dynamicImage = this.dynamicData ?? this.dynamicCanvas;
    this.labelData = typeof this.labelCtx.getImageData === 'function'
      ? this.labelCtx.getImageData(0, 0, this.labelCanvas.width, this.labelCanvas.height)
      : null;
    this.labelImage = this.labelData ?? this.labelCanvas;
  }

  key(speedKt: number, southern: boolean): string {
    const rounded = quantizedBarbSpeed(speedKt);
    if (rounded === 0) return CALM_BARB_KEY;
    if (rounded <= 280) return staticKey(rounded, southern);
    return this.dynamic(speedKt, southern);
  }

  labelKey(text: string): string {
    if (this.labelMapping[text]) return text;
    const capacity = LABEL_COLS * LABEL_ROWS;
    const slot = this.labelNext % capacity;
    const previous = this.labelKeys[slot];
    if (previous && previous !== text) delete this.labelMapping[previous];
    this.labelKeys[slot] = text;
    this.labelNext++;
    const x = (slot % LABEL_COLS) * LABEL_W;
    const y = Math.floor(slot / LABEL_COLS) * LABEL_H;
    if (typeof this.labelCtx.clearRect === 'function') this.labelCtx.clearRect(x, y, LABEL_W, LABEL_H);
    this.labelCtx.save();
    this.labelCtx.translate(x, y);
    if (typeof this.labelCtx.scale === 'function') this.labelCtx.scale(SCALE, SCALE);
    this.labelCtx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    this.labelCtx.textAlign = 'center';
    this.labelCtx.textBaseline = 'top';
    this.labelCtx.save();
    this.labelCtx.strokeStyle = 'rgba(255,255,255,0.94)';
    this.labelCtx.lineWidth = 2.2;
    this.labelCtx.lineJoin = 'round';
    this.labelCtx.miterLimit = 2;
    if (typeof this.labelCtx.strokeText === 'function') this.labelCtx.strokeText(text, LABEL_W_CSS / 2, 3);
    this.labelCtx.restore();
    this.labelCtx.fillStyle = '#0f172a';
    if (typeof this.labelCtx.fillText === 'function') this.labelCtx.fillText(text, LABEL_W_CSS / 2, 3);
    this.labelCtx.restore();
    this.labelMapping[text] = {
      x,
      y,
      width: LABEL_W,
      height: LABEL_H,
      anchorX: LABEL_W / 2,
      anchorY: 0,
      mask: false
    };
    if (this.labelData) {
      premultiplyRegion(this.labelCtx, this.labelData, x, y, LABEL_W, LABEL_H, this.labelCanvas.width);
      this.labelDirty = true;
    }
    return text;
  }

  flushLabels(): void {
    if (!this.labelDirty || !this.labelData) return;
    this.labelDirty = false;
    this.labelImage = new ImageData(new Uint8ClampedArray(this.labelData.data), this.labelData.width, this.labelData.height);
  }

  private add(key: string, speedKt: number, southern: boolean, dynamic: boolean): void {
    const columns = dynamic ? 8 : COLUMNS, slot = dynamic ? this.dynamicNext % (columns * columns) : this.next++;
    if (!dynamic && slot >= columns * columns) return;
    const x = (slot % columns) * ICON, y = Math.floor(slot / columns) * ICON;
    if (dynamic) {
      const previous = this.dynamicKeys[slot];
      if (previous && previous !== key) delete this.dynamicMapping[previous];
      this.dynamicKeys[slot] = key;
      this.dynamicNext++;
      this.dynamicCtx.clearRect(x, y, ICON, ICON);
    }
    drawIcon(dynamic ? this.dynamicCtx : this.ctx, speedKt, southern, x, y);
    (dynamic ? this.dynamicMapping : this.mapping)[key] = {
      x,
      y,
      width: ICON,
      height: ICON,
      anchorX: ORIGIN_X,
      anchorY: ORIGIN_Y,
      mask: false
    };
    if (dynamic && this.dynamicData) {
      premultiplyRegion(this.dynamicCtx, this.dynamicData, x, y, ICON, ICON, this.dynamicCanvas.width);
      this.dynamicImage = new ImageData(new Uint8ClampedArray(this.dynamicData.data), this.dynamicData.width, this.dynamicData.height);
    }
  }

  private dynamic(speedKt: number, southern: boolean): string {
    const rounded = Math.max(285, Math.round(speedKt / 5) * 5), key = `d${southern ? 's' : 'n'}${rounded}`;
    if (!this.dynamicMapping[key]) this.add(key, rounded, southern, true);
    return key;
  }
}
