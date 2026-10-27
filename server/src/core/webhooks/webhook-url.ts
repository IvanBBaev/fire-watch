/**
 * What a webhook endpoint URL may be (TASKS V2-G2): the SSRF guard's pure half.
 *
 * A webhook is the one place Fire Watch makes an HTTP request to a URL a stranger typed,
 * so the URL is treated as an attack on the network the server runs in until shown
 * otherwise. Two checks, both here and both pure:
 *
 *   1. {@link validateWebhookUrl} — at registration and again before every send: `https:`
 *      only, no credentials, no fragment, a port from the allow-list, a host that is a
 *      public DNS name or a public IP literal. Names that only resolve inside a network
 *      (`localhost`, `*.local`, `*.internal`, single labels …) are refused outright.
 *   2. {@link isPublicAddress} — applied by the transport to **every** address the host
 *      resolves to, immediately before the request. One private answer refuses the send:
 *      a name with a public and a private record is exactly the shape of a rebinding
 *      attack.
 *
 * Redirects are never followed (the transport sends with `redirect: 'error'`), so the only
 * host ever contacted is the one validated here.
 *
 * "Public" is decided by exclusion from the IANA special-purpose registries (RFC 6890 and
 * its updates) plus the cloud metadata addresses: loopback, private, CGNAT, link-local
 * (which holds 169.254.169.254), documentation, benchmarking, multicast, reserved, the
 * IPv6 unique-local block (which holds AWS's fd00:ec2::254), and every IPv6 form that
 * embeds an IPv4 address is judged by the address it embeds — or refused when it cannot
 * be (6to4, Teredo).
 *
 * Known limit, documented in docs/WEBHOOKS.md: the check and the connection resolve the
 * name separately, so a DNS server answering with a very short TTL can in principle swap
 * the answer between them. Plain `fetch` cannot be pinned to a resolved address; closing
 * that window needs a connect-time hook (an undici dispatcher) or an egress proxy.
 */

export type WebhookUrlRejection =
  | 'malformed'
  | 'too_long'
  | 'not_https'
  | 'credentials'
  | 'fragment'
  | 'port'
  | 'host'
  | 'private_address';

export interface ValidWebhookUrl {
  readonly ok: true;
  /** The normalised URL the endpoint is stored and called as. */
  readonly href: string;
  /** The hostname without brackets, lower-cased, without a trailing dot. */
  readonly host: string;
  /** True when the host is an IP literal, so there is nothing to resolve. */
  readonly ipLiteral: boolean;
}

export type WebhookUrlCheck =
  ValidWebhookUrl | { readonly ok: false; readonly reason: WebhookUrlRejection };

export interface WebhookUrlRules {
  readonly allowedPorts: readonly number[];
  readonly maxUrlLength: number;
}

/** Suffixes that name something inside a network, never on the public internet. */
const INTERNAL_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'localdomain',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
  'onion',
  'test',
  'invalid',
  'example',
] as const;

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function validateWebhookUrl(raw: string, rules: WebhookUrlRules): WebhookUrlCheck {
  if (raw.length > rules.maxUrlLength) return reject('too_long');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return reject('malformed');
  }
  if (url.protocol !== 'https:') return reject('not_https');
  if (url.username !== '' || url.password !== '') return reject('credentials');
  if (url.hash !== '' || raw.includes('#')) return reject('fragment');
  const port = url.port === '' ? 443 : Number(url.port);
  if (!rules.allowedPorts.includes(port)) return reject('port');

  const bracketed = url.hostname.startsWith('[') && url.hostname.endsWith(']');
  const host = (bracketed ? url.hostname.slice(1, -1) : url.hostname)
    .toLowerCase()
    .replace(/\.$/, '');
  if (host === '') return reject('host');

  if (bracketed || isIpv4Literal(host)) {
    return isPublicAddress(host)
      ? { ok: true, href: url.href, host, ipLiteral: true }
      : reject('private_address');
  }

  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL_RE.test(label))) return reject('host');
  // A numeric top-level label is an IP in disguise, never a public name.
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return reject('host');
  for (const suffix of INTERNAL_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return reject('host');
  }
  return { ok: true, href: url.href, host, ipLiteral: false };
}

/**
 * Whether every resolved address is public. An empty answer is not: the send has nowhere
 * safe to go.
 */
export function allAddressesPublic(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

/** Whether one textual IPv4 or IPv6 address is a public unicast address. */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) return isPublicIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6 !== null) return isPublicIpv6(v6);
  return false;
}

function reject(reason: WebhookUrlRejection): WebhookUrlCheck {
  return { ok: false, reason };
}

function isIpv4Literal(host: string): boolean {
  return parseIpv4(host) !== null;
}

/** Dotted-quad only; the WHATWG parser has already normalised hex and short forms to it. */
function parseIpv4(text: string): readonly number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** [prefix, bits] pairs, RFC 6890 and successors. */
const IPV4_NON_PUBLIC: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // private
  [100, 64, 0, 0, 10], // CGNAT shared address space
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, incl. the 169.254.169.254 metadata service
  [172, 16, 0, 0, 12], // private
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // TEST-NET-1
  [192, 31, 196, 0, 24], // AS112
  [192, 52, 193, 0, 24], // AMT
  [192, 88, 99, 0, 24], // deprecated 6to4 relay anycast
  [192, 168, 0, 0, 16], // private
  [192, 175, 48, 0, 24], // AS112 direct delegation
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // TEST-NET-2
  [203, 0, 113, 0, 24], // TEST-NET-3
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, incl. 255.255.255.255
];

function isPublicIpv4(octets: readonly number[]): boolean {
  const value = toUint32(octets);
  return !IPV4_NON_PUBLIC.some(([a, b, c, d, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (toUint32([a, b, c, d]) & mask) >>> 0;
  });
}

function toUint32(octets: readonly number[]): number {
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

/** Eight 16-bit groups, or null. Accepts `::` compression and a dotted IPv4 tail. */
function parseIpv6(input: string): readonly number[] | null {
  // A zone id (`fe80::1%en0`) only ever names a link-local address.
  const text = input.includes('%') ? null : input;
  if (text === null || text.length === 0 || text.length > 45) return null;
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (lastColon >= 0 && text.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
    head = text.slice(0, lastColon + 1);
    if (head.endsWith('::')) {
      // keep the compression marker
    } else if (head.endsWith(':')) {
      head = head.slice(0, -1);
    }
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const left = parseGroups(halves[0] ?? '');
  const right = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (left === null || right === null) return null;
  const explicit = left.length + right.length + tail.length;
  if (halves.length === 1) {
    return explicit === 8 ? [...left, ...tail] : null;
  }
  if (explicit > 7) return null;
  return [...left, ...new Array<number>(8 - explicit).fill(0), ...right, ...tail];
}

function isPublicIpv6(groups: readonly number[]): boolean {
  const g = (i: number): number => groups[i] ?? 0;
  const embeddedV4 = (): number[] => [g(6) >> 8, g(6) & 0xff, g(7) >> 8, g(7) & 0xff];
  const zeroUpTo = (n: number): boolean => groups.slice(0, n).every((x) => x === 0);

  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible, incl. :: and ::1).
  if (zeroUpTo(5) && g(5) === 0xffff) return isPublicIpv4(embeddedV4());
  if (zeroUpTo(6)) return false;
  // 64:ff9b::/96 well-known NAT64: judged by the IPv4 it reaches.
  if (g(0) === 0x64 && g(1) === 0xff9b && groups.slice(2, 6).every((x) => x === 0)) {
    return isPublicIpv4(embeddedV4());
  }
  // Only global unicast 2000::/3 can be public at all.
  if ((g(0) & 0xe000) !== 0x2000) return false;
  // 2001::/23 IETF protocol assignments, incl. Teredo 2001::/32 (embeds an obfuscated IPv4).
  if (g(0) === 0x2001 && g(1) < 0x0200) return false;
  // 2001:db8::/32 documentation; 3fff::/20 documentation (RFC 9637).
  if (g(0) === 0x2001 && g(1) === 0x0db8) return false;
  if (g(0) === 0x3fff && g(1) < 0x1000) return false;
  // 2002::/16 6to4: reaches whatever IPv4 it embeds through a relay; refused.
  if (g(0) === 0x2002) return false;
  return true;
}
