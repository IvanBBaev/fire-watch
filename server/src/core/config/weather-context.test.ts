import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { WEATHER_CONTEXT, latestPublishedCycle } from './weather-context.js';

describe('WEATHER_CONTEXT', () => {
  it('is versioned so recorded fields can cite the parameter set they were taken under', () => {
    expect(WEATHER_CONTEXT.version).toBe('weather_context_v1');
    expect(WEATHER_CONTEXT.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps the licence-clean cloud fallback in the parameter set', () => {
    // A19 / DATA-SOURCES §D3: Open-Meteo is dev-only, so `tcc` from ECMWF is the cloud
    // cover we are allowed to ship. Dropping it here would silently reopen the fence.
    expect(WEATHER_CONTEXT.values.params).toContain('tcc');
  });
});

describe('latestPublishedCycle', () => {
  it('picks the newest run older than the publication delay', () => {
    // 15:00 UTC minus the 8 h delay is 07:00 — the 06z run is out, 12z is not yet.
    const cycle = latestPublishedCycle(epochMsFromIso('2026-08-13T15:00:00Z'));
    expect(cycle).toEqual({ dateYmd: '20260813', hour: 6 });
  });

  it('rolls to the previous day when today has no published run yet', () => {
    // 05:00 UTC minus 8 h is 21:00 *yesterday* — the newest safe run is yesterday's 18z.
    const cycle = latestPublishedCycle(epochMsFromIso('2026-08-13T05:00:00Z'));
    expect(cycle).toEqual({ dateYmd: '20260812', hour: 18 });
  });

  it('rolls across a month boundary without string arithmetic accidents', () => {
    const cycle = latestPublishedCycle(epochMsFromIso('2026-09-01T03:00:00Z'));
    expect(cycle).toEqual({ dateYmd: '20260831', hour: 18 });
  });

  it('treats a run exactly at the delay boundary as published', () => {
    // 08:00 minus 8 h is exactly 00:00 — the 00z run counts (<=, not <).
    const cycle = latestPublishedCycle(epochMsFromIso('2026-08-13T08:00:00Z'));
    expect(cycle).toEqual({ dateYmd: '20260813', hour: 0 });
  });
});
