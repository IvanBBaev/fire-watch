/**
 * The security headers the web origin answers with (TASKS R5-SEC-2; review 28 E-2).
 *
 * One policy, served from two places that must not drift: Cloudflare Pages' `_headers`
 * file (`web/public/_headers`, copied into `web/dist` by the build) for every static
 * answer, and this module for the HTML a Pages Function renders — `_headers` does not reach
 * a Function's response, so `handleEventShell` adds them itself. The unit test next to this
 * file holds the file and the constant equal, and the e2e suite reads them off every route
 * of the table with a browser enforcing the policy.
 *
 * What the policy admits, and why:
 *
 *   * `default-src 'self'` — scripts, styles, fonts and frames are the app's own. The shell
 *     has no inline script or style, and the app never sets a `style` attribute or evaluates
 *     a string.
 *   * `img-src 'self' data: blob: …` — `blob:` for the images the client decodes itself
 *     (`URL.createObjectURL`); the basemap and GIBS hosts for tiles and satellite imagery.
 *   * `connect-src 'self' …` — the API is same-origin; the basemap host serves the style,
 *     tiles, glyphs and sprites MapLibre fetches; GIBS the before/after imagery.
 *   * `worker-src 'self'` — the MapLibre worker is served from this origin
 *     (`maplibreSharedModule`), never from a `blob:` URL.
 *   * `frame-ancestors 'self'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`
 *     — nothing embeds the app, nothing rebases its URLs, no plugin content.
 *
 * `Permissions-Policy: geolocation=(self)` keeps "My location" working for the app alone.
 *
 * Deploy-time addition: a deployment that advertises a T2 mirror on another host
 * (`static_snapshot_url` in `/api/v1/client-config`) must admit that origin, or the failover
 * fetch is refused by the browser. {@link deployAdmittedOrigins} reads that origin from
 * `FIRE_WATCH_STATIC_SNAPSHOT_URL`; the build rewrites `dist/_headers` with
 * {@link admitOriginsInHeadersFile} and the event-shell Function applies {@link admitOrigins}
 * (R5-SRE-5). `admitOrigins` is also how the e2e suite admits its loopback stand-in basemap.
 *
 * This module is runtime-neutral — it is bundled into the Pages Functions (whose tsconfig
 * knows no Node types) and imported by the e2e harness — so it uses only web globals.
 */

/** Where the basemap style, tiles, glyphs and sprites live (`DEFAULT_CONFIG.basemapStyleUrl`). */
const BASEMAP_ORIGIN = 'https://tiles.openfreemap.org';
/** NASA GIBS, the before/after satellite imagery (`core/before-after.ts`). */
const GIBS_ORIGIN = 'https://gibs.earthdata.nasa.gov';

export const WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `img-src 'self' data: blob: ${BASEMAP_ORIGIN} ${GIBS_ORIGIN}`,
  `connect-src 'self' ${BASEMAP_ORIGIN} ${GIBS_ORIGIN}`,
  "worker-src 'self'",
  "style-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Header names in lower case, as `Headers` and `_headers` parsing both normalise them. */
export const WEB_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': WEB_CONTENT_SECURITY_POLICY,
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(self)',
  'x-content-type-options': 'nosniff',
};

/** The CSP directives that name the hosts a page may fetch from. */
const SOURCE_DIRECTIVES: ReadonlySet<string> = new Set(['connect-src', 'img-src']);

/**
 * The same response with the security headers set — status, status text and body kept,
 * every other header kept, these written over whatever the upstream answer carried.
 */
export function withSecurityHeaders(
  response: Response,
  headers: Readonly<Record<string, string>> = WEB_SECURITY_HEADERS,
): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

/**
 * The same headers with `origins` admitted as fetch and image sources — appended to
 * `connect-src` and `img-src`, every other directive untouched.
 */
export function admitOrigins(
  headers: Readonly<Record<string, string>>,
  origins: readonly string[],
): Readonly<Record<string, string>> {
  const policy = headers['content-security-policy'];
  if (policy === undefined || origins.length === 0) return headers;
  const directives = policy
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '')
    .map((directive) => {
      const name = directive.split(/\s+/u, 1)[0] ?? '';
      return SOURCE_DIRECTIVES.has(name) ? [directive, ...origins].join(' ') : directive;
    });
  return { ...headers, 'content-security-policy': directives.join('; ') };
}

/**
 * The origins a deployment adds to the policy (R5-SRE-5; OPERATIONS §9.3 rule 7): the T2
 * mirror's origin when `FIRE_WATCH_STATIC_SNAPSHOT_URL` names one, nothing when it is unset
 * or blank. The build and the event-shell Function both read the same variable, so the
 * static answers and the Function's answers carry one policy. Anything but an absolute
 * `https:` URL is a misconfigured deploy and throws rather than ship a policy that blocks
 * the failover.
 */
export function deployAdmittedOrigins(staticSnapshotUrl: string | undefined): readonly string[] {
  const raw = staticSnapshotUrl?.trim();
  if (raw === undefined || raw === '') return [];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `FIRE_WATCH_STATIC_SNAPSHOT_URL is not an absolute URL: ${JSON.stringify(raw)}`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error(`FIRE_WATCH_STATIC_SNAPSHOT_URL must be https, got ${JSON.stringify(raw)}`);
  }
  return [url.origin];
}

/**
 * A `_headers` document with `origins` admitted in every `Content-Security-Policy` line, via
 * {@link admitOrigins}; every other line — comments, paths, other headers — byte for byte.
 */
export function admitOriginsInHeadersFile(text: string, origins: readonly string[]): string {
  if (origins.length === 0) return text;
  return text
    .split('\n')
    .map((line) => {
      const match = /^(\s+)(content-security-policy)(\s*:\s*)(.*)$/iu.exec(line);
      if (match === null) return line;
      const [, indent, name, separator, policy] = match;
      const admitted = admitOrigins({ 'content-security-policy': policy ?? '' }, origins);
      return `${indent}${name}${separator}${admitted['content-security-policy']}`;
    })
    .join('\n');
}

/** One rule of a Pages `_headers` file: a path pattern and the headers it sets. */
export interface HeadersRule {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A Cloudflare Pages `_headers` document as rules, for the gates that read the file: an
 * unindented line opens a rule for that path, each indented `Name: value` line below it
 * sets a header, `#` lines and blank lines are skipped. Names are lower-cased.
 */
export function parseHeadersFile(text: string): readonly HeadersRule[] {
  const rules: { path: string; headers: Record<string, string> }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/u.test(line)) {
      rules.push({ path: line.trim(), headers: {} });
      continue;
    }
    const rule = rules.at(-1);
    if (rule === undefined) throw new Error(`_headers: a header before any path: ${line}`);
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`_headers: not a header line: ${line}`);
    rule.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return rules;
}
