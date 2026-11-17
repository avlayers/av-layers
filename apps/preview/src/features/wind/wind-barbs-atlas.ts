import { quantizedBarbSpeed } from '@av/contracts/units';
import { barbGeometry } from '@av/windgram/wind-barb';

export interface BarbIcon { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }
export type BarbMapping = Record<string, BarbIcon>;

const ICON = 46, COLUMNS = 11, SIZE = 512, STAFF = 30, CALM = 'calm';
const staticKey = (speedKt: number, southern: boolean) => `${southern ? 's' : 'n'}${speedKt}`;

function drawIcon(ctx: CanvasRenderingContext2D, speedKt: number, southern: boolean, x: number, y: number): void {
  ctx.save();
  ctx.translate(x + ICON / 2, y + ICON / 2);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  if (speedKt === 0) {
    ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.restore();
    return;
  }
  const geometry = barbGeometry(speedKt, 0, STAFF, southern);
  const paths = [new Path2D(geometry.staff), ...geometry.flags.map(flag => new Path2D(flag))];
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3.2;
  for (const path of paths) ctx.stroke(path);
  ctx.strokeStyle = '#111'; ctx.fillStyle = '#111'; ctx.lineWidth = 1.4;
  for (const [index, path] of paths.entries()) {
    if (index > 0 && geometry.flags[index - 1]!.endsWith('Z')) ctx.fill(path);
    ctx.stroke(path);
  }
  ctx.restore();
}

function mappingFor(columns: number): { mapping: BarbMapping; slots: number } {
  const mapping: BarbMapping = {};
  for (let index = 0; index < columns * columns; index++) {
    mapping[`slot${index}`] = { x: (index % columns) * ICON, y: Math.floor(index / columns) * ICON, width: ICON, height: ICON, anchorX: ICON / 2, anchorY: ICON / 2, mask: false };
  }
  return { mapping, slots: columns * columns };
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
  private readonly keys = new Map<string, string>();

  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.width = SIZE; this.canvas.height = SIZE;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    this.ctx = ctx;
    this.dynamicCanvas = document.createElement('canvas'); this.dynamicCanvas.width = 4 * ICON; this.dynamicCanvas.height = 4 * ICON;
    const dynamicCtx = this.dynamicCanvas.getContext('2d');
    if (!dynamicCtx) throw new Error('Canvas 2D is unavailable');
    this.dynamicCtx = dynamicCtx;
    this.add(CALM, 0, false, false);
    for (const southern of [false, true]) for (let speed = 5; speed <= 280; speed += 5) this.add(staticKey(speed, southern), speed, southern, false);
  }

  key(speedKt: number, southern: boolean): string {
    const rounded = quantizedBarbSpeed(speedKt);
    if (rounded === 0) return CALM;
    if (rounded <= 280) return staticKey(rounded, southern);
    return this.dynamic(speedKt, southern);
  }

  private add(key: string, speedKt: number, southern: boolean, dynamic: boolean): void {
    const columns = dynamic ? 4 : COLUMNS, slot = dynamic ? this.dynamicNext++ : this.next++;
    if (slot >= columns * columns) return;
    const x = (slot % columns) * ICON, y = Math.floor(slot / columns) * ICON;
    drawIcon(dynamic ? this.dynamicCtx : this.ctx, speedKt, southern, x, y);
    (dynamic ? this.dynamicMapping : this.mapping)[key] = { x, y, width: ICON, height: ICON, anchorX: ICON / 2, anchorY: ICON / 2, mask: false };
    this.keys.set(key, dynamic ? 'dynamic' : 'static');
  }

  private dynamic(speedKt: number, southern: boolean): string {
    const rounded = Math.ceil(speedKt / 5) * 5, key = `d${southern ? 's' : 'n'}${rounded}`;
    if (!this.dynamicMapping[key]) this.add(key, rounded, southern, true);
    return key;
  }
}

export { ICON as BARB_ICON_SIZE, CALM as CALM_BARB_KEY };
