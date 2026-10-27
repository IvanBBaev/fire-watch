import { describe, expect, it } from 'vitest';

import { DELIVERY_PARAMS } from './delivery-params.js';
import { WEBHOOK_PARAMS } from './webhook-params.js';

describe('webhook_params_v1 against the outbox', () => {
  it('never allows more webhook attempts than the outbox row has retries', () => {
    // The webhook's last attempt answers `permanent` itself; a larger cap would let the
    // outbox close the row as exhausted while the webhook schedule still had tries left.
    expect(WEBHOOK_PARAMS.values.maxAttempts).toBeLessThanOrEqual(
      DELIVERY_PARAMS.values.retry.maxAttempts,
    );
  });

  it('finishes its whole nominal schedule inside the outbox expiry', () => {
    const { maxAttempts, backoffBaseMs, backoffMaxMs, timeoutMs } = WEBHOOK_PARAMS.values;
    let worstMs = maxAttempts * timeoutMs;
    for (let n = 1; n < maxAttempts; n += 1) {
      worstMs += Math.min(backoffMaxMs, backoffBaseMs * 2 ** (n - 1));
    }
    expect(worstMs).toBeLessThan(DELIVERY_PARAMS.values.queueExpirySeconds * 1_000);
  });
});
