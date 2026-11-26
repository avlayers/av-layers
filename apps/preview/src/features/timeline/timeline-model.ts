export interface TimelineFrame { readonly id: string; readonly validTime: string }

export function frameIndexFor(frames: readonly { validTime: string }[], requested: string | null, now: number): number {
  if (requested) {
    const exact = frames.findIndex(frame => frame.validTime === requested);
    if (exact >= 0) return exact;
    const target = Date.parse(requested);
    if (Number.isFinite(target)) {
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      frames.forEach((frame, index) => {
        const delta = Math.abs(Date.parse(frame.validTime) - target);
        if (delta < distance) { best = index; distance = delta; }
      });
      return best;
    }
  }
  let best = 0;
  let bestAt = Number.NEGATIVE_INFINITY;
  frames.forEach((frame, index) => {
    const at = Date.parse(frame.validTime);
    if (at <= now && at >= bestAt) { best = index; bestAt = at; }
  });
  return best;
}
