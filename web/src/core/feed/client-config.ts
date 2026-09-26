/**
 * The fleet-control read (ADR-003 D1 "server-side transport control", A1.1, A1.2): one
 * tiny cached document at `/api/v1/client-config` lets ops turn the stream off or stretch
 * the poll interval for everyone without a deploy. Only three fields matter to the
 * transport layer, and every one is optional: whatever the document does not say, or says
 * in a shape this reader does not understand, keeps its build-time value. The build-time
 * value is by design what survives client-config being unreachable (A1.2) — so this never
 * throws and never returns less than the defaults it was given.
 *
 * The full document (E4) will carry more — imagery handles (ADR-001 A2.3), demotion
 * flags — and those belong to their own readers; this one is deliberately blind to them.
 */

import type { ClientConfig } from '../config.js';

/** The transport fields ops can move at run time. `transport: 'poll'` is A1.1's demotion. */
export interface ClientConfigOverrides {
  readonly transport?: 'poll' | 'sse';
  readonly pollIntervalMs?: number;
  readonly staticSnapshotUrl?: string | null;
}

const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 30 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Field-by-field lenient read: a field that is absent or malformed is simply not an
 * override. Strictness here would turn one typo in an ops document into a fleet-wide
 * loss of the whole document, which is the opposite of what a control surface is for.
 */
export function parseClientConfig(value: unknown): ClientConfigOverrides {
  if (!isRecord(value)) return {};
  const out: { -readonly [K in keyof ClientConfigOverrides]: ClientConfigOverrides[K] } = {};

  const transport = value['transport'];
  if (transport === 'poll' || transport === 'sse') out.transport = transport;

  const interval = value['poll_interval_ms'];
  if (
    typeof interval === 'number' &&
    Number.isFinite(interval) &&
    interval >= MIN_POLL_INTERVAL_MS &&
    interval <= MAX_POLL_INTERVAL_MS
  ) {
    out.pollIntervalMs = Math.round(interval);
  }

  const staticUrl = value['static_snapshot_url'];
  if (staticUrl === null) out.staticSnapshotUrl = null;
  else if (typeof staticUrl === 'string' && staticUrl.length > 0) out.staticSnapshotUrl = staticUrl;

  return out;
}

export function applyClientConfig(
  defaults: ClientConfig,
  overrides: ClientConfigOverrides,
): ClientConfig {
  return {
    ...defaults,
    ...(overrides.transport !== undefined && { sseEnabled: overrides.transport === 'sse' }),
    ...(overrides.pollIntervalMs !== undefined && { pollIntervalMs: overrides.pollIntervalMs }),
    ...(overrides.staticSnapshotUrl !== undefined && {
      staticSnapshotUrl: overrides.staticSnapshotUrl,
    }),
  };
}

/**
 * Fetch and merge, or return the defaults untouched. Any failure — network, non-2xx, a
 * body that is not JSON — is the "client-config unreachable" case A1.2 provides for, and
 * it is not an error the user can act on, so nothing is surfaced.
 */
export async function fetchClientConfig(
  fetchFn: typeof fetch,
  defaults: ClientConfig,
): Promise<ClientConfig> {
  try {
    const response = await fetchFn(defaults.clientConfigUrl, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return defaults;
    const body: unknown = await response.json();
    return applyClientConfig(defaults, parseClientConfig(body));
  } catch {
    return defaults;
  }
}
