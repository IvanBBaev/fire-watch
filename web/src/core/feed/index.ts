/**
 * The feed layer's public surface: the wire guards, the server-time tracker, the two
 * transports behind `DataFeedPort` (T1 polling, T0 stream), the transport supervisor, the
 * coordinator that wires them to the store, and the fleet-control read. Consumers import
 * from here; the module files behind it are free to reshape.
 */

export { ParseError, parseSnapshot } from './parse-snapshot.js';
export { createServerTimeTracker, type ServerTimeTracker } from './server-time.js';
export { STREAM_FRAME_NAMES, parseStreamFrame, type StreamFrame } from './stream-frames.js';
export {
  createPollingFeed,
  parseFreshnessReport,
  type PollingFeed,
  type PollingFeedOptions,
} from './polling-feed.js';
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  createSseFeed,
  type SseFeed,
  type SseFeedOptions,
} from './sse-feed.js';
export {
  INITIAL_SUPERVISOR_SNAPSHOT,
  STATIC_FLIP_SPAN_INTERVALS,
  STATIC_FLIP_STREAK,
  createTransportSupervisor,
  reduceSupervisor,
  type SupervisorConfig,
  type SupervisorEffect,
  type SupervisorInput,
  type SupervisorSnapshot,
  type TransportSupervisor,
} from './supervisor.js';
export {
  createFeedCoordinator,
  type CoordinatedPolling,
  type CoordinatedStream,
  type FeedCoordinator,
  type FeedCoordinatorDeps,
} from './feed-coordinator.js';
export {
  applyClientConfig,
  fetchClientConfig,
  parseClientConfig,
  type ClientConfigOverrides,
} from './client-config.js';
