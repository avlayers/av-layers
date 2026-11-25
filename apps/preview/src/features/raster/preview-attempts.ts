const PREVIEW_RETRY_COOLDOWN_MS = 1_000;
const MAX_PREVIEW_ATTEMPTS = 3;

/**
 * Per-frame overview preview failures. The selected frame retries once at once, then every frame
 * retries after a cooldown until `MAX_PREVIEW_ATTEMPTS` failures.
 */
export class PreviewAttempts {
  private readonly unavailable = new Set<string>();
  private readonly retried = new Set<string>();
  private readonly failures = new globalThis.Map<string, number>();
  private readonly retryAfter = new globalThis.Map<string, number>();

  /** Whether the frame's last attempt failed. */
  failed(frame: string): boolean { return this.unavailable.has(frame); }

  /** `now` when the frame may start another attempt (and records it), the due time while cooling down, or null once exhausted. */
  admit(frame: string, now: () => number): 'now' | number | null {
    if ((this.failures.get(frame) ?? 0) >= MAX_PREVIEW_ATTEMPTS) return null;
    const due = this.retryAfter.get(frame) ?? 0;
    if (this.retried.has(frame) && now() < due) return due;
    this.retried.add(frame);
    this.unavailable.delete(frame);
    return 'now';
  }

  succeeded(frame: string): void { this.unavailable.delete(frame); this.failures.delete(frame); this.retryAfter.delete(frame); }

  /** Records a failure: `retry` to start again now, `cooldown` to retry after the cooldown, or `exhausted`. */
  fail(frame: string, selected: boolean, now: () => number): 'retry' | 'cooldown' | 'exhausted' {
    const attempts = (this.failures.get(frame) ?? 0) + 1;
    this.failures.set(frame, attempts);
    if (selected && !this.retried.has(frame)) {
      this.retried.add(frame);
      this.unavailable.delete(frame);
      return 'retry';
    }
    this.unavailable.add(frame);
    if (attempts >= MAX_PREVIEW_ATTEMPTS) return 'exhausted';
    this.retryAfter.set(frame, now() + PREVIEW_RETRY_COOLDOWN_MS);
    return 'cooldown';
  }

  clear(): void { this.unavailable.clear(); this.retried.clear(); this.failures.clear(); this.retryAfter.clear(); }
}
