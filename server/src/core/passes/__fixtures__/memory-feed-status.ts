/**
 * A feed-status store that keeps every attempt, for the F15 tests: the TLE refresh records
 * the `celestrak:elements` row every cycle, and the tests read back what it said.
 */

import type { FeedAttempt, FeedStatusStore } from '../../ports/feed-status-store.js';

export class MemoryFeedStatus implements FeedStatusStore {
  readonly attempts: FeedAttempt[] = [];
  throws = false;

  recordAttempt(attempt: FeedAttempt): Promise<void> {
    if (this.throws) return Promise.reject(new Error('feed status disk unwritable'));
    this.attempts.push(attempt);
    return Promise.resolve();
  }
}
