/**
 * The `LightningClient` port over the EUMETSAT Data Store (TASKS F18; DATA-SOURCES §F18).
 *
 * Three endpoints, all on `api.eumetsat.int`:
 *
 * * **Search** — `GET /data/search-products/1.0.0/os?format=json&pi=EO:EUM:DAT:0691&…`,
 *   public: no token is sent, so a search never spends one.
 * * **Token** — `POST /token`, `grant_type=client_credentials` with HTTP Basic
 *   `key:secret` (OAuth2 client credentials). Cached until {@link TOKEN_EXPIRY_MARGIN_MS}
 *   before its stated expiry and asked for only by a download, so a cycle with nothing new
 *   is anonymous. A 401 on a download drops the cached token; the next cycle asks again.
 * * **Download** — the product's `sip-entries` link for the BODY netCDF file.
 *
 * Security decisions, each a line below:
 *
 * * **The bearer token only goes to the configured origin.** Download hrefs come from the
 *   search response; a search answer that pointed a BODY link at another host would
 *   otherwise be a way to collect our token. An href on any other origin is refused
 *   before a request is made.
 * * **Redirects are not followed** (`redirect: 'manual'`), for the same reason — `fetch`
 *   would forward the `Authorization` header to wherever a 302 pointed.
 * * **Bodies are capped while streaming**, not after: a search larger than
 *   {@link MAX_SEARCH_BYTES} or a BODY larger than {@link MAX_BODY_BYTES} is abandoned
 *   mid-read.
 * * **Errors are public-safe**: they name the status and an excerpt of the answer, never
 *   the token, the key or the secret.
 *
 * Value-style like the other upstream clients: nothing is thrown, and no retries — the
 * refresh job's next cycle is the retry.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { Clock } from '../../core/ports/clock.js';
import type {
  LightningClient,
  LightningDownload,
  LightningProduct,
  LightningSearch,
  LightningWindow,
} from '../../core/ports/lightning-client.js';

export const EUMETSAT_API_BASE_URL = 'https://api.eumetsat.int';
export const LFL_COLLECTION_ID = 'EO:EUM:DAT:0691';
export const LFL_PRODUCT_TYPE = 'MTILI2LFL';

export const EUMETSAT_TIMEOUT_MS = 60_000;
export const TOKEN_EXPIRY_MARGIN_MS = 30_000;

/** A page of 100 features is ~800 kB; anything past this is not a search answer. */
export const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
/** A BODY file is a few hundred kB; a storm season's busiest product is far below this. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;

/** Six hours of 10-minute products is 37; one page covers it with room. */
export const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 3;

const BODY_TITLE = /LI-2-LFL--FD--CHK-BODY--.*\.nc$/u;
const EXCERPT_CHARS = 200;

export interface EumetsatCredentials {
  readonly consumerKey: string;
  readonly consumerSecret: string;
}

export interface EumetsatDataStoreClientOptions {
  readonly credentials: EumetsatCredentials;
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so tests never open a socket. */
  readonly fetch?: typeof globalThis.fetch;
}

export function lflSearchUrl(baseUrl: string, window: LightningWindow, startIndex = 0): string {
  const url = new URL('/data/search-products/1.0.0/os', baseUrl);
  url.searchParams.set('format', 'json');
  url.searchParams.set('pi', LFL_COLLECTION_ID);
  url.searchParams.set('dtstart', window.startIso);
  url.searchParams.set('dtend', window.endIso);
  url.searchParams.set('c', String(SEARCH_PAGE_SIZE));
  url.searchParams.set('si', String(startIndex));
  return url.toString();
}

export function createEumetsatDataStoreClient(
  options: EumetsatDataStoreClientOptions,
): LightningClient {
  const baseUrl = options.baseUrl ?? EUMETSAT_API_BASE_URL;
  const origin = new URL(baseUrl).origin;
  const timeoutMs = options.timeoutMs ?? EUMETSAT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  /** Download hrefs by product id, from the most recent search. */
  const hrefs = new Map<string, string>();
  let token: { readonly value: string; readonly expiresAt: number } | null = null;

  async function getToken(): Promise<
    { ok: true; value: string } | { ok: false; status: number | null; error: string }
  > {
    const now = options.clock.now();
    if (token !== null && now < token.expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
      return { ok: true, value: token.value };
    }
    token = null;
    const basic = Buffer.from(
      `${options.credentials.consumerKey}:${options.credentials.consumerSecret}`,
    ).toString('base64');
    let response: Response;
    try {
      response = await doFetch(new URL('/token', baseUrl).toString(), {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (error) {
      return { ok: false, status: null, error: `token request failed: ${describe(error)}` };
    }
    const body = await readCapped(response, MAX_TOKEN_BYTES);
    if (response.status !== 200) {
      return {
        ok: false,
        status: response.status,
        error: `token endpoint returned ${String(response.status)}: ${excerpt(body)}`,
      };
    }
    if (body === null) return { ok: false, status: null, error: 'token answer over the cap' };
    const parsed = parseToken(body.toString('utf8'));
    if (parsed === null) return { ok: false, status: 200, error: 'token answer is malformed' };
    token = { value: parsed.accessToken, expiresAt: now + parsed.expiresInSeconds * 1000 };
    return { ok: true, value: parsed.accessToken };
  }

  return {
    async search(window: LightningWindow): Promise<LightningSearch> {
      const products: LightningProduct[] = [];
      for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
        let response: Response;
        try {
          response = await doFetch(lflSearchUrl(baseUrl, window, page * SEARCH_PAGE_SIZE), {
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'manual',
            headers: { accept: 'application/json' },
          });
        } catch (error) {
          return { ok: false, status: null, error: `search request failed: ${describe(error)}` };
        }
        const body = await readCapped(response, MAX_SEARCH_BYTES);
        if (response.status !== 200) {
          return {
            ok: false,
            status: response.status,
            error: `search returned ${String(response.status)}: ${excerpt(body)}`,
          };
        }
        if (body === null) return { ok: false, status: null, error: 'search answer over the cap' };
        const parsed = parseLflSearch(body.toString('utf8'));
        if (parsed === null) return { ok: false, status: 200, error: 'search answer is malformed' };
        for (const entry of parsed.products) {
          hrefs.set(entry.product.id, entry.href);
          products.push(entry.product);
        }
        const seen = page * SEARCH_PAGE_SIZE + parsed.returned;
        if (parsed.returned < SEARCH_PAGE_SIZE || seen >= parsed.total) break;
      }
      return { ok: true, products };
    },

    async downloadBody(product: LightningProduct): Promise<LightningDownload> {
      const href = hrefs.get(product.id);
      if (href === undefined) {
        return { ok: false, status: null, error: `no BODY link known for ${product.id}` };
      }
      if (!sameOrigin(href, origin)) {
        return { ok: false, status: null, error: 'BODY link is not on the configured origin' };
      }
      const auth = await getToken();
      if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
      let response: Response;
      try {
        response = await doFetch(href, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
          headers: { authorization: `Bearer ${auth.value}`, accept: 'application/x-netcdf' },
        });
      } catch (error) {
        return { ok: false, status: null, error: `download failed: ${describe(error)}` };
      }
      if (response.status !== 200) {
        const body = await readCapped(response, 4096);
        if (response.status === 401) token = null;
        return {
          ok: false,
          status: response.status,
          error: `download returned ${String(response.status)}: ${excerpt(body)}`,
        };
      }
      const bytes = await readCapped(response, MAX_BODY_BYTES);
      if (bytes === null) return { ok: false, status: null, error: 'BODY over the byte cap' };
      return {
        ok: true,
        bytes: new Uint8Array(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        availableAt: options.clock.now(),
      };
    },
  };
}

/** One search page → products with their BODY hrefs; `null` when it is not a search answer. */
export function parseLflSearch(text: string): {
  readonly total: number;
  readonly returned: number;
  readonly products: readonly { readonly product: LightningProduct; readonly href: string }[];
} | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw['features'])) return null;
  const features = raw['features'] as unknown[];
  const total = typeof raw['totalResults'] === 'number' ? raw['totalResults'] : features.length;
  const products: { product: LightningProduct; href: string }[] = [];
  for (const feature of features) {
    const entry = readFeature(feature);
    if (entry !== null) products.push(entry);
  }
  return { total, returned: features.length, products };
}

/** A feature that is not an LFL product with a BODY entry is skipped, not trusted. */
function readFeature(feature: unknown): { product: LightningProduct; href: string } | null {
  if (!isRecord(feature) || typeof feature['id'] !== 'string') return null;
  const properties = feature['properties'];
  if (!isRecord(properties)) return null;
  const info = properties['productInformation'];
  if (!isRecord(info) || info['productType'] !== LFL_PRODUCT_TYPE) return null;
  const date = properties['date'];
  if (typeof date !== 'string') return null;
  const [startIso, endIso] = date.split('/');
  if (startIso === undefined || endIso === undefined || !isUtc(startIso) || !isUtc(endIso)) {
    return null;
  }
  const links = properties['links'];
  if (!isRecord(links) || !Array.isArray(links['sip-entries'])) return null;
  let body: { href: string; title: string } | null = null;
  for (const link of links['sip-entries'] as unknown[]) {
    if (
      isRecord(link) &&
      typeof link['href'] === 'string' &&
      typeof link['title'] === 'string' &&
      link['mediaType'] === 'application/x-netcdf' &&
      BODY_TITLE.test(link['title'])
    ) {
      body = { href: link['href'], title: link['title'] };
      break;
    }
  }
  if (body === null) return null;
  const extra = properties['extraInformation'];
  const md5 = isRecord(extra) && typeof extra['md5'] === 'string' ? extra['md5'] : null;
  const updated = properties['updated'];
  return {
    product: {
      id: feature['id'],
      window: { startIso, endIso },
      publishedAtIso: typeof updated === 'string' && isUtc(updated) ? updated : null,
      md5: md5 !== null && /^[0-9a-f]{32}$/u.test(md5) ? md5 : null,
      bodyName: body.title,
    },
    href: body.href,
  };
}

export function parseToken(text: string): { accessToken: string; expiresInSeconds: number } | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isRecord(raw)) return null;
    const accessToken = raw['access_token'];
    const expiresIn = raw['expires_in'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    if (/[\s]/u.test(accessToken)) return null;
    const seconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 0;
    return { accessToken, expiresInSeconds: seconds };
  } catch {
    return null;
  }
}

function sameOrigin(href: string, origin: string): boolean {
  try {
    const url = new URL(href);
    return url.origin === origin && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** The body, or `null` once it passes `cap` bytes (the read is abandoned there). */
async function readCapped(response: Response, cap: number): Promise<Buffer | null> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function isUtc(value: string): boolean {
  return UTC.test(value) && Number.isFinite(Date.parse(value));
}

function excerpt(body: Buffer | null): string {
  if (body === null) return '(body over the cap)';
  const flat = body.toString('utf8').replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
