export const SLANT_TAN = 0.25;
export const SPRITE_CELL_W = 36;
export const SPRITE_CELL_H = 72;
const SPRITE_TIERS = 4;

let spriteAtlasCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;

/** Lazily draws the shared raindrop atlas: row 0 light chrome, row 1 dark, one `SPRITE_CELL_W` cell per intensity tier. */
export function getRainSpriteAtlas(): HTMLCanvasElement | OffscreenCanvas | null {
  if (spriteAtlasCanvas) return spriteAtlasCanvas;
  const totalW = SPRITE_TIERS * SPRITE_CELL_W;
  const totalH = 2 * SPRITE_CELL_H;
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(totalW, totalH)
    : (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: totalW, height: totalH }) : null);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;

  const tierSpecs: ReadonlyArray<{ len: number; headR: number; caseW: number }> = [
    { len: 20, headR: 1.4, caseW: 1.4 },
    { len: 33, headR: 1.9, caseW: 1.75 },
    { len: 45, headR: 2.35, caseW: 2.05 },
    { len: 56, headR: 2.85, caseW: 2.35 }
  ];

  for (let darkRow = 0; darkRow < 2; darkRow++) {
    const isDark = darkRow === 1;
    for (let t = 0; t < SPRITE_TIERS; t++) {
      const spec = tierSpecs[t]!;
      const ox = t * SPRITE_CELL_W;
      const oy = darkRow * SPRITE_CELL_H;

      const x1 = ox + SPRITE_CELL_W * 0.64;
      const y1 = oy + SPRITE_CELL_H - 9;
      const x0 = x1 - spec.len * SLANT_TAN;
      const y0 = y1 - spec.len;

      const dx = x1 - x0, dy = y1 - y0;
      const invLen = 1 / Math.hypot(dx, dy);
      const nx = -dy * invLen, ny = dx * invLen;

      const caseGrad = ctx.createLinearGradient(x0, y0, x1, y1);
      caseGrad.addColorStop(0, 'rgba(8, 15, 28, 0)');
      caseGrad.addColorStop(0.30, isDark ? 'rgba(2, 6, 18, 0.24)' : 'rgba(15, 23, 42, 0.20)');
      caseGrad.addColorStop(0.88, isDark ? 'rgba(2, 6, 18, 0.78)' : 'rgba(12, 20, 36, 0.68)');
      caseGrad.addColorStop(1, isDark ? 'rgba(2, 6, 18, 0.84)' : 'rgba(12, 20, 36, 0.74)');

      const cr = spec.headR + spec.caseW;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 + nx * cr, y1 + ny * cr);
      ctx.arc(x1, y1, cr, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false);
      ctx.closePath();
      ctx.fillStyle = caseGrad;
      ctx.fill();

      const bodyGrad = ctx.createLinearGradient(x0, y0, x1, y1);
      bodyGrad.addColorStop(0, isDark ? 'rgba(186, 230, 253, 0)' : 'rgba(248, 252, 255, 0)');
      bodyGrad.addColorStop(0.34, isDark ? 'rgba(186, 230, 253, 0.28)' : 'rgba(241, 247, 255, 0.30)');
      bodyGrad.addColorStop(0.84, isDark ? 'rgba(224, 242, 254, 0.88)' : 'rgba(252, 254, 255, 0.92)');
      bodyGrad.addColorStop(1, 'rgba(255, 255, 255, 0.99)');

      const hr = spec.headR;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 + nx * hr, y1 + ny * hr);
      ctx.arc(x1, y1, hr, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false);
      ctx.closePath();
      ctx.fillStyle = bodyGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x1 - dx * 0.03, y1 - dy * 0.03, Math.max(0.9, hr * 0.68), 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  }

  spriteAtlasCanvas = canvas;
  return canvas;
}
