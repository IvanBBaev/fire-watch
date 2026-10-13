/**
 * The SNS signature gate, against messages this test signs itself.
 *
 * There is no fixture certificate in the tree: CI's secret-shape gate refuses any
 * committed private key, and a real SNS certificate is useless without SNS's key. So the
 * test generates an RSA pair and wraps the public half in a minimal self-signed X.509 v1
 * certificate, DER-encoded by hand below — node:crypto can parse certificates but not
 * issue them, and shelling out to `openssl` would make the unit run depend on a binary.
 * The fake fetch serves that certificate from an `sns.<region>.amazonaws.com` URL, which is
 * exactly the position SNS's own certificate is in.
 */

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalSnsString,
  createSnsVerifier,
  isSnsUrl,
  MAX_CACHED_CERTS,
  parseSnsEnvelope,
  type FetchLike,
  type SnsEnvelope,
} from './sns-verifier.js';

const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:fire-watch-ses-feedback';
const CERT_URL =
  'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem';
const SUBSCRIBE_URL =
  'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=' +
  encodeURIComponent(TOPIC) +
  '&Token=2336412f37fb687f5d51e6e2425f004aed';
/** Inside the certificate's validity, below. */
const NOW = Date.parse('2026-10-13T09:00:00Z');

/** The verifier always passes a string; the other two arms keep the fake total. */
function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}
const SENT = '2026-10-13T08:59:30.000Z';

// --- a minimal DER encoder, enough for one self-signed certificate -----------------------

function der(tag: number, content: Buffer): Buffer {
  const n = content.length;
  const length =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts));
const SHA256_WITH_RSA = seq(
  Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
  Buffer.from([0x05, 0x00]),
);
const COMMON_NAME_OID = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);

function selfSignedPem(
  key: { readonly publicKey: KeyObject; readonly privateKey: KeyObject },
  validity: { readonly from: string; readonly to: string },
): string {
  const name = seq(set(seq(COMMON_NAME_OID, der(0x0c, Buffer.from('sns.amazonaws.com')))));
  const tbs = seq(
    Buffer.from([0x02, 0x01, 0x01]), // serialNumber 1; no version member → v1
    SHA256_WITH_RSA,
    name,
    seq(der(0x18, Buffer.from(validity.from)), der(0x18, Buffer.from(validity.to))),
    name,
    key.publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, key.privateKey);
  const certificate = seq(
    tbs,
    SHA256_WITH_RSA,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const body = certificate.toString('base64').replace(/(.{64})/gu, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

const SNS_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SNS_CERT = selfSignedPem(SNS_KEY, { from: '20260101000000Z', to: '20270101000000Z' });

// --- messages ------------------------------------------------------------------------------

type Unsigned = Omit<SnsEnvelope, 'signature' | 'signatureVersion'>;

function signed(
  envelope: Unsigned,
  version: '1' | '2' = '1',
  key: KeyObject = SNS_KEY.privateKey,
): Record<string, string> {
  const withVersion = { ...envelope, signatureVersion: version, signature: '' };
  const signature = sign(
    version === '1' ? 'sha1' : 'sha256',
    Buffer.from(canonicalSnsString(withVersion), 'utf8'),
    key,
  ).toString('base64');
  return toWire({ ...withVersion, signature });
}

function toWire(envelope: SnsEnvelope): Record<string, string> {
  const wire: Record<string, string> = {
    Type: envelope.type,
    MessageId: envelope.messageId,
    TopicArn: envelope.topicArn,
    Message: envelope.message,
    Timestamp: envelope.timestamp,
    SignatureVersion: envelope.signatureVersion,
    Signature: envelope.signature,
    SigningCertURL: envelope.signingCertUrl,
  };
  if (envelope.subject !== undefined) wire['Subject'] = envelope.subject;
  if (envelope.subscribeUrl !== undefined) wire['SubscribeURL'] = envelope.subscribeUrl;
  if (envelope.token !== undefined) wire['Token'] = envelope.token;
  if (envelope.type === 'Notification') {
    wire['UnsubscribeURL'] =
      'https://sns.eu-central-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=x';
  }
  return wire;
}

const NOTIFICATION: Unsigned = {
  type: 'Notification',
  messageId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324',
  topicArn: TOPIC,
  message: JSON.stringify({ notificationType: 'Bounce', bounce: {}, mail: {} }),
  timestamp: SENT,
  signingCertUrl: CERT_URL,
};

const CONFIRMATION: Unsigned = {
  type: 'SubscriptionConfirmation',
  messageId: '165545c9-2a5c-472c-8df2-7ff2be2b3b1b',
  topicArn: TOPIC,
  message: `You have chosen to subscribe to the topic ${TOPIC}.\nTo confirm the subscription, visit the SubscribeURL included in this message.`,
  timestamp: SENT,
  signingCertUrl: CERT_URL,
  subscribeUrl: SUBSCRIBE_URL,
  token: '2336412f37fb687f5d51e6e2425f004aed',
};

// --- a fake fetch --------------------------------------------------------------------------

function fakeFetch(routes: Readonly<Record<string, { status: number; body: string }>> = {}): {
  readonly fetch: FetchLike;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const table: Record<string, { status: number; body: string }> = {
    [CERT_URL]: { status: 200, body: SNS_CERT },
    [SUBSCRIBE_URL]: { status: 200, body: '<ConfirmSubscriptionResponse/>' },
    ...routes,
  };
  const fetch: FetchLike = (input, init) => {
    const url = urlOf(input);
    calls.push(url);
    expect(init?.redirect).toBe('error');
    const route = table[url];
    if (route === undefined) return Promise.reject(new Error('unexpected fetch'));
    return Promise.resolve(new Response(route.body, { status: route.status }));
  };
  return { fetch, calls };
}

function verifier(fetch: FetchLike = fakeFetch().fetch) {
  return createSnsVerifier({ topicArn: TOPIC, fetch });
}

// --- tests -----------------------------------------------------------------------------------

describe('SNS signature verification', () => {
  it.each(['1', '2'] as const)('accepts a notification signed with version %s', async (v) => {
    const result = await verifier().verify(JSON.stringify(signed(NOTIFICATION, v)), NOW);
    expect(result).toMatchObject({ ok: true, envelope: { type: 'Notification', topicArn: TOPIC } });
  });

  it('accepts a notification with a Subject, which joins the canonical string', async () => {
    const result = await verifier().verify(
      signed({ ...NOTIFICATION, subject: 'Amazon SES Email Event Notification' }),
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts an already-parsed body: the signature covers values, not bytes', async () => {
    const result = await verifier().verify(signed(NOTIFICATION, '2'), NOW);
    expect(result.ok).toBe(true);
  });

  it.each(['1', '2'] as const)(
    'accepts a subscription confirmation signed with version %s',
    async (v) => {
      const result = await verifier().verify(signed(CONFIRMATION, v), NOW);
      expect(result).toMatchObject({ ok: true, envelope: { type: 'SubscriptionConfirmation' } });
    },
  );

  it('accepts an unsubscribe confirmation', async () => {
    const result = await verifier().verify(
      signed({ ...CONFIRMATION, type: 'UnsubscribeConfirmation' }),
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a message signed by another key', async () => {
    const result = await verifier().verify(signed(NOTIFICATION, '1', OTHER_KEY.privateKey), NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['the Message', { Message: '{"notificationType":"Complaint"}' }],
    ['the MessageId', { MessageId: 'another-id' }],
    ['the Timestamp', { Timestamp: '2026-10-13T08:59:31.000Z' }],
    ['the Subject (added)', { Subject: 'injected' }],
  ])('refuses a message whose %s was changed after signing', async (_name, change) => {
    const result = await verifier().verify({ ...signed(NOTIFICATION), ...change }, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a signature made with the other version than the one claimed', async () => {
    const wire = { ...signed(NOTIFICATION, '1'), SignatureVersion: '2' };
    expect(await verifier().verify(wire, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a signature that is not base64 of anything', async () => {
    const wire = { ...signed(NOTIFICATION), Signature: '!!!' };
    expect(await verifier().verify(wire, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a confirmation whose SubscribeURL was swapped after signing', async () => {
    const wire = {
      ...signed(CONFIRMATION),
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&x=1',
    };
    expect(await verifier().verify(wire, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('what is checked before any certificate is fetched', () => {
  it('refuses another topic without fetching anything', async () => {
    const { fetch, calls } = fakeFetch();
    const result = await verifier(fetch).verify(
      signed({ ...NOTIFICATION, topicArn: 'arn:aws:sns:eu-central-1:999999999999:theirs' }),
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_topic' });
    expect(calls).toEqual([]);
  });

  it('refuses a message older than an hour as a replay', async () => {
    const result = await verifier().verify(signed(NOTIFICATION), NOW + 3_600_000);
    expect(result).toEqual({ ok: false, reason: 'stale' });
  });

  it('accepts a message just inside the hour', async () => {
    const sentAt = Date.parse(SENT);
    const result = await verifier().verify(signed(NOTIFICATION), sentAt + 3_600_000);
    expect(result.ok).toBe(true);
  });

  it('refuses a message dated well in the future', async () => {
    const result = await verifier().verify(signed(NOTIFICATION), Date.parse(SENT) - 600_000);
    expect(result).toEqual({ ok: false, reason: 'from_the_future' });
  });

  it('refuses an unparseable timestamp', async () => {
    const result = await verifier().verify(
      signed({ ...NOTIFICATION, timestamp: 'yesterday' }),
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['http', CERT_URL.replace('https:', 'http:')],
    ['a foreign host', 'https://attacker.example/SimpleNotificationService-1.pem'],
    ['a suffix-match host', 'https://sns.eu-central-1.amazonaws.com.attacker.example/x.pem'],
    ['a lookalike host', 'https://attacker-sns.eu-central-1.amazonaws.com/x.pem'],
    ['a non-.pem path', 'https://sns.eu-central-1.amazonaws.com/cert.txt'],
    ['an explicit port', 'https://sns.eu-central-1.amazonaws.com:8443/x.pem'],
    ['credentials', 'https://user:pass@sns.eu-central-1.amazonaws.com/x.pem'],
    ['not a URL', 'sns.eu-central-1.amazonaws.com/x.pem'],
  ])('refuses a certificate URL with %s, without fetching it', async (_name, url) => {
    const { fetch, calls } = fakeFetch({ [url]: { status: 200, body: SNS_CERT } });
    const result = await verifier(fetch).verify(
      signed({ ...NOTIFICATION, signingCertUrl: url }),
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_cert_url' });
    expect(calls).toEqual([]);
  });
});

describe('the certificate', () => {
  it('is fetched once and cached for later messages', async () => {
    const { fetch, calls } = fakeFetch();
    const sns = verifier(fetch);
    expect((await sns.verify(signed(NOTIFICATION), NOW)).ok).toBe(true);
    expect((await sns.verify(signed({ ...NOTIFICATION, messageId: 'm2' }, '2'), NOW)).ok).toBe(
      true,
    );
    expect(calls).toEqual([CERT_URL]);
  });

  it('is not cached when the fetch fails, so a later message retries it', async () => {
    let fail = true;
    const calls: string[] = [];
    const fetch: FetchLike = (input) => {
      calls.push(urlOf(input));
      return fail
        ? Promise.reject(new Error('ECONNRESET'))
        : Promise.resolve(new Response(SNS_CERT, { status: 200 }));
    };
    const sns = verifier(fetch);
    expect(await sns.verify(signed(NOTIFICATION), NOW)).toEqual({
      ok: false,
      reason: 'cert_unavailable',
    });
    fail = false;
    expect((await sns.verify(signed(NOTIFICATION), NOW)).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['a 404', { status: 404, body: 'Not Found' }],
    ['a body that is not a certificate', { status: 200, body: 'hello' }],
    ['an oversized body', { status: 200, body: 'x'.repeat(20_000) }],
  ])('is unavailable on %s', async (_name, route) => {
    const { fetch } = fakeFetch({ [CERT_URL]: route });
    expect(await verifier(fetch).verify(signed(NOTIFICATION), NOW)).toEqual({
      ok: false,
      reason: 'cert_unavailable',
    });
  });

  it('is refused once expired, and dropped from the cache', async () => {
    const after = Date.parse('2027-01-02T00:00:00Z');
    const { fetch, calls } = fakeFetch();
    const sns = verifier(fetch);
    const late = signed({ ...NOTIFICATION, timestamp: new Date(after - 1000).toISOString() });
    expect(await sns.verify(late, after)).toEqual({ ok: false, reason: 'cert_expired' });
    expect(await sns.verify(late, after)).toEqual({ ok: false, reason: 'cert_expired' });
    expect(calls).toEqual([CERT_URL, CERT_URL]);
  });

  it('the cache is bounded', async () => {
    const urls = Array.from(
      { length: MAX_CACHED_CERTS + 1 },
      (_, i) => `https://sns.eu-central-1.amazonaws.com/cert-${String(i)}.pem`,
    );
    const { fetch, calls } = fakeFetch(
      Object.fromEntries(urls.map((url) => [url, { status: 200, body: SNS_CERT }])),
    );
    const sns = verifier(fetch);
    for (const url of urls) {
      expect((await sns.verify(signed({ ...NOTIFICATION, signingCertUrl: url }), NOW)).ok).toBe(
        true,
      );
    }
    // The first URL was evicted to make room for the last; asking again refetches it.
    await sns.verify(signed({ ...NOTIFICATION, signingCertUrl: urls[0] ?? '' }), NOW);
    expect(calls).toHaveLength(urls.length + 1);
  });
});

describe('subscription confirmation', () => {
  it('GETs the SubscribeURL of a verified confirmation', async () => {
    const { fetch, calls } = fakeFetch();
    const sns = verifier(fetch);
    const result = await sns.verify(signed(CONFIRMATION), NOW);
    if (!result.ok) throw new Error(result.reason);
    expect(await sns.confirmSubscription(result.envelope)).toBe('confirmed');
    expect(calls).toEqual([CERT_URL, SUBSCRIBE_URL]);
  });

  it('refuses a SubscribeURL off the SNS hosts, even when correctly signed', async () => {
    const evil = 'https://attacker.example/?Action=ConfirmSubscription';
    const { fetch, calls } = fakeFetch();
    const sns = verifier(fetch);
    const result = await sns.verify(signed({ ...CONFIRMATION, subscribeUrl: evil }), NOW);
    if (!result.ok) throw new Error(result.reason);
    expect(await sns.confirmSubscription(result.envelope)).toBe('bad_subscribe_url');
    expect(calls).toEqual([CERT_URL]);
  });

  it('never confirms from an unsubscribe confirmation', async () => {
    const { fetch, calls } = fakeFetch();
    const sns = verifier(fetch);
    const unsubscribe = await sns.verify(
      signed({ ...CONFIRMATION, type: 'UnsubscribeConfirmation' }),
      NOW,
    );
    if (!unsubscribe.ok) throw new Error(unsubscribe.reason);
    expect(await sns.confirmSubscription(unsubscribe.envelope)).toBe('bad_subscribe_url');
    expect(calls).toEqual([CERT_URL]);
  });

  it('reports a failed confirmation call', async () => {
    const { fetch } = fakeFetch({ [SUBSCRIBE_URL]: { status: 403, body: 'denied' } });
    const sns = verifier(fetch);
    const result = await sns.verify(signed(CONFIRMATION), NOW);
    if (!result.ok) throw new Error(result.reason);
    expect(await sns.confirmSubscription(result.envelope)).toBe('failed');
  });

  it('a confirmation for another topic is refused before its URL could be used', async () => {
    const { fetch, calls } = fakeFetch();
    const result = await verifier(fetch).verify(
      signed({ ...CONFIRMATION, topicArn: 'arn:aws:sns:eu-central-1:999999999999:theirs' }),
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_topic' });
    expect(calls).toEqual([]);
  });
});

describe('parseSnsEnvelope', () => {
  it.each([
    ['not JSON', 'nope', 'malformed'],
    ['an array', '[]', 'malformed'],
    ['no Type', JSON.stringify({ ...signed(NOTIFICATION), Type: undefined }), 'malformed'],
    ['an unknown Type', { ...signed(NOTIFICATION), Type: 'Telemetry' }, 'unsupported_type'],
    [
      'signature version 3',
      { ...signed(NOTIFICATION), SignatureVersion: '3' },
      'unsupported_signature_version',
    ],
    ['no Signature', { ...signed(NOTIFICATION), Signature: undefined }, 'malformed'],
    ['no SigningCertURL', { ...signed(NOTIFICATION), SigningCertURL: undefined }, 'malformed'],
    ['a confirmation without a Token', { ...signed(CONFIRMATION), Token: undefined }, 'malformed'],
    [
      'a confirmation without a SubscribeURL',
      { ...signed(CONFIRMATION), SubscribeURL: undefined },
      'malformed',
    ],
  ])('%s → %s', (_name, body, reason) => {
    expect(parseSnsEnvelope(body)).toBe(reason);
  });
});

describe('canonicalSnsString', () => {
  it('lists a notification’s fields in AWS’s order, Subject only when present', () => {
    const envelope = { ...NOTIFICATION, signatureVersion: '1', signature: '' } as const;
    expect(canonicalSnsString(envelope)).toBe(
      `Message\n${NOTIFICATION.message}\nMessageId\n${NOTIFICATION.messageId}\n` +
        `Timestamp\n${SENT}\nTopicArn\n${TOPIC}\nType\nNotification\n`,
    );
    expect(canonicalSnsString({ ...envelope, subject: 'S' })).toContain(
      `MessageId\n${NOTIFICATION.messageId}\nSubject\nS\nTimestamp\n`,
    );
  });

  it('lists a confirmation’s fields with SubscribeURL and Token', () => {
    const envelope = { ...CONFIRMATION, signatureVersion: '2', signature: '' } as const;
    expect(canonicalSnsString(envelope)).toBe(
      `Message\n${CONFIRMATION.message}\nMessageId\n${CONFIRMATION.messageId}\n` +
        `SubscribeURL\n${SUBSCRIBE_URL}\nTimestamp\n${SENT}\nToken\n${CONFIRMATION.token ?? ''}\n` +
        `TopicArn\n${TOPIC}\nType\nSubscriptionConfirmation\n`,
    );
  });
});

describe('isSnsUrl', () => {
  it.each([
    [CERT_URL, true, true],
    ['https://sns.us-gov-west-1.amazonaws.com/x.pem', true, true],
    [SUBSCRIBE_URL, false, true],
    [SUBSCRIBE_URL, true, false],
    ['https://SNS.EU-CENTRAL-1.AMAZONAWS.COM/x.pem', true, true],
    ['https://sns.amazonaws.com/x.pem', true, false],
    ['https://sqs.eu-central-1.amazonaws.com/x.pem', true, false],
  ])('%s (pem: %s) → %s', (url, pem, expected) => {
    expect(isSnsUrl(url, { pem })).toBe(expected);
  });
});
