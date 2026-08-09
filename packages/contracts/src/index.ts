/**
 * Shared vocabulary and rules, imported verbatim by server and web (ADR-005 D3).
 *
 * Everything exported here is platform-neutral. Node-only helpers — currently the
 * `detection_uid` hash — live in `@fire-watch/contracts/node`.
 */

export {
  SOURCE_IDS,
  SOURCE_REGISTRY,
  SOURCE_REGISTRY_VERSION,
  activeSources,
  assertSourceId,
  expectedOverpassSources,
  isSourceId,
  type ProductTier,
  type SourceId,
  type SourceRegistryEntry,
  type SourceStatus,
} from './sources.js';

export {
  CURATED_LIFECYCLE_STATES,
  LIFECYCLE_STATES,
  MACHINE_LIFECYCLE_STATES,
  RELATION_KINDS,
  SCORE_BUCKETS,
  SCORE_BUCKET_FLOOR,
  assertLifecycleState,
  isCuratedLifecycleState,
  isLifecycleState,
  isRelationKind,
  scoreBucket,
  type CuratedLifecycleState,
  type LifecycleState,
  type MachineLifecycleState,
  type RelationKind,
  type ScoreBucket,
} from './lifecycle.js';

export {
  canonicalAcqTsIso,
  canonicalAcqTsIsoFromInstant,
  canonicalDegrees,
  detectionUidPreimage,
  type DetectionUidParts,
} from './detection-uid.js';

export {
  BUDGETED_JOB_IDS,
  FRESHNESS_STATES,
  FRESHNESS_STATUSES,
  HEARTBEAT_JOB_IDS,
  MONITORED_FEED_IDS,
  MONITORED_SOURCE_IDS,
  UNREGISTERED_FEED_IDS,
  isMonitoredFeedId,
  isMonitoredSourceId,
  type BudgetedJobId,
  type FreshnessReport,
  type FreshnessRow,
  type FreshnessRowId,
  type FreshnessState,
  type FreshnessStatus,
  type HeartbeatJobId,
  type MonitoredFeedId,
  type MonitoredSourceId,
} from './freshness.js';
