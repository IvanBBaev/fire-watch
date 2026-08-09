import { describe, expect, it } from 'vitest';

import {
  BUDGETED_JOB_IDS,
  HEARTBEAT_JOB_IDS,
  MONITORED_FEED_IDS,
  MONITORED_SOURCE_IDS,
  UNREGISTERED_FEED_IDS,
  isMonitoredFeedId,
  isMonitoredSourceId,
} from './freshness.js';
import { SOURCE_IDS, SOURCE_REGISTRY, activeSources } from './sources.js';

describe('what is monitored', () => {
  it('covers every active source, so a live poller cannot be unwatched', () => {
    // The registry is the authority on what is polled; this table is the authority on what
    // is paged on. A source that goes live in one and not the other is a silent outage.
    expect([...MONITORED_SOURCE_IDS].toSorted()).toEqual(
      activeSources()
        .map((entry) => entry.id)
        .toSorted(),
    );
  });

  it('leaves retired sources out of the paging set', () => {
    // OPERATIONS §1.1(4): a budget that can never be met again is a config change, not a
    // muted rule. Retirement is that change — MODIS shut down, so it stops being watched.
    const retired = SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].status === 'retired');

    expect(retired).toContain('firms:modis');
    for (const id of retired) expect(MONITORED_FEED_IDS).not.toContain(id);
  });

  it('names the three feeds the source registry deliberately does not', () => {
    // GLOSSARY §1a leaves these unregistered because they produce no detections. They are
    // still fetched, and anything fetched can stop arriving.
    for (const id of UNREGISTERED_FEED_IDS) {
      expect(isMonitoredFeedId(id)).toBe(true);
      expect(SOURCE_IDS).not.toContain(id);
    }
  });

  it('keeps the two namespaces distinguishable at runtime', () => {
    // The reader needs this: source rows come out of `source_status`, feed rows do not.
    expect(MONITORED_SOURCE_IDS.every((id) => isMonitoredSourceId(id))).toBe(true);
    expect(UNREGISTERED_FEED_IDS.some((id) => isMonitoredSourceId(id))).toBe(false);
  });

  it('has no duplicate ids across the two namespaces', () => {
    expect(new Set(MONITORED_FEED_IDS).size).toBe(MONITORED_FEED_IDS.length);
  });

  it('rejects a plausible-looking id that is not in the table', () => {
    expect(isMonitoredFeedId('firms:viirs:snpp ')).toBe(false);
    expect(isMonitoredFeedId('EFFIS:layers')).toBe(false);
    expect(isMonitoredFeedId('weather')).toBe(false);
  });
});

describe('what pings', () => {
  it('includes every budgeted job, because a budget nobody reports against is decoration', () => {
    for (const job of BUDGETED_JOB_IDS) expect(HEARTBEAT_JOB_IDS).toContain(job);
  });

  it('adds the two jobs that ping without having a row of their own', () => {
    // The ingest cycle is covered per source by the endpoint; its heartbeat exists for the
    // case the endpoint cannot cover — the box being gone. The deploy smoke has no cadence.
    expect(HEARTBEAT_JOB_IDS).toContain('ingest-cycle');
    expect(HEARTBEAT_JOB_IDS).toContain('deploy-smoke');
    expect(HEARTBEAT_JOB_IDS).toHaveLength(BUDGETED_JOB_IDS.length + 2);
  });
});
