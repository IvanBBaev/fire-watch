/**
 * The freshness vocabulary — what "stale" means, in the one place both sides read it.
 *
 * OPERATIONS §1.1(3) gives this table four consumers: the health endpoint, the Grafana
 * rules, the freshness metadata carried in every payload, and the client's staleness
 * banner. The *thresholds* are server-side config-as-data (they change without a client
 * release); what lives here is the **shape** they are reported in, so that the banner the
 * user sees and the body the pager reads are the same three fields with the same meanings.
 * The client never hardcodes a threshold — it renders `warnSeconds` and `criticalSeconds`
 * as delivered (§1.1(3)).
 *
 * ## What may be monitored, and why it is not just the source registry
 *
 * OPERATIONS §1.2 draws the line this file enforces: detection-source rows reuse "the
 * canonical strings from the frozen source-id registry" verbatim, and the remaining rows
 * are identifiers the budget table mints itself. Three of those (cloud mask, EFFIS,
 * weather) are feeds GLOSSARY §1a explicitly leaves **unregistered**, because they produce
 * no detections and therefore no `detection_uid`. They still have to be named to be paged
 * on. So this file defines a strictly wider *monitoring* namespace: every registered
 * source that is polled keeps its frozen id verbatim, and the three unregistered feeds get
 * ids that live only here.
 *
 * A monitoring id is **not** a uid input and can never become one: it names something we
 * fetch, not something we observed. That is what makes adding one a normal change here
 * while GLOSSARY §1a stays frozen.
 */

import { SOURCE_REGISTRY, type SourceId } from './sources.js';

/**
 * Detection sources that are polled live and therefore have a freshness budget. This is
 * the registry's active set minus nothing — it is written out rather than derived so that
 * a source going live is a visible edit in two places that must agree, and the agreement
 * is a test (`freshness.test.ts`).
 */
export const MONITORED_SOURCE_IDS = [
  'firms:viirs:snpp',
  'firms:viirs:noaa20',
  'firms:viirs:noaa21',
  'eumetsat:slstr:frp',
  'lsasaf:seviri:frp-pixel',
  'lsasaf:fci:frp-pixel',
] as const satisfies readonly SourceId[];

/**
 * Feeds we fetch that produce no detections (GLOSSARY §1a "Not registered"). Named here
 * and nowhere else; never a hash input.
 *
 * - `eumetsat:clm` — the MTG FCI / MSG SEVIRI cloud mask (DATA-SOURCES §E2). One id for
 *   both products, for the same reason `firms:modis` is one id for two platforms: what we
 *   monitor is whether an observed cloud field arrived, not which satellite carried it.
 * - `effis:layers` — the FWI danger layer and the burnt-area perimeters, refreshed through
 *   our proxy (ADR-001 A1.2). One row, because one proxy refresh either ran or did not.
 * - `weather:context` — the weather source of record, deliberately provider-neutral while
 *   A19 is open (ECMWF Open Data vs Open-Meteo, DATA-SOURCES §D2/§D3): the budget is a
 *   property of the *role* the feed plays, and it must not have to be renamed when the
 *   provider behind it is settled.
 */
export type MonitoredSourceId = (typeof MONITORED_SOURCE_IDS)[number];

export const UNREGISTERED_FEED_IDS = ['eumetsat:clm', 'effis:layers', 'weather:context'] as const;

/** Everything with a freshness budget that is fetched from outside, in reporting order. */
export const MONITORED_FEED_IDS = [...MONITORED_SOURCE_IDS, ...UNREGISTERED_FEED_IDS] as const;

export type MonitoredFeedId = (typeof MONITORED_FEED_IDS)[number];

/**
 * Scheduled jobs with a freshness budget (OPERATIONS §1.3). Their primary detector is the
 * healthchecks.io dead-man's switch, not this table — the budget exists so that a job the
 * endpoint *does* answer for (the snapshot push) is scored by the same code as a source.
 */
export const BUDGETED_JOB_IDS = [
  'snapshot-push',
  'nightly-backup',
  'wal-archive',
  'effis-refresh',
] as const;

export type BudgetedJobId = (typeof BUDGETED_JOB_IDS)[number];

/**
 * Every job that pings a dead-man's switch after success (§3, leg 2). Wider than the
 * budgeted set by two:
 *
 * - `ingest-cycle` is the WP1 scheduled job. It has no row of its own because the sources
 *   it polls each have one — a cycle that runs and fails is already visible there — but it
 *   must still ping, because a *dead VM* makes those rows stop moving without anything
 *   in-process left to notice (§3 independence rule 2).
 * - `deploy-smoke` is a per-deploy ping with no cadence and therefore no budget (§1.3).
 */
export const HEARTBEAT_JOB_IDS = [...BUDGETED_JOB_IDS, 'ingest-cycle', 'deploy-smoke'] as const;

export type HeartbeatJobId = (typeof HEARTBEAT_JOB_IDS)[number];

/** Anything the freshness endpoint can hold a row about. */
export type FreshnessRowId = MonitoredFeedId | BudgetedJobId;

/**
 * The state of one row.
 *
 * `unknown` is not a polite `ok`: it means this deployment has never seen the row succeed
 * *or* attempt, so there is no age to compare against a budget. It is reported loudly and
 * never 500s — a database that has just been created must not roll a first deploy back
 * (§2.2 rule 8), and the leg that catches "the job never started at all" is the
 * heartbeat, not this endpoint.
 */
export const FRESHNESS_STATES = ['ok', 'warn', 'critical', 'muted', 'unknown'] as const;

export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** The three values the body as a whole can take (§2.2 rule 2). */
export const FRESHNESS_STATUSES = ['ok', 'warn', 'critical'] as const;

export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

/**
 * One row of the freshness body. RB-1 starts by reading this, so it carries enough to name
 * the failing feed and its budget without opening a dashboard (§2.2 rule 3).
 */
export interface FreshnessRow {
  readonly row: FreshnessRowId;
  /** ISO-8601 UTC, or `null` when it has never happened. */
  readonly lastSuccessAt: string | null;
  /**
   * Distinct from `lastSuccessAt` on purpose: a poll that succeeds with zero rows is
   * healthy, and conflating the two makes a quiet season look like an outage (§1.1(5)).
   */
  readonly lastDataAt: string | null;
  /** Seconds since `lastSuccessAt`; `null` only when there has never been one. */
  readonly ageSeconds: number | null;
  readonly warnSeconds: number;
  readonly criticalSeconds: number;
  readonly state: FreshnessState;
  readonly consecutiveFailures: number;
  /** Whether breaching this row's critical budget is allowed to 500 the endpoint (§1.2). */
  readonly pages: boolean;
  /** Set while a §1.1(6) mute is in force; both fields are shown on the status page. */
  readonly mutedUntil: string | null;
  readonly muteReason: string | null;
}

/** The freshness body, and the same object the payload freshness metadata is built from. */
export interface FreshnessReport {
  readonly generatedAt: string;
  readonly status: FreshnessStatus;
  /** The budget table this verdict was reached under, so a page cites its own thresholds. */
  readonly budgetVersion: string;
  /** Offending rows first (§2.2 rule 2); ties keep the caller's `expected` order. */
  readonly rows: readonly FreshnessRow[];
}

const MONITORED_ID_SET: ReadonlySet<string> = new Set<string>(MONITORED_FEED_IDS);

export function isMonitoredFeedId(value: string): value is MonitoredFeedId {
  return MONITORED_ID_SET.has(value);
}

/**
 * Whether a monitoring id is also a frozen detection source. The freshness reader needs
 * this: source rows come from `source_status`, and the unregistered feeds do not.
 */
export function isMonitoredSourceId(value: MonitoredFeedId): value is MonitoredSourceId {
  return Object.hasOwn(SOURCE_REGISTRY, value);
}
