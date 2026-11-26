/**
 * Paints day preview canvases from a `DayPreviewSource` (the raster overview, wired in
 * `create-preview-app.ts`), at most once per animation frame. Canvases are sized to their CSS box at up to
 * 2× device pixels and cleared before each draw, so a card never keeps another frame's pixels.
 */
import type { PreviewDraw } from '../raster/raster-overview';

export interface DayPreviewSource {
  /** Draws frame `index` of the rendered axis into `target` at `width` × `height` device pixels. */
  draw(index: number, target: CanvasRenderingContext2D, width: number, height: number): PreviewDraw;
  /** Frames the cards show, so the source can prepare them first. */
  prefer(indices: readonly number[]): void;
}

interface DayPreviews {
  /** Runs `paint` on the next animation frame; repeated calls before then run it once. */
  schedule(paint: () => void): void;
  /** Draws `index` into `canvas`; -1 clears it. */
  paint(canvas: HTMLCanvasElement, index: number): PreviewDraw;
  prefer(indices: readonly number[]): void;
  /** Cancels pending work and drops canvas backing stores. */
  destroy(canvases: readonly HTMLCanvasElement[]): void;
}

const MAX_DPR = 2;
const FALLBACK_BOX = { width: 64, height: 36 };

export function createDayPreviews(source: DayPreviewSource, frameClock: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'devicePixelRatio'> | null): DayPreviews {
  let request: number | null = null, queued: (() => void) | null = null;
  const raf = frameClock && typeof frameClock.requestAnimationFrame === 'function' ? frameClock : null;
  return {
    schedule(paint) {
      queued = paint;
      if (!raf) { queued = null; paint(); return; }
      if (request !== null) return;
      request = raf.requestAnimationFrame(() => {
        request = null;
        const next = queued; queued = null;
        next?.();
      });
    },
    paint(canvas, index) {
      const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (!context) return 'unavailable';
      // A card shown as a plain date has no box yet; draw at the thumbnail size so it can switch to the image.
      const box = canvas.getBoundingClientRect(), css = box.width > 0 && box.height > 0 ? box : FALLBACK_BOX;
      const dpr = Math.min(MAX_DPR, Math.max(1, frameClock?.devicePixelRatio ?? 1));
      const width = Math.round(css.width * dpr), height = Math.round(css.height * dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (index < 0 || width <= 0 || height <= 0) return 'unavailable';
      return source.draw(index, context, width, height);
    },
    // Not de-duplicated here: the same indices can name other frames after a build change, and the source
    // compares the frames it is given.
    prefer(indices) { source.prefer(indices); },
    destroy(canvases) {
      if (request !== null) raf?.cancelAnimationFrame(request);
      request = null; queued = null;
      for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
    }
  };
}
