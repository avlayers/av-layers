import { expect, it } from 'vitest';
import { PreviewAttempts } from './preview-attempts';

it('retries the selected frame once at once, then after cooldowns until three failures', () => {
  const attempts = new PreviewAttempts();
  let now = 0;
  const clock = () => now;
  expect(attempts.fail('f003', true, clock)).toBe('retry');
  expect(attempts.failed('f003')).toBe(false);
  expect(attempts.fail('f003', true, clock)).toBe('cooldown');
  expect(attempts.failed('f003')).toBe(true);
  expect(attempts.admit('f003', clock)).toBe(1_000);
  now = 1_000;
  expect(attempts.admit('f003', clock)).toBe('now');
  expect(attempts.failed('f003')).toBe(false);
  expect(attempts.fail('f003', true, clock)).toBe('exhausted');
  expect(attempts.admit('f003', clock)).toBeNull();
});

it('cools background frames down and forgets frames that succeed', () => {
  const attempts = new PreviewAttempts();
  const clock = () => 0;
  expect(attempts.admit('f006', clock)).toBe('now');
  expect(attempts.fail('f006', false, clock)).toBe('cooldown');
  attempts.succeeded('f006');
  expect(attempts.failed('f006')).toBe(false);
  expect(attempts.admit('f006', clock)).toBe('now');
  attempts.fail('f009', false, clock);
  attempts.clear();
  expect(attempts.failed('f009')).toBe(false);
  expect(attempts.fail('f009', true, clock)).toBe('retry');
});
