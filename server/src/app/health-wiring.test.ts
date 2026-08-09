import { describe, expect, it } from 'vitest';

import { budgetFor } from '../core/config/freshness-budgets.js';
import { liveFirmsSources } from '../core/ingest/firms-poller.js';
import { expectedRows } from './health-wiring.js';

describe('expectedRows', () => {
  it('claims only rows the shipped budget table can score', () => {
    // An expected row without a budget makes the evaluator throw on *every* request — a
    // permanent 500 that would otherwise be discovered by the prober, at runtime, after a
    // deploy. This pins the invariant where it is cheap: at test time.
    for (const row of expectedRows()) {
      expect(budgetFor(row), `no freshness budget for ${row}`).toBeDefined();
    }
  });

  it('claims exactly the sources a live cycle polls', () => {
    // No more and no less: an extra row is a deployment permanently warn on work nobody
    // runs, and a missing one is a source that can stop without the endpoint noticing.
    // The narrowing filter inside expectedRows() must therefore drop nothing today —
    // the day it drops a live source, this fails before the endpoint goes quiet.
    expect(expectedRows()).toEqual(liveFirmsSources());
  });
});
