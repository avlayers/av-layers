import { PLAYBACK_STEP_MS } from './timeline-model';

/** Forecast playback timer: advances one frame per step and calls `finish` at the last frame. */
interface Playback {
  readonly playing: boolean;
  start(): void;
  /** Clears the timer; returns whether it was running. */
  stop(): boolean;
}

interface PlaybackCursor {
  atEnd(): boolean;
  advance(): void;
  /** Called when playback reaches the end; the owner stops and repaints. */
  finish(): void;
}

export function createPlayback(cursor: PlaybackCursor): Playback {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    get playing() { return timer !== null; },
    start() {
      timer = setInterval(() => {
        if (cursor.atEnd()) { cursor.finish(); return; }
        cursor.advance();
        if (cursor.atEnd()) cursor.finish();
      }, PLAYBACK_STEP_MS);
    },
    stop() {
      if (timer === null) return false;
      clearInterval(timer);
      timer = null;
      return true;
    }
  };
}
