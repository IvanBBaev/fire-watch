import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  evaluateEmailAuth,
  parseSpf,
  parseTagList,
  requiredLookups,
  rsaKeyBits,
  type DnsAnswers,
  type EmailAuthOptions,
  type MxLookup,
  type TxtLookup,
} from './email-auth.js';

const rsaKey = (bits: number): string =>
  generateKeyPairSync('rsa', { modulusLength: bits })
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');

// Generated once: RSA key generation is the slow part of this file.
const KEY_2048 = rsaKey(2048);
const KEY_1024 = rsaKey(1024);
const KEY_512 = rsaKey(512);

const DOMAIN = 'alerts.example.bg';

const sending = (overrides: Partial<EmailAuthOptions> = {}): EmailAuthOptions => ({
  domain: DOMAIN,
  role: 'sending',
  dkim: [{ selector: 's1', domain: DOMAIN }],
  mailFromDomain: null,
  orgDomain: null,
  strictAlignment: false,
  ...overrides,
});

const parked = (domain = 'firewatch.eu'): EmailAuthOptions => ({
  domain,
  role: 'parked',
  dkim: [],
  mailFromDomain: null,
  orgDomain: null,
  strictAlignment: false,
});

const txt = (...records: string[]): TxtLookup => ({
  kind: 'records',
  records: records.map((r) => [r]),
});
const ABSENT: TxtLookup = { kind: 'absent' };

const GOOD_DMARC = 'v=DMARC1; p=reject; sp=reject; rua=mailto:dmarc@example.bg';

function answers(
  entries: Record<string, TxtLookup>,
  mx: Record<string, MxLookup> = {},
): DnsAnswers {
  return { txt: new Map(Object.entries(entries)), mx: new Map(Object.entries(mx)) };
}

const goodSending = (overrides: Record<string, TxtLookup> = {}): DnsAnswers =>
  answers({
    [DOMAIN]: txt('v=spf1 include:amazonses.com -all'),
    [`_dmarc.${DOMAIN}`]: txt(GOOD_DMARC),
    [`s1._domainkey.${DOMAIN}`]: txt(`v=DKIM1; k=rsa; p=${KEY_2048}`),
    '_dmarc.example.bg': ABSENT,
    ...overrides,
  });

const codes = (options: EmailAuthOptions, a: DnsAnswers): string[] =>
  evaluateEmailAuth(options, a).findings.map((f) => f.code);

const errorCodes = (options: EmailAuthOptions, a: DnsAnswers): string[] =>
  evaluateEmailAuth(options, a)
    .findings.filter((f) => f.severity === 'error')
    .map((f) => f.code);

describe('parsers', () => {
  it('reads tag lists, lower-casing keys and reporting duplicates', () => {
    const { tags, duplicates, order } = parseTagList('v=DMARC1; P=reject ; p=none;');
    expect(tags.get('p')).toBe('reject');
    expect(duplicates).toEqual(['p']);
    expect(order).toEqual(['v', 'p', 'p']);
  });

  it('reads SPF terms with qualifiers and modifiers', () => {
    const terms = parseSpf('v=spf1 ip4:192.0.2.1 ~all redirect=_spf.example.bg');
    expect(terms.map((t) => [t.qualifier, t.name, t.isModifier])).toEqual([
      ['+', 'ip4', false],
      ['~', 'all', false],
      ['+', 'redirect', true],
    ]);
  });

  it('measures RSA keys and refuses anything else', () => {
    expect(rsaKeyBits(KEY_2048)).toBe(2048);
    expect(rsaKeyBits(KEY_1024)).toBe(1024);
    expect(rsaKeyBits('bm90IGEga2V5')).toBeNull();
    const ed = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64');
    expect(rsaKeyBits(ed)).toBeNull();
  });
});

describe('requiredLookups', () => {
  it('asks for SPF, own and organizational DMARC and every selector', () => {
    expect(requiredLookups(sending({ mailFromDomain: 'bounce.example.bg' }))).toEqual({
      txt: [
        'bounce.example.bg',
        `_dmarc.${DOMAIN}`,
        '_dmarc.example.bg',
        `s1._domainkey.${DOMAIN}`,
      ],
      mx: [],
    });
  });

  it('asks for MX only on a parked domain, and no org DMARC at the apex', () => {
    expect(requiredLookups(parked())).toEqual({
      txt: ['firewatch.eu', '_dmarc.firewatch.eu'],
      mx: ['firewatch.eu'],
    });
  });
});

describe('evaluateEmailAuth — sending domain', () => {
  it('passes a correct setup, reporting only informational notes', () => {
    const report = evaluateEmailAuth(sending(), goodSending());
    expect(report.pass).toBe(true);
    expect(report.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    expect(report.records.dmarc).toEqual({ name: `_dmarc.${DOMAIN}`, record: GOOD_DMARC });
    expect(report.records.dkim[0]?.record).toContain('v=DKIM1');
  });

  it.each([
    ['p=quarantine', 'v=DMARC1; p=quarantine; rua=mailto:d@example.bg', 'dmarc_not_reject'],
    ['p=none', 'v=DMARC1; p=none; rua=mailto:d@example.bg', 'dmarc_not_reject'],
    ['sp=none', 'v=DMARC1; p=reject; sp=none; rua=mailto:d@example.bg', 'dmarc_sp_not_reject'],
    ['pct=50', 'v=DMARC1; p=reject; pct=50; rua=mailto:d@example.bg', 'dmarc_pct'],
    // RFC 7489 §6.6.3: a record not starting with v=DMARC1 is discarded, so it counts as none.
    ['v not first', 'p=reject; v=DMARC1; rua=mailto:d@example.bg', 'dmarc_missing'],
    ['a duplicate p', 'v=DMARC1; p=reject; p=none; rua=mailto:d@example.bg', 'dmarc_duplicate_tag'],
  ])('fails DMARC with %s', (_label, record, code) => {
    expect(errorCodes(sending(), goodSending({ [`_dmarc.${DOMAIN}`]: txt(record) }))).toContain(
      code,
    );
  });

  it('fails on two DMARC records and on none', () => {
    expect(
      errorCodes(sending(), goodSending({ [`_dmarc.${DOMAIN}`]: txt(GOOD_DMARC, GOOD_DMARC) })),
    ).toContain('dmarc_multiple');
    expect(
      errorCodes(sending(), goodSending({ [`_dmarc.${DOMAIN}`]: txt('unrelated') })),
    ).toContain('dmarc_missing');
  });

  it('inherits the organizational policy and says so', () => {
    const a = goodSending({ [`_dmarc.${DOMAIN}`]: ABSENT, '_dmarc.example.bg': txt(GOOD_DMARC) });
    const report = evaluateEmailAuth(sending(), a);
    expect(report.pass).toBe(true);
    expect(report.records.dmarc.name).toBe('_dmarc.example.bg');
    expect(report.findings.map((f) => f.code)).toContain('dmarc_inherited');
  });

  it('warns about reporting gaps without failing', () => {
    const noRua = goodSending({ [`_dmarc.${DOMAIN}`]: txt('v=DMARC1; p=reject') });
    expect(evaluateEmailAuth(sending(), noRua).pass).toBe(true);
    expect(codes(sending(), noRua)).toContain('dmarc_no_rua');
    const https = goodSending({
      [`_dmarc.${DOMAIN}`]: txt('v=DMARC1; p=reject; rua=https://example.bg/r'),
    });
    expect(codes(sending(), https)).toContain('dmarc_rua_not_mailto');
    const external = goodSending({
      [`_dmarc.${DOMAIN}`]: txt('v=DMARC1; p=reject; rua=mailto:x@reports.vendor.example'),
    });
    expect(codes(sending(), external)).toContain('dmarc_rua_external');
  });

  it('requires adkim=s and aspf=s in strict mode', () => {
    const strict = sending({ strictAlignment: true });
    expect(errorCodes(strict, goodSending())).toEqual([
      'dmarc_alignment_relaxed',
      'dmarc_alignment_relaxed',
    ]);
    const ok = goodSending({
      [`_dmarc.${DOMAIN}`]: txt(`${GOOD_DMARC}; adkim=s; aspf=s`),
    });
    expect(errorCodes(strict, ok)).toEqual([]);
  });

  it.each([
    ['no record', ABSENT, 'spf_missing'],
    ['two records', txt('v=spf1 -all', 'v=spf1 ~all'), 'spf_multiple'],
    ['+all', txt('v=spf1 +all'), 'spf_permissive_all'],
    ['?all', txt('v=spf1 include:x.example ?all'), 'spf_permissive_all'],
    ['no all', txt('v=spf1 include:x.example'), 'spf_no_all'],
    [
      'eleven lookups',
      txt(
        `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:i${String(i)}.example`).join(' ')} -all`,
      ),
      'spf_too_many_lookups',
    ],
  ])('fails SPF with %s', (_label, lookup, code) => {
    expect(errorCodes(sending(), goodSending({ [DOMAIN]: lookup }))).toContain(code);
  });

  it('only warns on ~all and ptr, and accepts a redirect', () => {
    const soft = goodSending({ [DOMAIN]: txt('v=spf1 ptr ~all') });
    expect(evaluateEmailAuth(sending(), soft).pass).toBe(true);
    expect(codes(sending(), soft)).toEqual(expect.arrayContaining(['spf_softfail', 'spf_ptr']));
    const redirect = goodSending({ [DOMAIN]: txt('v=spf1 redirect=_spf.example.bg') });
    expect(codes(sending(), redirect)).toContain('spf_redirect');
    expect(evaluateEmailAuth(sending(), redirect).pass).toBe(true);
  });

  it('joins split TXT strings before parsing', () => {
    const split = goodSending({
      [DOMAIN]: { kind: 'records', records: [['v=spf1 inc', 'lude:x.example -all']] },
    });
    expect(evaluateEmailAuth(sending(), split).records.spf.record).toBe(
      'v=spf1 include:x.example -all',
    );
  });

  it('checks SPF alignment of a separate MAIL FROM domain', () => {
    const options = sending({ mailFromDomain: 'bounce.other.example' });
    const a = goodSending({ 'bounce.other.example': txt('v=spf1 -all') });
    expect(codes(options, a)).toContain('spf_not_aligned');
    const aligned = sending({ mailFromDomain: 'bounce.example.bg' });
    expect(codes(aligned, goodSending({ 'bounce.example.bg': txt('v=spf1 -all') }))).not.toContain(
      'spf_not_aligned',
    );
  });

  it.each([
    ['no selector configured', sending({ dkim: [] }), goodSending(), 'dkim_no_selector'],
    [
      'a missing key record',
      sending(),
      goodSending({ [`s1._domainkey.${DOMAIN}`]: ABSENT }),
      'dkim_missing',
    ],
    [
      'a revoked key',
      sending(),
      goodSending({ [`s1._domainkey.${DOMAIN}`]: txt('v=DKIM1; p=') }),
      'dkim_revoked',
    ],
    [
      'a 512-bit key',
      sending(),
      goodSending({ [`s1._domainkey.${DOMAIN}`]: txt(`v=DKIM1; p=${KEY_512}`) }),
      'dkim_weak_key',
    ],
    [
      'garbage key data',
      sending(),
      goodSending({ [`s1._domainkey.${DOMAIN}`]: txt('v=DKIM1; p=Zm9v') }),
      'dkim_bad_key',
    ],
    [
      'a bad version',
      sending(),
      goodSending({ [`s1._domainkey.${DOMAIN}`]: txt(`v=DKIM2; p=${KEY_2048}`) }),
      'dkim_bad_version',
    ],
    [
      'an unknown key type',
      sending(),
      goodSending({ [`s1._domainkey.${DOMAIN}`]: txt(`k=dsa; p=${KEY_2048}`) }),
      'dkim_unknown_key_type',
    ],
    [
      'an unaligned d=',
      sending({ dkim: [{ selector: 's1', domain: 'vendor.example' }] }),
      goodSending({ 's1._domainkey.vendor.example': txt(`v=DKIM1; p=${KEY_2048}`) }),
      'dkim_not_aligned',
    ],
  ])('fails DKIM with %s', (_label, options, a, code) => {
    expect(errorCodes(options, a)).toContain(code);
  });

  it('only warns on a 1024-bit key and on t=y', () => {
    const a = goodSending({ [`s1._domainkey.${DOMAIN}`]: txt(`v=DKIM1; t=y; p=${KEY_1024}`) });
    expect(evaluateEmailAuth(sending(), a).pass).toBe(true);
    expect(codes(sending(), a)).toEqual(expect.arrayContaining(['dkim_short_key', 'dkim_testing']));
  });

  it('accepts a 32-byte Ed25519 key', () => {
    const raw = Buffer.alloc(32, 7).toString('base64');
    const a = goodSending({ [`s1._domainkey.${DOMAIN}`]: txt(`v=DKIM1; k=ed25519; p=${raw}`) });
    expect(errorCodes(sending(), a)).toEqual([]);
  });

  it('never passes on a lookup failure — unknown is not absent', () => {
    const a = goodSending({ [`_dmarc.${DOMAIN}`]: { kind: 'error', code: 'ETIMEOUT' } });
    const report = evaluateEmailAuth(sending(), a);
    expect(report.pass).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('lookup_failed');
    expect(report.findings.map((f) => f.code)).not.toContain('dmarc_missing');
  });

  it('flags a name the caller forgot to resolve', () => {
    expect(errorCodes(sending(), answers({}))).toContain('lookup_missing');
  });
});

describe('evaluateEmailAuth — parked domain', () => {
  const nullMx: MxLookup = { kind: 'records', records: [{ exchange: '', priority: 0 }] };
  const goodParked = (overrides: Record<string, TxtLookup> = {}, mx: MxLookup = nullMx) =>
    answers(
      {
        'firewatch.eu': txt('v=spf1 -all'),
        '_dmarc.firewatch.eu': txt(
          'v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; rua=mailto:d@example.bg',
        ),
        ...overrides,
      },
      { 'firewatch.eu': mx },
    );

  it('passes the null-sender posture without asking for DKIM', () => {
    const report = evaluateEmailAuth(parked(), goodParked());
    expect(report.pass).toBe(true);
    expect(report.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('requires exactly "v=spf1 -all"', () => {
    expect(
      errorCodes(parked(), goodParked({ 'firewatch.eu': txt('v=spf1 include:x.example -all') })),
    ).toContain('spf_parked_not_null');
    expect(errorCodes(parked(), goodParked({ 'firewatch.eu': txt('v=spf1 ~all') }))).toContain(
      'spf_parked_not_null',
    );
  });

  it('still requires p=reject', () => {
    expect(
      errorCodes(parked(), goodParked({ '_dmarc.firewatch.eu': txt('v=DMARC1; p=none') })),
    ).toContain('dmarc_not_reject');
  });

  it('warns when MX is not a null MX', () => {
    const mx: MxLookup = { kind: 'records', records: [{ exchange: 'mx.example', priority: 10 }] };
    expect(codes(parked(), goodParked({}, mx))).toContain('mx_not_null');
    expect(codes(parked(), goodParked({}, { kind: 'absent' }))).toContain('mx_not_null');
    expect(codes(parked(), goodParked({}, { kind: 'error', code: 'ESERVFAIL' }))).toContain(
      'mx_lookup_failed',
    );
  });
});
