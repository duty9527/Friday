import { setTimeout as delay } from 'node:timers/promises';

/**
 * Polls `predicate` until it returns `true` or `timeoutMs` elapses.
 */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 15,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Condition timed out after ${timeoutMs}ms`);
    }
    await delay(intervalMs);
  }
}
