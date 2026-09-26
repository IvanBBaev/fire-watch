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
  SNAPSHOT_PUSH_WARN_SECONDS,
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

export {
  CREDITS,
  CREDIT_SURFACE_OWNER,
  MAP_CORNER_LINE,
  PRODUCT_PLACEHOLDER,
  YEAR_PLACEHOLDER,
  assertableCredits,
  assertedText,
  attributionGaps,
  creditsFor,
  ecmwfComponents,
  renderCredit,
  renderMapCornerLine,
  type AttributionGap,
  type Credit,
  type CreditCondition,
  type CreditSurface,
  type CreditSurfaceOwner,
  type CreditSurfacesOf,
  type RenderContext,
  type RenderedAttribution,
} from './credits.js';

export {
  CLIENT_POLL_INTERVAL_MAX_MS,
  CLIENT_POLL_INTERVAL_MIN_MS,
  CLIENT_TRANSPORTS,
  IMAGERY_API_KEY_MAX_LENGTH,
  IMAGERY_TILE_PLACEHOLDERS,
  isClientImageryBlock,
  isClientTransport,
  isImageryApiKey,
  isImageryTileUrlTemplate,
  type ClientConfigDocument,
  type ClientImageryBlock,
  type ClientTransport,
} from './client-config.js';

export {
  ALERT_VOICES,
  FOOTER_REQUIREMENTS,
  FOOTER_RULE_IDS,
  FROZEN_HONEST_COPY,
  NEVER_SEND_RULES,
  NEVER_SEND_RULE_IDS,
  NeverSendError,
  RULE_EXEMPTIONS,
  assertSendable,
  lintAlert,
  lintAlertFooter,
  lintAlertText,
  type AlertLintRuleId,
  type AlertVoice,
  type FooterRequirement,
  type FooterRuleId,
  type LintableAlert,
  type NeverSendContext,
  type NeverSendRule,
  type NeverSendRuleId,
  type NeverSendViolation,
  type QuotedSource,
  type RuleExemption,
} from './never-send.js';

export {
  PROBLEM_CODES,
  PROBLEM_CODE_MEMBER,
  isProblemCode,
  type ProblemCode,
} from './problem-codes.js';
