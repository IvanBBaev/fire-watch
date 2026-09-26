/**
 * SPF / DKIM / DMARC evaluation for the alert-sending domain and every defensive domain
 * (TASKS J5; OPERATIONS §11.5; security review 05 T17).
 *
 * The threat is not deliverability, it is impersonation: an attacker sending "evacuate
 * now" from a look-alike of our alert address during a real fire. DMARC `p=reject` on the
 * sending domain and on every domain we own is what makes a forged message bounce instead
 * of landing, and a record that is *almost* right (`p=quarantine`, `pct=50`, a second
 * `v=spf1` record, a revoked DKIM key) fails silently. So this module is strict and
 * says why.
 *
 * Pure: the caller resolves the names from {@link requiredLookups} and hands the answers
 * in. The only non-trivial dependency is `node:crypto`, used to read an RSA key's modulus
 * length — deterministic, no I/O.
 *
 * Scope, deliberately: the top-level record of each mechanism is checked, not the whole
 * `include:` tree (the 10-lookup count below is therefore a lower bound, and says so), and
 * the organizational domain is the last two labels unless overridden.
 */

import { createPublicKey } from 'node:crypto';

import { isSameOrSubdomain, organizationalDomain } from './domain-name.js';

/* -------------------------------------------------------------------------- */
/* DNS answers, as the adapter reduces them                                   */
/* -------------------------------------------------------------------------- */

/** `absent` is NXDOMAIN or NODATA — a real answer. `error` is "we could not find out". */
export type TxtLookup =
  | { readonly kind: 'records'; readonly records: readonly (readonly string[])[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly code: string };

export type MxLookup =
  | {
      readonly kind: 'records';
      readonly records: readonly { readonly exchange: string; readonly priority: number }[];
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly code: string };

export interface DnsAnswers {
  readonly txt: ReadonlyMap<string, TxtLookup>;
  readonly mx: ReadonlyMap<string, MxLookup>;
}

/* -------------------------------------------------------------------------- */
/* Options and report                                                         */
/* -------------------------------------------------------------------------- */

/** `sending` sends alert mail; `parked` must never send any (defensive domains). */
export const DOMAIN_ROLES = ['sending', 'parked'] as const;
export type DomainRole = (typeof DOMAIN_ROLES)[number];

export interface DkimSelector {
  readonly selector: string;
  /** The `d=` domain the signer uses; defaults to the checked domain. */
  readonly domain: string;
}

export interface EmailAuthOptions {
  /** The RFC 5322 From domain — e.g. the alert subdomain. Already normalized. */
  readonly domain: string;
  readonly role: DomainRole;
  readonly dkim: readonly DkimSelector[];
  /** The envelope MAIL FROM domain SPF is evaluated for; defaults to `domain`. */
  readonly mailFromDomain: string | null;
  readonly orgDomain: string | null;
  /** Require `adkim=s; aspf=s` and exact-match alignment. */
  readonly strictAlignment: boolean;
}

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
}

export interface EmailAuthReport {
  readonly domain: string;
  readonly role: DomainRole;
  readonly pass: boolean;
  readonly findings: readonly Finding[];
  readonly records: {
    readonly spf: { readonly name: string; readonly record: string | null };
    readonly dmarc: { readonly name: string; readonly record: string | null };
    readonly dkim: readonly {
      readonly name: string;
      readonly record: string | null;
    }[];
  };
}

export const SPF_LOOKUP_LIMIT = 10;
export const DKIM_RSA_MIN_BITS = 1024;
export const DKIM_RSA_RECOMMENDED_BITS = 2048;

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

export const dmarcName = (domain: string): string => `_dmarc.${domain}`;
export const dkimName = (s: DkimSelector): string => `${s.selector}._domainkey.${s.domain}`;
const spfDomain = (o: EmailAuthOptions): string => o.mailFromDomain ?? o.domain;

/** Every TXT and MX name the evaluation reads. */
export function requiredLookups(options: EmailAuthOptions): {
  readonly txt: readonly string[];
  readonly mx: readonly string[];
} {
  const txt = new Set<string>([spfDomain(options), dmarcName(options.domain)]);
  const org = organizationalDomain(options.domain, options.orgDomain);
  if (org !== options.domain) txt.add(dmarcName(org));
  for (const s of options.dkim) txt.add(dkimName(s));
  return { txt: [...txt], mx: options.role === 'parked' ? [options.domain] : [] };
}

/* -------------------------------------------------------------------------- */
/* Parsers                                                                    */
/* -------------------------------------------------------------------------- */

/** A TXT record's character-strings joined, as SPF (RFC 7208 §3.3) and DKIM require. */
export const joinTxt = (chunks: readonly string[]): string => chunks.join('');

/** `k=v; k=v` tag lists (DKIM, DMARC). Keys lower-cased; later duplicates are reported. */
export function parseTagList(record: string): {
  readonly tags: ReadonlyMap<string, string>;
  readonly duplicates: readonly string[];
  readonly order: readonly string[];
} {
  const tags = new Map<string, string>();
  const duplicates: string[] = [];
  const order: string[] = [];
  for (const part of record.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? '' : trimmed.slice(eq + 1).trim();
    if (tags.has(key)) duplicates.push(key);
    else tags.set(key, value);
    order.push(key);
  }
  return { tags, duplicates, order };
}

export const isSpfRecord = (record: string): boolean => /^v=spf1(\s|$)/i.test(record.trim());
export const isDmarcRecord = (record: string): boolean =>
  /^v\s*=\s*DMARC1\s*(;|$)/i.test(record.trim());

export interface SpfTerm {
  readonly qualifier: '+' | '-' | '~' | '?';
  readonly name: string;
  readonly value: string | null;
  readonly isModifier: boolean;
}

export function parseSpf(record: string): readonly SpfTerm[] {
  const terms = record.trim().split(/\s+/).slice(1);
  return terms.map((term) => {
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(term);
    if (modifier !== null) {
      return {
        qualifier: '+',
        name: (modifier[1] ?? '').toLowerCase(),
        value: modifier[2] ?? '',
        isModifier: true,
      };
    }
    const first = term.charAt(0);
    const qualifier =
      first === '+' || first === '-' || first === '~' || first === '?' ? first : '+';
    const body = qualifier === first ? term.slice(1) : term;
    const sep = body.search(/[:/]/);
    const name = (sep === -1 ? body : body.slice(0, sep)).toLowerCase();
    const value = sep === -1 ? null : body.slice(sep + (body.charAt(sep) === ':' ? 1 : 0));
    return { qualifier, name, value, isModifier: false };
  });
}

const SPF_LOOKUP_MECHANISMS = new Set(['include', 'a', 'mx', 'ptr', 'exists']);

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

class Findings {
  readonly list: Finding[] = [];
  error(code: string, message: string): void {
    this.list.push({ severity: 'error', code, message });
  }
  warn(code: string, message: string): void {
    this.list.push({ severity: 'warn', code, message });
  }
  info(code: string, message: string): void {
    this.list.push({ severity: 'info', code, message });
  }
}

function txtRecords(
  answers: DnsAnswers,
  name: string,
  f: Findings,
  what: string,
): readonly string[] | null {
  const lookup = answers.txt.get(name);
  if (lookup === undefined) {
    f.error('lookup_missing', `${what}: ${name} was not looked up (caller bug)`);
    return null;
  }
  if (lookup.kind === 'error') {
    f.error(
      'lookup_failed',
      `${what}: could not resolve ${name} (${lookup.code}) — result unknown`,
    );
    return null;
  }
  return lookup.kind === 'absent' ? [] : lookup.records.map(joinTxt);
}

function aligned(a: string, b: string, strict: boolean, orgOverride: string | null): boolean {
  if (strict) return a === b;
  return organizationalDomain(a, orgOverride) === organizationalDomain(b, orgOverride);
}

function evaluateSpf(options: EmailAuthOptions, answers: DnsAnswers, f: Findings): string | null {
  const name = spfDomain(options);
  const records = txtRecords(answers, name, f, 'SPF');
  if (records === null) return null;
  const spf = records.filter(isSpfRecord);
  if (spf.length === 0) {
    f.error(
      'spf_missing',
      options.role === 'parked'
        ? `SPF: no record at ${name}; a parked domain needs "v=spf1 -all"`
        : `SPF: no v=spf1 record at ${name}`,
    );
    return null;
  }
  if (spf.length > 1) {
    f.error('spf_multiple', `SPF: ${String(spf.length)} v=spf1 records at ${name} — a permerror`);
    return spf.join(' | ');
  }
  const record = spf[0] ?? '';
  const terms = parseSpf(record);
  const all = terms.find((t) => !t.isModifier && t.name === 'all');
  const redirect = terms.find((t) => t.isModifier && t.name === 'redirect');
  const lookups =
    terms.filter((t) => !t.isModifier && SPF_LOOKUP_MECHANISMS.has(t.name)).length +
    (redirect === undefined ? 0 : 1);
  if (lookups > SPF_LOOKUP_LIMIT) {
    f.error(
      'spf_too_many_lookups',
      `SPF: ${String(lookups)} DNS-querying terms at the top level (limit ${String(SPF_LOOKUP_LIMIT)})`,
    );
  } else if (lookups > 0) {
    f.info(
      'spf_lookups',
      `SPF: ${String(lookups)} DNS-querying terms at the top level; nested includes are not counted`,
    );
  }
  if (terms.some((t) => !t.isModifier && t.name === 'ptr')) {
    f.warn('spf_ptr', 'SPF: "ptr" is deprecated (RFC 7208 §5.5) and slow');
  }
  if (options.role === 'parked') {
    const others = terms.filter((t) => !(t.name === 'all' && !t.isModifier));
    if (all?.qualifier !== '-' || others.length > 0) {
      f.error('spf_parked_not_null', `SPF: a parked domain must publish exactly "v=spf1 -all"`);
    }
    return record;
  }
  if (all === undefined) {
    if (redirect === undefined) {
      f.error('spf_no_all', 'SPF: no "all" term and no redirect — unlisted senders are neutral');
    } else {
      f.info('spf_redirect', `SPF: policy delegated via redirect=${redirect.value ?? ''}`);
    }
  } else if (all.qualifier === '~') {
    f.warn(
      'spf_softfail',
      'SPF: "~all" (softfail); "-all" is stronger — DMARC p=reject carries the enforcement',
    );
  } else if (all.qualifier !== '-') {
    f.error('spf_permissive_all', `SPF: "${all.qualifier}all" lets any host pass SPF`);
  }
  if (!aligned(name, options.domain, options.strictAlignment, options.orgDomain)) {
    f.warn(
      'spf_not_aligned',
      `SPF: MAIL FROM ${name} is not ${options.strictAlignment ? 'strictly' : 'relaxed'}-aligned with ${options.domain}; DMARC must rely on DKIM`,
    );
  }
  return record;
}

function evaluateDmarc(
  options: EmailAuthOptions,
  answers: DnsAnswers,
  f: Findings,
): { name: string; record: string | null } {
  const own = dmarcName(options.domain);
  const org = organizationalDomain(options.domain, options.orgDomain);
  let name = own;
  let records = txtRecords(answers, own, f, 'DMARC');
  if (records === null) return { name, record: null };
  let inherited = false;
  if (records.filter(isDmarcRecord).length === 0 && org !== options.domain) {
    name = dmarcName(org);
    records = txtRecords(answers, name, f, 'DMARC');
    if (records === null) return { name, record: null };
    inherited = true;
  }
  const dmarc = records.filter(isDmarcRecord);
  if (dmarc.length === 0) {
    f.error(
      'dmarc_missing',
      `DMARC: no v=DMARC1 record at ${own}${inherited ? ` or ${name}` : ''}`,
    );
    return { name, record: null };
  }
  if (dmarc.length > 1) {
    f.error(
      'dmarc_multiple',
      `DMARC: ${String(dmarc.length)} records at ${name} — receivers ignore all of them`,
    );
    return { name, record: dmarc.join(' | ') };
  }
  const record = dmarc[0] ?? '';
  const { tags, duplicates, order } = parseTagList(record);
  if (order[0] !== 'v') f.error('dmarc_v_not_first', 'DMARC: "v=DMARC1" must be the first tag');
  for (const key of duplicates) f.error('dmarc_duplicate_tag', `DMARC: tag "${key}" appears twice`);
  const p = tags.get('p')?.toLowerCase();
  const sp = tags.get('sp')?.toLowerCase();
  if (p !== 'reject') {
    f.error('dmarc_not_reject', `DMARC: p=${p ?? '(missing)'} at ${name}; required p=reject`);
  }
  if (sp !== undefined && sp !== 'reject') {
    f.error('dmarc_sp_not_reject', `DMARC: sp=${sp} at ${name}; subdomains must be reject too`);
  }
  if (inherited) {
    f.info(
      'dmarc_inherited',
      `DMARC: ${options.domain} has no own record; ${name} applies (sp, else p)`,
    );
  }
  const pct = tags.get('pct');
  if (pct !== undefined && pct !== '100') {
    f.error(
      'dmarc_pct',
      `DMARC: pct=${pct} applies the policy to only part of the mail; remove it or set 100`,
    );
  }
  const rua = tags.get('rua');
  if (rua === undefined || rua.length === 0) {
    f.warn(
      'dmarc_no_rua',
      'DMARC: no rua= — nobody will see the aggregate reports of forgery attempts',
    );
  } else {
    for (const uri of rua.split(',').map((u) => u.trim())) {
      const target = /^mailto:[^@\s]+@([^!\s]+)/i.exec(uri);
      if (target === null) {
        f.warn('dmarc_rua_not_mailto', `DMARC: rua entry "${uri}" is not a mailto: URI`);
      } else if (!isSameOrSubdomain((target[1] ?? '').toLowerCase(), org)) {
        f.info(
          'dmarc_rua_external',
          `DMARC: rua goes to ${target[1] ?? ''}; it must publish ${org}._report._dmarc.${target[1] ?? ''}`,
        );
      }
    }
  }
  if (options.strictAlignment) {
    for (const tag of ['adkim', 'aspf'] as const) {
      if (tags.get(tag)?.toLowerCase() !== 's') {
        f.error(
          'dmarc_alignment_relaxed',
          `DMARC: ${tag}=${tags.get(tag) ?? 'r (default)'}; strict alignment requires ${tag}=s`,
        );
      }
    }
  }
  return { name, record };
}

/** Bits of an RSA SubjectPublicKeyInfo, or `null` when it does not parse. */
export function rsaKeyBits(base64: string): number | null {
  try {
    const key = createPublicKey({
      key: Buffer.from(base64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'rsa'
      ? (key.asymmetricKeyDetails?.modulusLength ?? null)
      : null;
  } catch {
    return null;
  }
}

function evaluateDkim(
  options: EmailAuthOptions,
  answers: DnsAnswers,
  f: Findings,
): { name: string; record: string | null }[] {
  if (options.role === 'sending' && options.dkim.length === 0) {
    f.error(
      'dkim_no_selector',
      'DKIM: no selector given (--dkim); DMARC for alert mail must not rest on SPF alone, which breaks on forwarding',
    );
  }
  return options.dkim.map((selector) => {
    const name = dkimName(selector);
    const records = txtRecords(answers, name, f, 'DKIM');
    if (records === null) return { name, record: null };
    const dkim = records.filter((r) => /(^|;)\s*p\s*=/i.test(r));
    if (dkim.length === 0) {
      f.error('dkim_missing', `DKIM: no key record at ${name}`);
      return { name, record: null };
    }
    if (dkim.length > 1)
      f.warn('dkim_multiple', `DKIM: ${String(dkim.length)} key records at ${name}`);
    const record = dkim[0] ?? '';
    const { tags } = parseTagList(record);
    const v = tags.get('v');
    if (v !== undefined && v !== 'DKIM1') f.error('dkim_bad_version', `DKIM: v=${v} at ${name}`);
    const k = (tags.get('k') ?? 'rsa').toLowerCase();
    const p = (tags.get('p') ?? '').replace(/\s+/g, '');
    if (p.length === 0) {
      f.error('dkim_revoked', `DKIM: empty p= at ${name} — the key is revoked`);
    } else if (k === 'rsa') {
      const bits = rsaKeyBits(p);
      if (bits === null) f.error('dkim_bad_key', `DKIM: p= at ${name} is not an RSA public key`);
      else if (bits < DKIM_RSA_MIN_BITS) {
        f.error(
          'dkim_weak_key',
          `DKIM: ${String(bits)}-bit RSA at ${name}; receivers reject below ${String(DKIM_RSA_MIN_BITS)}`,
        );
      } else if (bits < DKIM_RSA_RECOMMENDED_BITS) {
        f.warn(
          'dkim_short_key',
          `DKIM: ${String(bits)}-bit RSA at ${name}; ${String(DKIM_RSA_RECOMMENDED_BITS)} recommended`,
        );
      }
    } else if (k === 'ed25519') {
      if (Buffer.from(p, 'base64').length !== 32) {
        f.error('dkim_bad_key', `DKIM: p= at ${name} is not a 32-byte Ed25519 key`);
      }
    } else {
      f.error('dkim_unknown_key_type', `DKIM: k=${k} at ${name}`);
    }
    if (
      tags
        .get('t')
        ?.split(':')
        .map((s) => s.trim())
        .includes('y')
    ) {
      f.warn('dkim_testing', `DKIM: t=y at ${name} — receivers may treat signatures as unverified`);
    }
    if (!aligned(selector.domain, options.domain, options.strictAlignment, options.orgDomain)) {
      f.error(
        'dkim_not_aligned',
        `DKIM: d=${selector.domain} is not ${options.strictAlignment ? 'strictly' : 'relaxed'}-aligned with ${options.domain}`,
      );
    }
    return { name, record };
  });
}

function evaluateNullMx(options: EmailAuthOptions, answers: DnsAnswers, f: Findings): void {
  const mx = answers.mx.get(options.domain);
  if (mx === undefined) return;
  if (mx.kind === 'error') {
    f.warn('mx_lookup_failed', `MX: could not resolve ${options.domain} (${mx.code})`);
    return;
  }
  const isNull =
    mx.kind === 'records' &&
    mx.records.length === 1 &&
    (mx.records[0]?.exchange === '' || mx.records[0]?.exchange === '.');
  if (!isNull) {
    f.warn('mx_not_null', `MX: a parked domain should publish a null MX ("0 .", RFC 7505)`);
  }
}

export function evaluateEmailAuth(options: EmailAuthOptions, answers: DnsAnswers): EmailAuthReport {
  const f = new Findings();
  const spf = evaluateSpf(options, answers, f);
  const dmarc = evaluateDmarc(options, answers, f);
  const dkim = evaluateDkim(options, answers, f);
  if (options.role === 'parked') evaluateNullMx(options, answers, f);
  return {
    domain: options.domain,
    role: options.role,
    pass: !f.list.some((x) => x.severity === 'error'),
    findings: f.list,
    records: { spf: { name: spfDomain(options), record: spf }, dmarc, dkim },
  };
}
