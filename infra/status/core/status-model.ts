/**
 * Probe results → the public component status model (TASKS J5; OPERATIONS §10).
 *
 * The status page publishes "the current state of the three probe targets (map read
 * path, API, freshness); per-source freshness state using the same bands as §1.2, so users
 * and operator read one clock" (§10.3). This module is that mapping and nothing else: it
 * takes what an off-infra probe observed, already reduced to plain data, and a `now` the
 * caller supplies, and returns the model the renderer draws. No I/O, no clock, no copy —
 * the words live in `strings.ts`, the fetching in `adapters/http-probe.ts`.
 *
 * Four components:
 *
 *   - `api` — `/healthz`, process liveness (§2.1). Up or down.
 *   - `map` — the primary map read path: the snapshot document as the public hostname
 *     serves it, aged by its body's `generated_at` — the same clock the client's staleness
 *     banner reads (the F4 lesson: never `Date`, `Age` or a revalidation time).
 *   - `map-backup` — the T2 static mirror on R2 (TASKS E3), aged by the job-written
 *     `x-amz-meta-generated-at`, falling back to `Last-Modified`, exactly like the in-worker
 *     age monitor (`server/src/core/snapshot/mirror-age.ts`). Both are banded by the
 *     `snapshot-push` budget (§1.3: warn 5 min, critical 15 min).
 *   - `data-freshness` — `/api/health/freshness`. Its per-row states become the source list.
 *
 * What never reaches the model: URLs, hostnames, error messages, response headers. The
 * adapter's raw failure text stays on the operator's console (§10.4: no internal hostnames,
 * no vendor details); the model carries reason *codes* the catalog turns into sentences.
 */

import type { FreshnessBody } from './freshness-body.js';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

export const STATUS_SCHEMA = 'fire-watch-status/1';

export const COMPONENT_IDS = ['api', 'map', 'map-backup', 'data-freshness'] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

/** Ordered by severity; `unknown` ranks above operational because it cannot vouch for it. */
export const COMPONENT_LEVELS = ['operational', 'unknown', 'degraded', 'outage'] as const;
export type ComponentLevel = (typeof COMPONENT_LEVELS)[number];

export const REASON_CODES = [
  'up',
  'fresh',
  'stale',
  'future_stamp',
  'unreachable',
  'http_status',
  'bad_body',
  'missing',
  'no_age_signal',
  'report_ok',
  'report_warn',
  'report_critical',
  'endpoint_error',
  'not_configured',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const SOURCE_LEVELS = [
  'on_time',
  'delayed',
  'severely_delayed',
  'muted',
  'no_data',
] as const;
export type SourceLevel = (typeof SOURCE_LEVELS)[number];

/* -------------------------------------------------------------------------- */
/* Input: what the probe saw                                                  */
/* -------------------------------------------------------------------------- */

/** Never carries the failure text: that is for stderr, not for a public JSON file. */
export interface Unreachable {
  readonly kind: 'unreachable';
}
export interface NotConfigured {
  readonly kind: 'not_configured';
}

export type StatusObservation =
  Unreachable | NotConfigured | { readonly kind: 'response'; readonly status: number };

export type BodyObservation =
  | Unreachable
  | NotConfigured
  | { readonly kind: 'response'; readonly status: number; readonly body: unknown };

export type HeadObservation =
  | Unreachable
  | NotConfigured
  | {
      readonly kind: 'response';
      readonly status: number;
      /** `x-amz-meta-generated-at`, verbatim. */
      readonly generatedAtHeader: string | null;
      /** `Last-Modified`, verbatim. */
      readonly lastModifiedHeader: string | null;
    };

export interface ProbeResults {
  readonly healthz: StatusObservation;
  readonly freshness: BodyObservation;
  readonly snapshot: BodyObservation;
  readonly mirror: HeadObservation;
}

export interface AgeBudget {
  readonly warnSeconds: number;
  readonly criticalSeconds: number;
}

/**
 * OPERATIONS §1.3 `snapshot-push`: warn at 5 min (exactly where ADR-003's "≤5 min" promise
 * breaks — `SNAPSHOT_PUSH_WARN_SECONDS` in contracts), critical at 15 min. Pinned against
 * the contract constant by a test, so the status page and the banner cannot disagree.
 */
export const SNAPSHOT_AGE_BUDGET: AgeBudget = { warnSeconds: 5 * 60, criticalSeconds: 15 * 60 };

/** A stamp this far in the future is a clock problem, not a fresh object (as `mirror-age.ts`). */
export const FUTURE_STAMP_TOLERANCE_SECONDS = 60;

/* -------------------------------------------------------------------------- */
/* Output: the model                                                          */
/* -------------------------------------------------------------------------- */

export interface ComponentStatus {
  readonly id: ComponentId;
  readonly level: ComponentLevel;
  readonly reason: ReasonCode;
  /** Data age in seconds where the component has one (`map`, `map-backup`). */
  readonly ageSeconds: number | null;
  /** The instant the data was generated, ISO-8601, where known. */
  readonly dataGeneratedAt: string | null;
  /** When this component entered its current level, ISO-8601 — the incident start time. */
  readonly since: string;
  /**
   * An outage seen once only. §2.2 rule 7: one failed probe is not an incident, so a first
   * failure is published as `degraded` with this flag and becomes `outage` on the next run.
   */
  readonly unconfirmed: boolean;
}

export interface SourceStatus {
  readonly row: string;
  readonly level: SourceLevel;
  readonly ageSeconds: number | null;
  readonly lastSuccessAt: string | null;
  readonly mutedUntil: string | null;
  /** Operator-written mute text (§1.1 rule 6). Published verbatim, as §10.3 requires. */
  readonly muteReason: string | null;
}

export interface StatusModel {
  readonly schema: typeof STATUS_SCHEMA;
  readonly generatedAt: string;
  readonly overall: ComponentLevel;
  readonly components: readonly ComponentStatus[];
  /** Empty when the freshness body could not be read. */
  readonly sources: readonly SourceStatus[];
  /** The budget-table version the freshness verdict was reached under, when known. */
  readonly budgetVersion: string | null;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

export interface Verdict {
  readonly level: ComponentLevel;
  readonly reason: ReasonCode;
  readonly ageSeconds: number | null;
  readonly dataGeneratedAt: string | null;
}

const verdict = (
  level: ComponentLevel,
  reason: ReasonCode,
  ageSeconds: number | null = null,
  dataGeneratedAt: string | null = null,
): Verdict => ({ level, reason, ageSeconds, dataGeneratedAt });

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** ISO-8601 or RFC 7231 date → epoch ms, or `null`. `Date.parse` reads a string; it is no clock. */
function parseInstant(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function ageVerdict(anchorMs: number, nowMs: number, budget: AgeBudget): Verdict {
  const generatedAt = new Date(anchorMs).toISOString();
  const ageSeconds = Math.floor((nowMs - anchorMs) / 1000);
  if (ageSeconds < -FUTURE_STAMP_TOLERANCE_SECONDS) {
    return verdict('degraded', 'future_stamp', ageSeconds, generatedAt);
  }
  const age = Math.max(0, ageSeconds);
  if (age >= budget.criticalSeconds) return verdict('outage', 'stale', age, generatedAt);
  if (age >= budget.warnSeconds) return verdict('degraded', 'stale', age, generatedAt);
  return verdict('operational', 'fresh', age, generatedAt);
}

export function evaluateApi(observation: StatusObservation): Verdict {
  if (observation.kind === 'not_configured') return verdict('unknown', 'not_configured');
  if (observation.kind === 'unreachable') return verdict('outage', 'unreachable');
  return isOk(observation.status) ? verdict('operational', 'up') : verdict('outage', 'http_status');
}

export function evaluateSnapshot(
  observation: BodyObservation,
  nowMs: number,
  budget: AgeBudget = SNAPSHOT_AGE_BUDGET,
): Verdict {
  if (observation.kind === 'not_configured') return verdict('unknown', 'not_configured');
  if (observation.kind === 'unreachable') return verdict('outage', 'unreachable');
  if (!isOk(observation.status)) return verdict('outage', 'http_status');
  const body = observation.body;
  const generatedAt =
    typeof body === 'object' && body !== null && 'generated_at' in body
      ? (body as { readonly generated_at: unknown }).generated_at
      : null;
  const anchorMs = typeof generatedAt === 'string' ? parseInstant(generatedAt) : null;
  if (anchorMs === null) return verdict('outage', 'bad_body');
  return ageVerdict(anchorMs, nowMs, budget);
}

export function evaluateMirror(
  observation: HeadObservation,
  nowMs: number,
  budget: AgeBudget = SNAPSHOT_AGE_BUDGET,
): Verdict {
  if (observation.kind === 'not_configured') return verdict('unknown', 'not_configured');
  if (observation.kind === 'unreachable') return verdict('outage', 'unreachable');
  if (observation.status === 404 || observation.status === 403 || observation.status === 410) {
    // R2 answers 403 for a missing key on a bucket without list rights.
    return verdict('outage', 'missing');
  }
  if (!isOk(observation.status)) return verdict('outage', 'http_status');
  const anchorMs =
    parseInstant(observation.generatedAtHeader) ?? parseInstant(observation.lastModifiedHeader);
  if (anchorMs === null) return verdict('outage', 'no_age_signal');
  return ageVerdict(anchorMs, nowMs, budget);
}

export function evaluateFreshness(
  observation: BodyObservation,
  parsed: FreshnessBody | null,
): Verdict {
  if (observation.kind === 'not_configured') return verdict('unknown', 'not_configured');
  // The API component already says whether the origin is down; this one cannot tell.
  if (observation.kind === 'unreachable') return verdict('unknown', 'unreachable');
  if (parsed === null) {
    // §2.2 rule 5: a DB failure or timeout is a 500 with a reason — not a report, but a
    // failure the endpoint chose to announce.
    return observation.status >= 500
      ? verdict('outage', 'endpoint_error')
      : verdict('unknown', 'bad_body');
  }
  switch (parsed.status) {
    case 'ok':
      return verdict('operational', 'report_ok');
    case 'warn':
      return verdict('degraded', 'report_warn');
    case 'critical':
      // §2.2 rule 2: only the wire says whether a paging row broke; a 200 "critical" is a
      // non-paging row past its budget and must not read as an outage.
      return observation.status >= 500
        ? verdict('outage', 'report_critical')
        : verdict('degraded', 'report_critical');
  }
}

export function sourceLevel(row: FreshnessBody['rows'][number]): SourceLevel {
  switch (row.state) {
    case 'ok':
      return 'on_time';
    case 'warn':
      return 'delayed';
    case 'critical':
      return 'severely_delayed';
    case 'muted':
      return 'muted';
    case 'unknown':
      return 'no_data';
  }
}

const severity = (level: ComponentLevel): number => COMPONENT_LEVELS.indexOf(level);

const worst = (levels: readonly ComponentLevel[]): ComponentLevel =>
  levels.reduce<ComponentLevel>((a, b) => (severity(b) > severity(a) ? b : a), 'operational');

/**
 * The headline. Not simply the worst component, because the map has two legs:
 *
 *   - the backup copy is a fallback — when it fails and the primary is healthy, users are
 *     unaffected today but have lost their safety net: that is `degraded`, never `outage`;
 *   - when the primary map fails but the backup is operational, the client flips to it
 *     (ADR-003 D1, T2): the map is still there, older by at most the T2 bound — `degraded`.
 *
 * Components the probe was not configured for are left out: before launch some targets do
 * not exist yet, and "unknown" for a thing nobody runs would make the headline useless.
 */
export function overallLevel(components: readonly ComponentStatus[]): ComponentLevel {
  const configured = components.filter((c) => c.reason !== 'not_configured');
  if (configured.length === 0) return 'unknown';
  const byId = new Map(configured.map((c) => [c.id, c.level] as const));
  const backup = byId.get('map-backup');
  const levels: ComponentLevel[] = [];
  for (const component of configured) {
    if (component.id === 'map-backup') {
      levels.push(component.level === 'outage' ? 'degraded' : component.level);
    } else if (component.id === 'map' && component.level === 'outage' && backup === 'operational') {
      levels.push('degraded');
    } else {
      levels.push(component.level);
    }
  }
  return worst(levels);
}

/**
 * Carries `since` across runs and applies the two-consecutive-failures rule (§2.2 rule 7).
 * `previous` is the last published model, or `null` on the first run / when unreadable.
 */
function confirm(
  id: ComponentId,
  current: Verdict,
  previous: StatusModel | null,
  generatedAt: string,
): ComponentStatus {
  const before = previous?.components.find((c) => c.id === id) ?? null;
  const previouslyFailing =
    before !== null && (before.level === 'outage' || before.level === 'degraded');
  const unconfirmed = current.level === 'outage' && !previouslyFailing;
  const level: ComponentLevel = unconfirmed ? 'degraded' : current.level;
  // An outage confirmed on this run started when it was first seen, unconfirmed.
  const continues =
    before !== null && (before.level === level || (before.unconfirmed && level === 'outage'));
  const since = continues ? before.since : generatedAt;
  return { id, ...current, level, since, unconfirmed };
}

export interface EvaluateInput {
  readonly results: ProbeResults;
  readonly parsedFreshness: FreshnessBody | null;
  /** The probe's own clock, epoch ms. The only time input; this module never reads one. */
  readonly nowMs: number;
  readonly previous: StatusModel | null;
}

export function evaluateStatus(input: EvaluateInput): StatusModel {
  const { results, parsedFreshness, nowMs, previous } = input;
  const generatedAt = new Date(nowMs).toISOString();
  const verdicts: Record<ComponentId, Verdict> = {
    api: evaluateApi(results.healthz),
    map: evaluateSnapshot(results.snapshot, nowMs),
    'map-backup': evaluateMirror(results.mirror, nowMs),
    'data-freshness': evaluateFreshness(results.freshness, parsedFreshness),
  };
  const components = COMPONENT_IDS.map((id) => confirm(id, verdicts[id], previous, generatedAt));
  const sources: SourceStatus[] = (parsedFreshness?.rows ?? []).map((row) => ({
    row: row.row,
    level: sourceLevel(row),
    ageSeconds: row.ageSeconds,
    lastSuccessAt: row.lastSuccessAt,
    mutedUntil: row.state === 'muted' ? row.mutedUntil : null,
    muteReason: row.state === 'muted' ? row.muteReason : null,
  }));
  return {
    schema: STATUS_SCHEMA,
    generatedAt,
    overall: overallLevel(components),
    components,
    sources,
    budgetVersion: parsedFreshness?.budgetVersion ?? null,
  };
}

/**
 * The previously published `status.json`, or `null` if it is not one this version wrote.
 * Only what {@link confirm} needs is checked; anything else is ignored rather than trusted.
 */
export function parsePreviousModel(value: unknown): StatusModel | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Record<keyof StatusModel, unknown>>;
  if (candidate.schema !== STATUS_SCHEMA || !Array.isArray(candidate.components)) return null;
  const components: ComponentStatus[] = [];
  for (const raw of candidate.components as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return null;
    const c = raw as Partial<Record<keyof ComponentStatus, unknown>>;
    if (
      !(COMPONENT_IDS as readonly unknown[]).includes(c.id) ||
      !(COMPONENT_LEVELS as readonly unknown[]).includes(c.level) ||
      typeof c.since !== 'string' ||
      parseInstant(c.since) === null
    ) {
      return null;
    }
    components.push({
      id: c.id as ComponentId,
      level: c.level as ComponentLevel,
      reason: (REASON_CODES as readonly unknown[]).includes(c.reason)
        ? (c.reason as ReasonCode)
        : 'up',
      ageSeconds: null,
      dataGeneratedAt: null,
      since: c.since,
      unconfirmed: c.unconfirmed === true,
    });
  }
  return {
    schema: STATUS_SCHEMA,
    generatedAt: typeof candidate.generatedAt === 'string' ? candidate.generatedAt : '',
    overall: 'unknown',
    components,
    sources: [],
    budgetVersion: null,
  };
}
