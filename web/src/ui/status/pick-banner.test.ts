import { describe, expect, it } from 'vitest';

import type {
  FreshnessReport,
  FreshnessRow,
  FreshnessRowId,
  FreshnessState,
  FreshnessStatus,
} from '@fire-watch/contracts';
import type { StoreState } from '../../core/types.js';
import { pickBanner } from './pick-banner.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');
// A snapshot and an observation age at completely different rates: the push runs every
// minute, while the detections it carries are hours old by nature. The fixtures keep them
// apart, because conflating them is what makes a stale-snapshot test read as a healthy one.
const FRESH_SNAPSHOT = '2026-08-09T11:58:00Z';
const SNAPSHOT_AT_THRESHOLD = '2026-08-09T11:50:00Z';
const SNAPSHOT_PAST_THRESHOLD = '2026-08-09T11:49:59Z';
const AN_HOUR_AGO = '2026-08-09T11:00:00Z';
const TWO_HOURS_AGO = '2026-08-09T10:00:00Z';
const THREE_HOURS_AGO = '2026-08-09T09:00:00Z';
const IN_THE_FUTURE = '2026-08-09T13:00:00Z';

function makeRow(
  overrides: Partial<FreshnessRow> & { readonly row: FreshnessRowId },
): FreshnessRow {
  return {
    lastSuccessAt: AN_HOUR_AGO,
    lastDataAt: AN_HOUR_AGO,
    ageSeconds: 3_600,
    warnSeconds: 7_200,
    criticalSeconds: 14_400,
    state: 'ok',
    consecutiveFailures: 0,
    pages: true,
    mutedUntil: null,
    muteReason: null,
    ...overrides,
  };
}

function makeReport(status: FreshnessStatus, rows: readonly FreshnessRow[]): FreshnessReport {
  return { generatedAt: AN_HOUR_AGO, status, budgetVersion: 'test-1', rows };
}

function makeState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    events: new Map(),
    maxSeq: 0,
    lastSnapshotAt: FRESH_SNAPSHOT,
    freshness: null,
    feedStatus: 'live',
    needsSnapshot: false,
    sources: [],
    ...overrides,
  };
}

/** All six monitored detection sources in one state, freshest data at `freshestIso`. */
function allMonitoredRows(state: FreshnessState, freshestIso: string): FreshnessRow[] {
  return [
    makeRow({ row: 'firms:viirs:snpp', state, lastDataAt: THREE_HOURS_AGO }),
    makeRow({ row: 'firms:viirs:noaa20', state, lastDataAt: freshestIso }),
    makeRow({ row: 'firms:viirs:noaa21', state, lastDataAt: THREE_HOURS_AGO }),
    makeRow({ row: 'eumetsat:slstr:frp', state, lastDataAt: TWO_HOURS_AGO }),
    makeRow({ row: 'lsasaf:seviri:frp-pixel', state, lastDataAt: THREE_HOURS_AGO }),
    makeRow({ row: 'lsasaf:fci:frp-pixel', state, lastDataAt: null }),
  ];
}

describe('priority: offline beats stale-sources', () => {
  it('banners offline when the feed is dead, even with a critical freshness report', () => {
    const state = makeState({
      feedStatus: 'dead',
      freshness: makeReport('critical', allMonitoredRows('critical', TWO_HOURS_AGO)),
    });
    expect(pickBanner(state, NOW)).toEqual({ kind: 'offline' });
  });

  it('banners offline when degraded and no snapshot has ever been applied', () => {
    const state = makeState({ feedStatus: 'degraded', lastSnapshotAt: null });
    expect(pickBanner(state, NOW)).toEqual({ kind: 'offline' });
  });

  it('does not banner a degraded feed that still has data and no freshness verdict', () => {
    const state = makeState({ feedStatus: 'degraded' });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('never banners while connecting with nothing shown yet', () => {
    const state = makeState({ feedStatus: 'connecting', lastSnapshotAt: null });
    expect(pickBanner(state, NOW)).toBeNull();
  });
});

describe('stale-sources', () => {
  it('banners on a critical report and cites the freshest monitored lastDataAt', () => {
    const state = makeState({
      freshness: makeReport('critical', allMonitoredRows('critical', TWO_HOURS_AGO)),
    });
    expect(pickBanner(state, NOW)).toEqual({ kind: 'stale-sources', sinceIso: TWO_HOURS_AGO });
  });

  it('banners when every monitored row is warn even if overall status is only warn', () => {
    const state = makeState({
      freshness: makeReport('warn', allMonitoredRows('warn', AN_HOUR_AGO)),
    });
    expect(pickBanner(state, NOW)).toEqual({ kind: 'stale-sources', sinceIso: AN_HOUR_AGO });
  });

  it('stays quiet on warn while at least one monitored source is still ok', () => {
    const rows = allMonitoredRows('warn', AN_HOUR_AGO);
    const [first, ...rest] = rows;
    if (first === undefined) throw new Error('fixture must not be empty');
    const state = makeState({
      freshness: makeReport('warn', [{ ...first, state: 'ok' }, ...rest]),
    });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('never banners off unmonitored rows alone, even critical ones', () => {
    const state = makeState({
      freshness: makeReport('critical', [
        makeRow({ row: 'effis:layers', state: 'critical' }),
        makeRow({ row: 'snapshot-push', state: 'critical' }),
      ]),
    });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('does not treat muted or unknown monitored rows as degraded', () => {
    const rows = allMonitoredRows('warn', AN_HOUR_AGO);
    const [first, ...rest] = rows;
    if (first === undefined) throw new Error('fixture must not be empty');
    const state = makeState({
      freshness: makeReport('warn', [{ ...first, state: 'muted' }, ...rest]),
    });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('falls back to the last snapshot time when no monitored row has data', () => {
    const rows = allMonitoredRows('critical', AN_HOUR_AGO).map((freshnessRow) => ({
      ...freshnessRow,
      lastDataAt: null,
    }));
    const state = makeState({
      lastSnapshotAt: TWO_HOURS_AGO,
      freshness: makeReport('critical', rows),
    });
    expect(pickBanner(state, NOW)).toEqual({ kind: 'stale-sources', sinceIso: TWO_HOURS_AGO });
  });

  it('stays quiet without any honest since instant at all', () => {
    const rows = allMonitoredRows('critical', AN_HOUR_AGO).map((freshnessRow) => ({
      ...freshnessRow,
      lastDataAt: null,
    }));
    const state = makeState({
      lastSnapshotAt: null,
      freshness: makeReport('critical', rows),
    });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('rejects a since instant in the future of server time (clock skew)', () => {
    const state = makeState({
      freshness: makeReport('critical', allMonitoredRows('critical', IN_THE_FUTURE)),
    });
    expect(pickBanner(state, NOW)).toBeNull();
  });
});

describe('stale-sources: snapshot age (§3b trigger 1)', () => {
  it('banners on a snapshot past the budget even with no freshness report at all', () => {
    // The production hole this trigger exists for: the freshness probe travels the same
    // path as the snapshot, so a pipeline that has simply stopped answers neither. Without
    // this branch the app renders old fires with no banner — silence read as "all clear".
    const state = makeState({ lastSnapshotAt: '2026-07-25T12:00:00Z' });
    expect(pickBanner(state, NOW)).toEqual({
      kind: 'stale-sources',
      sinceIso: '2026-07-25T12:00:00Z',
    });
  });

  it('banners once the snapshot is past 2× the push budget', () => {
    const state = makeState({ lastSnapshotAt: SNAPSHOT_PAST_THRESHOLD });
    expect(pickBanner(state, NOW)).toEqual({
      kind: 'stale-sources',
      sinceIso: SNAPSHOT_PAST_THRESHOLD,
    });
  });

  it('stays quiet at exactly 2× the push budget — the trigger is "past", not "at"', () => {
    const state = makeState({ lastSnapshotAt: SNAPSHOT_AT_THRESHOLD });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('banners on snapshot age even while every source row reports ok', () => {
    // The two triggers are independent: sources answering upstream says nothing about
    // whether what they produced ever reached this screen.
    const state = makeState({
      lastSnapshotAt: SNAPSHOT_PAST_THRESHOLD,
      freshness: makeReport('ok', allMonitoredRows('ok', AN_HOUR_AGO)),
    });
    expect(pickBanner(state, NOW)).toEqual({
      kind: 'stale-sources',
      sinceIso: SNAPSHOT_PAST_THRESHOLD,
    });
  });

  it('lets offline keep the slot when the snapshot is stale too', () => {
    const state = makeState({ feedStatus: 'dead', lastSnapshotAt: SNAPSHOT_PAST_THRESHOLD });
    expect(pickBanner(state, NOW)).toEqual({ kind: 'offline' });
  });

  it('prefers the report verdict, which can cite a satellite instant this branch cannot', () => {
    const state = makeState({
      lastSnapshotAt: SNAPSHOT_PAST_THRESHOLD,
      freshness: makeReport('critical', allMonitoredRows('critical', TWO_HOURS_AGO)),
    });
    expect(pickBanner(state, NOW)).toEqual({ kind: 'stale-sources', sinceIso: TWO_HOURS_AGO });
  });

  it('stays quiet when no snapshot has ever been applied', () => {
    const state = makeState({ feedStatus: 'connecting', lastSnapshotAt: null });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('rejects a snapshot stamp in the future of server time (clock skew)', () => {
    const state = makeState({ lastSnapshotAt: IN_THE_FUTURE });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('rejects an unparseable snapshot stamp rather than guessing it is stale', () => {
    const state = makeState({ lastSnapshotAt: 'not-a-timestamp' });
    expect(pickBanner(state, NOW)).toBeNull();
  });
});

describe('single-slot discipline and quiet defaults', () => {
  it('returns exactly one verdict — a discriminated union, never a list', () => {
    const state = makeState({
      feedStatus: 'dead',
      freshness: makeReport('critical', allMonitoredRows('critical', TWO_HOURS_AGO)),
    });
    const banner = pickBanner(state, NOW);
    expect(banner).not.toBeNull();
    expect(banner?.kind).toBe('offline');
  });

  it('renders nothing for a healthy live state', () => {
    const state = makeState({
      freshness: makeReport('ok', allMonitoredRows('ok', AN_HOUR_AGO)),
    });
    expect(pickBanner(state, NOW)).toBeNull();
  });

  it('renders nothing when no freshness report has arrived yet', () => {
    expect(pickBanner(makeState(), NOW)).toBeNull();
  });
});
