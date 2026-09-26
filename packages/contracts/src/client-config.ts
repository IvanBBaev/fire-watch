/**
 * The fleet-control document — `GET /api/v1/client-config` (ADR-003 D1 "server-side
 * transport control", A1.1, A1.2; 04 §5.2.3).
 *
 * One tiny, edge-cached (30 s) JSON document that every client reads on boot and re-reads
 * on a cadence, and that ops can move without a client release: which transport the
 * fleet should use, how often to poll, and where the static copy of the snapshot lives.
 * The server writes it, the web client reads it, and the field names are the wire
 * contract — snake_case, as every JSON body under `/api/v1` (A1.3).
 *
 * The client's reader is lenient by design (a field it does not understand keeps its
 * build-time value), so the three transport members are not optional *on the wire*: the
 * server always emits them, and a `null` static URL means "there is no static copy", not
 * "unknown".
 *
 * The one optional member is `imagery` (ADR-001 A1.3 as amended by A2.3), and its absence
 * is the message: the block exists only while the imagery toggle is enabled, and it carries
 * the handles without which a client cannot request an Esri tile at all. It was added after
 * the first clients shipped, and it is additive in both directions — a client that predates
 * it ignores a member it does not read, and a document without it is exactly the document
 * those clients were built against.
 */

export const CLIENT_TRANSPORTS = ['poll', 'sse'] as const;

/**
 * `poll` is T1 for everyone — A1.1's demotion and the CI-7 posture alike. `sse` means the
 * server is *offering* T0; whether a given client takes it is the client supervisor's call.
 */
export type ClientTransport = (typeof CLIENT_TRANSPORTS)[number];

export function isClientTransport(value: unknown): value is ClientTransport {
  return typeof value === 'string' && (CLIENT_TRANSPORTS as readonly string[]).includes(value);
}

/**
 * The bounds the client's reader accepts for `poll_interval_ms`; a value outside them is
 * ignored on the client, so the server refuses to be configured with one (a fleet that
 * silently keeps its build-time cadence is the failure a control surface exists to avoid).
 * The floor keeps the fleet from being turned into a load test by a typo; the ceiling
 * keeps a poll from outliving every freshness budget.
 */
export const CLIENT_POLL_INTERVAL_MIN_MS = 5_000;
export const CLIENT_POLL_INTERVAL_MAX_MS = 30 * 60_000;

/**
 * The imagery block (ADR-001 A2.3): present only while the server says the toggle is
 * enabled, so a client needs no quota logic of its own — no block, no key, no toggle.
 *
 * Both members are public by design. The key is an ArcGIS Location Platform *client* key
 * (A1.3: "API key, metered"); it is meant to ride to browsers and is restricted to this
 * product's referrers at the provider, not kept secret. The imagery itself is never
 * proxied or cached by us (A1.3), which is why the block hands out a provider URL rather
 * than a path on our own origin.
 */
export interface ClientImageryBlock {
  /**
   * An `https:` raster tile URL template carrying `{z}`, `{x}` and `{y}`, without the key:
   * the client adds the key as the `token` query parameter.
   */
  readonly tile_url_template: string;
  /** The client key, URL-safe characters only, so appending it cannot rewrite the URL. */
  readonly api_key: string;
}

export interface ClientConfigDocument {
  readonly transport: ClientTransport;
  /** Integer ms, within the bounds above. */
  readonly poll_interval_ms: number;
  /** The public CDN URL of the static snapshot copy (A1.2), or `null` when there is none. */
  readonly static_snapshot_url: string | null;
  /** A2.3: present only while imagery is enabled; absent means "no toggle". */
  readonly imagery?: ClientImageryBlock;
}

/** The three placeholders a tile template must carry for a raster source to be addressable. */
export const IMAGERY_TILE_PLACEHOLDERS = ['{z}', '{x}', '{y}'] as const;

/** An upper bound, not a format: long enough for any provider key, short enough to refuse junk. */
export const IMAGERY_API_KEY_MAX_LENGTH = 512;

const URL_SAFE_KEY = /^[A-Za-z0-9._~-]+$/;

/**
 * Whether a tile template is one the client can use as-is: `https:` (a mixed-content
 * template would fail in every browser that loads the app over TLS), every placeholder
 * present, no fragment, and no `token` of its own — the key travels in `api_key`, so a
 * template that already carries one is a configuration mistake worth refusing.
 */
export function isImageryTileUrlTemplate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!IMAGERY_TILE_PLACEHOLDERS.every((placeholder) => value.includes(placeholder))) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value.replaceAll('{', '').replaceAll('}', ''));
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hash === '' && !url.searchParams.has('token');
}

export function isImageryApiKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= IMAGERY_API_KEY_MAX_LENGTH &&
    URL_SAFE_KEY.test(value)
  );
}

/**
 * The one validation both ends share: the server refuses to start with a block that fails
 * it, and the client treats a block that fails it as absent — no toggle rather than a
 * toggle that requests broken tiles.
 */
export function isClientImageryBlock(value: unknown): value is ClientImageryBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  return isImageryTileUrlTemplate(block['tile_url_template']) && isImageryApiKey(block['api_key']);
}
