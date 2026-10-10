import { describe, expect, it } from 'vitest';

import type {
  LightningBackfillEvent,
  LightningBackfillOutcome,
  LightningBackfillReport,
} from '../core/lightning/lightning-context-backfill.js';
import { ConfigError, loadConfig } from './config.js';
import {
  EXIT_INCOMPLETE,
  LIGHTNING_BACKFILL_DEFAULTS,
  lightningBackfillExitCode,
  parseLightningBackfillArgs,
  requireLightningBackfill,
} from './lightning-backfill-config.js';

describe('parseLightningBackfillArgs', () => {
  it('defaults both bounds', () => {
    expect(parseLightningBackfillArgs([])).toEqual(LIGHTNING_BACKFILL_DEFAULTS);
  });

  it('reads both bounds; zero products is a dry run over records already on disk', () => {
    expect(parseLightningBackfillArgs(['--max-products=0', '--max-events=3'])).toEqual({
      maxEvents: 3,
      maxProducts: 0,
    });
  });

  it.each([
    ['--max-events=0'],
    ['--max-events=-1'],
    ['--max-events=1.5'],
    ['--max-events='],
    ['--max-events=1001'],
    ['--max-products=5001'],
    ['--max-products=1e3'],
    ['--max-event=3'],
    ['--dry-run'],
    ['--max-events=1', '--max-events=2'],
    ['--max-products=1', '--max-products=2'],
  ])('refuses %j', (...args) => {
    expect(() => parseLightningBackfillArgs(args)).toThrow(ConfigError);
  });
});

describe('requireLightningBackfill', () => {
  const base = { DATABASE_URL: 'postgres://u@db/fw', FIRMS_MAP_KEY: 'k'.repeat(32) };

  it('refuses to run without the EUMETSAT credentials, and says nothing was fetched', () => {
    const config = loadConfig(base);
    expect(() => requireLightningBackfill(config)).toThrow(ConfigError);
    expect(() => requireLightningBackfill(config)).toThrow(
      /EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET are not set.*Nothing was fetched/,
    );
  });

  it('hands over the credentials and the state dir when both are configured', () => {
    const config = loadConfig({
      ...base,
      EUMETSAT_CONSUMER_KEY: 'key',
      EUMETSAT_CONSUMER_SECRET: 'secret',
      FIRE_WATCH_STATE_DIR: '/var/lib/fire-watch',
    });
    const required = requireLightningBackfill(config);
    expect(required.stateDir).toBe('/var/lib/fire-watch');
    expect(required.lightning.credentials).toEqual({
      consumerKey: 'key',
      consumerSecret: 'secret',
    });
  });
});

describe('lightningBackfillExitCode', () => {
  function report(
    outcomes: readonly LightningBackfillOutcome[],
    extra: Partial<LightningBackfillReport> = {},
  ): LightningBackfillReport {
    const events = outcomes.map((outcome, i): LightningBackfillEvent => ({
      eventId: String(i),
      reason: 'unavailable',
      windowFrom: '2026-09-30T09:00:00.000Z',
      windowTo: '2026-09-30T12:00:00.000Z',
      outcome,
      found: 0,
      reused: 0,
      downloaded: 0,
      notAttempted: 0,
      missing: [],
      flashCount: null,
      nearestKm: null,
      errors: [],
    }));
    return {
      startedAt: 0,
      finishedAt: 0,
      firstDetectedBefore: 0,
      listed: events.length,
      downloads: 0,
      stopped: null,
      events,
      error: null,
      ...extra,
    };
  }

  it('is 0 only when every listed event was answered (or none needed one)', () => {
    expect(lightningBackfillExitCode(report([]))).toBe(0);
    expect(lightningBackfillExitCode(report(['complete', 'complete']))).toBe(0);
  });

  it('is 3 while some events are still incomplete', () => {
    expect(lightningBackfillExitCode(report(['complete', 'partial']))).toBe(EXIT_INCOMPLETE);
    expect(lightningBackfillExitCode(report(['not_covered']))).toBe(EXIT_INCOMPLETE);
    expect(lightningBackfillExitCode(report(['budget_exhausted']))).toBe(EXIT_INCOMPLETE);
  });

  it('is 1 on any failure, an auth stop, or a store error', () => {
    expect(lightningBackfillExitCode(report(['complete', 'failed']))).toBe(1);
    expect(lightningBackfillExitCode(report(['search_failed']))).toBe(1);
    expect(lightningBackfillExitCode(report(['budget_exhausted'], { stopped: 'auth' }))).toBe(1);
    expect(lightningBackfillExitCode(report([], { error: 'store: down' }))).toBe(1);
  });
});
