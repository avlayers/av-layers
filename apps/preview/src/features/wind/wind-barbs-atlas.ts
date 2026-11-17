import { quantizedBarbSpeed } from '@av/contracts/units';

export interface BarbIcon { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }
export type BarbMapping = Record<string, BarbIcon>;

const SCALE = 2, ICON = 46 * SCALE, COLUMNS = 11, SIZE = 1024, STAFF = 21 * SCALE;
export const CALM_BARB_KEY = 'calm';
export const BARB_ICON_SIZE = 46;
const staticKey = (speedKt: number, southern: boolean) => `${southern ? 's' : 'n'}${speedKt}`;

function drawIcon(ctx: CanvasRenderingContext2D, speedKt: number, southern: boolean, x: number, y: number): void {
  ctx.save();
  ctx.translate(x + ICON / 2, y + ICON / 2);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  if (speedKt === 0) {
    ctx.beginPath(); ctx.arc(0, 0, 2.5 * SCALE, 0, Math.PI * 2);
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.82)'; ctx.lineWidth = 2.2 * SCALE; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 0.9 * SCALE; ctx.stroke();
    ctx.restore();
    return;
  }

  const side = (southern ? -1 : 1) * 6 * SCALE;
  const flags = Math.min(16, Math.floor(speedKt / 50)), feathers = Math.floor((speedKt % 50) / 10), half = speedKt % 10 >= 5;
  const spacing = Math.min(4 * SCALE, 20 * SCALE / Math.max(1, flags * 2 + feathers + Number(half)));

  // Build paths once so all white halos draw beneath all dark strokes/fills without notching the staff.
  const linePath = new Path2D();
  linePath.moveTo(0, 0);
  linePath.lineTo(0, -STAFF);

  const pennantPaths: Path2D[] = [];
  let d = -STAFF;
  for (let index = 0; index < flags; index++) {
    const pennant = new Path2D();
    pennant.moveTo(0, d); pennant.lineTo(side, d); pennant.lineTo(0, d + spacing * 2); pennant.closePath();
    pennantPaths.push(pennant);
    d += spacing * 2;
  }
  for (let index = 0; index < feathers; index++) {
    linePath.moveTo(0, d); linePath.lineTo(side, d - 3 * SCALE);
    d += spacing;
  }
  if (half) {
    linePath.moveTo(0, d); linePath.lineTo(side / 2, d - 1.5 * SCALE);
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.82)';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.2 * SCALE;
  ctx.stroke(linePath);
  ctx.lineWidth = 2 * SCALE;
  for (const pennant of pennantPaths) ctx.stroke(pennant);
  ctx.restore();

  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#0f172a';
  ctx.lineWidth = 0.9 * SCALE;
  ctx.stroke(linePath);
  for (const pennant of pennantPaths) ctx.fill(pennant);
  ctx.restore();
}

export class WindBarbAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly mapping: BarbMapping = {};
  readonly dynamicCanvas: HTMLCanvasElement;
  readonly dynamicMapping: BarbMapping = {};
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dynamicCtx: CanvasRenderingContext2D;
  private next = 0;
  private dynamicNext = 0;
  private readonly dynamicKeys: Array<string | undefined> = [];
  dynamicImage: ImageData | HTMLCanvasElement;

  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.width = SIZE; this.canvas.height = SIZE;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    this.ctx = ctx;
    this.dynamicCanvas = document.createElement('canvas'); this.dynamicCanvas.width = 8 * ICON; this.dynamicCanvas.height = 8 * ICON;
    const dynamicCtx = this.dynamicCanvas.getContext('2d');
    if (!dynamicCtx) throw new Error('Canvas 2D is unavailable');
    this.dynamicCtx = dynamicCtx;
    this.dynamicImage = this.dynamicCanvas;
    this.add(CALM_BARB_KEY, 0, false, false);
    for (const southern of [false, true]) for (let speed = 5; speed <= 280; speed += 5) this.add(staticKey(speed, southern), speed, southern, false);
  }

  key(speedKt: number, southern: boolean): string {
    const rounded = quantizedBarbSpeed(speedKt);
    if (rounded === 0) return CALM_BARB_KEY;
    if (rounded <= 280) return staticKey(rounded, southern);
    return this.dynamic(speedKt, southern);
  }

  private add(key: string, speedKt: number, southern: boolean, dynamic: boolean): void {
    const columns = dynamic ? 8 : COLUMNS, slot = dynamic ? this.dynamicNext % (columns * columns) : this.next++;
    if (!dynamic && slot >= columns * columns) return;
    const x = (slot % columns) * ICON, y = Math.floor(slot / columns) * ICON;
    if (dynamic) {
      const previous = this.dynamicKeys[slot];
      if (previous && previous !== key) delete this.dynamicMapping[previous];
      this.dynamicKeys[slot] = key; this.dynamicNext++;
      this.dynamicCtx.clearRect(x, y, ICON, ICON);
    }
    drawIcon(dynamic ? this.dynamicCtx : this.ctx, speedKt, southern, x, y);
    (dynamic ? this.dynamicMapping : this.mapping)[key] = { x, y, width: ICON, height: ICON, anchorX: ICON / 2, anchorY: ICON / 2, mask: false };
    if (dynamic) {
      this.dynamicImage = typeof this.dynamicCtx.getImageData === 'function'
        ? this.dynamicCtx.getImageData(0, 0, this.dynamicCanvas.width, this.dynamicCanvas.height)
        : this.dynamicCanvas;
    }
  }

  private dynamic(speedKt: number, southern: boolean): string {
    const rounded = Math.max(285, Math.round(speedKt / 5) * 5), key = `d${southern ? 's' : 'n'}${rounded}`;
    if (!this.dynamicMapping[key]) this.add(key, rounded, southern, true);
    return key;
  }
}
