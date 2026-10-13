/**
 * The SES feedback decision, over payloads shaped after the examples in the AWS SES
 * developer guide ("Examples of notifications for Amazon SES" and "Examples of event data
 * that Amazon SES publishes to Amazon SNS"), trimmed to the members the parser reads plus
 * enough of the rest that a stray dependency on a missing member would show.
 */

import { describe, expect, it } from 'vitest';

import {
  applyEmailFeedback,
  normalizeFeedbackAddress,
  parseSesFeedback,
  type ParsedFeedback,
} from './email-feedback.js';
import type { EmailSuppressor } from '../ports/email-suppressor.js';

const NOW = Date.parse('2026-10-13T09:00:00Z');

const MAIL = {
  timestamp: '2026-10-13T08:59:00.000Z',
  source: 'alerts@fire-watch.example',
  sourceArn: 'arn:aws:ses:eu-central-1:123456789012:identity/fire-watch.example',
  sendingAccountId: '123456789012',
  messageId: '0102018f2f5a6b7c-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-000000',
  destination: ['jane@example.com'],
};

/** Classic identity notification, permanent bounce (AWS example, abridged). */
const CLASSIC_PERMANENT = {
  notificationType: 'Bounce',
  bounce: {
    bounceType: 'Permanent',
    bounceSubType: 'General',
    bouncedRecipients: [
      {
        emailAddress: 'jane@example.com',
        action: 'failed',
        status: '5.1.1',
        diagnosticCode: 'smtp; 550 5.1.1 user unknown',
      },
    ],
    timestamp: '2026-10-13T08:59:30.000Z',
    feedbackId: '000001378603177f-7a5433e7-8edb-42ae-af10-f0181f34d6ee-000000',
    remoteMtaIp: '192.0.2.1',
    reportingMTA: 'dsn; a8-70.smtp-out.amazonses.com',
  },
  mail: MAIL,
};

/** Event publishing (configuration set), same bounce — `eventType`, not `notificationType`. */
const EVENT_PERMANENT = {
  eventType: 'Bounce',
  bounce: { ...CLASSIC_PERMANENT.bounce },
  mail: { ...MAIL, tags: { 'ses:configuration-set': ['fire-watch'] } },
};

function bounce(bounceType: string, bounceSubType: string, addresses: readonly string[]): string {
  return JSON.stringify({
    eventType: 'Bounce',
    bounce: {
      bounceType,
      bounceSubType,
      bouncedRecipients: addresses.map((emailAddress) => ({ emailAddress })),
      timestamp: '2026-10-13T08:59:30.000Z',
      feedbackId: 'fb-1',
    },
    mail: MAIL,
  });
}

function complaint(
  addresses: readonly string[],
  extra: Record<string, unknown> = {},
  field: 'eventType' | 'notificationType' = 'notificationType',
): string {
  return JSON.stringify({
    [field]: 'Complaint',
    complaint: {
      userAgent: 'ExampleCorp Feedback Loop (V0.01)',
      complainedRecipients: addresses.map((emailAddress) => ({ emailAddress })),
      timestamp: '2026-10-13T08:59:40.000Z',
      feedbackId: '000001378603177f-18c07c78-fa81-4a58-9dd1-fedc3cb8f49a-000000',
      arrivalDate: '2026-10-13T08:59:35.000Z',
      ...extra,
    },
    mail: MAIL,
  });
}

function parsed(message: string): Extract<ParsedFeedback, { status: 'parsed' }> {
  const result = parseSesFeedback(message);
  if (result.status !== 'parsed') throw new Error(`expected parsed, got ${result.reason}`);
  return result;
}

describe('parseSesFeedback — bounces', () => {
  it.each([
    ['classic identity notification', CLASSIC_PERMANENT],
    ['configuration-set event publishing', EVENT_PERMANENT],
  ])('a permanent bounce suppresses the recipient (%s)', (_name, payload) => {
    const result = parsed(JSON.stringify(payload));
    expect(result.kind).toBe('bounce');
    expect(result.type).toBe('Bounce');
    expect(result.mailMessageId).toBe(MAIL.messageId);
    expect(result.decisions).toEqual([
      { action: 'suppress', reason: 'permanent_bounce', address: 'jane@example.com' },
    ]);
  });

  it.each(['General', 'NoEmail', 'Suppressed', 'OnAccountSuppressionList'])(
    'every permanent sub-type suppresses (%s)',
    (subType) => {
      const result = parsed(bounce('Permanent', subType, ['a@example.com']));
      expect(result.decisions.map((d) => d.action)).toEqual(['suppress']);
    },
  );

  it.each([
    ['Transient', 'MailboxFull', 'transient_bounce'],
    ['Transient', 'General', 'transient_bounce'],
    ['Transient', 'MessageTooLarge', 'transient_bounce'],
    ['Transient', 'ContentRejected', 'transient_bounce'],
    ['Transient', 'AttachmentRejected', 'transient_bounce'],
    ['Undetermined', 'Undetermined', 'undetermined_bounce'],
    ['SomethingAwsAddsLater', 'General', 'undetermined_bounce'],
  ])('a %s/%s bounce is ignored', (type, subType, reason) => {
    const result = parsed(bounce(type, subType, ['a@example.com']));
    expect(result.decisions).toEqual([{ action: 'ignore', reason, address: 'a@example.com' }]);
  });

  it('decides for every recipient of a multi-recipient bounce, once per address', () => {
    const result = parsed(
      bounce('Permanent', 'General', ['a@example.com', 'B@Example.COM', 'A@EXAMPLE.com']),
    );
    expect(result.decisions.map((d) => d.address)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('a recipient that does not normalize is reported, not suppressed', () => {
    const result = parsed(bounce('Permanent', 'General', ['not-an-address', 'ok@example.com']));
    expect(result.decisions).toEqual([
      { action: 'ignore', reason: 'unparseable_address', address: null },
      { action: 'suppress', reason: 'permanent_bounce', address: 'ok@example.com' },
    ]);
  });
});

describe('parseSesFeedback — complaints', () => {
  it.each(['notificationType', 'eventType'] as const)(
    'a complaint without a feedback type suppresses (%s)',
    (field) => {
      const result = parsed(complaint(['jane@example.com'], {}, field));
      expect(result.kind).toBe('complaint');
      expect(result.decisions).toEqual([
        { action: 'suppress', reason: 'complaint', address: 'jane@example.com' },
      ]);
    },
  );

  it.each(['abuse', 'auth-failure', 'fraud', 'other', 'virus'])(
    'a complaint with feedback type %s suppresses',
    (feedbackType) => {
      const result = parsed(
        complaint(['jane@example.com'], { complaintFeedbackType: feedbackType }),
      );
      expect(result.decisions.map((d) => d.action)).toEqual(['suppress']);
    },
  );

  it('a complaint on the account suppression list still suppresses', () => {
    const result = parsed(
      complaint(['jane@example.com'], { complaintSubType: 'OnAccountSuppressionList' }),
    );
    expect(result.decisions.map((d) => d.action)).toEqual(['suppress']);
  });

  it('a not-spam report is the opposite of a complaint and is ignored', () => {
    const result = parsed(complaint(['jane@example.com'], { complaintFeedbackType: 'not-spam' }));
    expect(result.decisions).toEqual([
      { action: 'ignore', reason: 'complaint_not_spam', address: 'jane@example.com' },
    ]);
  });
});

describe('parseSesFeedback — everything else', () => {
  it.each([
    ['Delivery (classic)', { notificationType: 'Delivery', delivery: {}, mail: MAIL }],
    ['Delivery (event)', { eventType: 'Delivery', delivery: {}, mail: MAIL }],
    ['Send', { eventType: 'Send', send: {}, mail: MAIL }],
    ['Reject', { eventType: 'Reject', reject: { reason: 'Bad content' }, mail: MAIL }],
    ['Open', { eventType: 'Open', open: {}, mail: MAIL }],
    ['Click', { eventType: 'Click', click: {}, mail: MAIL }],
    ['DeliveryDelay', { eventType: 'DeliveryDelay', deliveryDelay: {}, mail: MAIL }],
    ['Rendering Failure', { eventType: 'Rendering Failure', failure: {}, mail: MAIL }],
    [
      'the SES topic test message',
      {
        notificationType: 'AmazonSnsSubscriptionSucceeded',
        message: 'You have successfully subscribed your Amazon SNS topic.',
      },
    ],
  ])('%s is ignored without a decision', (_name, payload) => {
    const result = parsed(JSON.stringify(payload));
    expect(result.kind).toBe('other');
    expect(result.decisions).toEqual([]);
  });

  it('a delivery report of a bounce-shaped body is still ignored: the type decides', () => {
    const result = parsed(JSON.stringify({ ...CLASSIC_PERMANENT, notificationType: 'Delivery' }));
    expect(result.decisions).toEqual([]);
  });

  it('eventType wins when a document carries both fields', () => {
    const result = parsed(
      JSON.stringify({ ...EVENT_PERMANENT, notificationType: 'Delivery', eventType: 'Bounce' }),
    );
    expect(result.kind).toBe('bounce');
  });

  it('bounds the reported type so a hostile one is not a log line', () => {
    const result = parsed(JSON.stringify({ eventType: 'x'.repeat(5000) }));
    expect(result.type).toHaveLength(40);
    expect(result.mailMessageId).toBeNull();
  });
});

describe('parseSesFeedback — malformed documents', () => {
  it.each([
    ['not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"Bounce"'],
    ['no type', JSON.stringify({ bounce: CLASSIC_PERMANENT.bounce })],
    ['a numeric type', JSON.stringify({ eventType: 7 })],
    ['a bounce without its object', JSON.stringify({ eventType: 'Bounce', mail: MAIL })],
    [
      'a bounce without a type',
      JSON.stringify({
        eventType: 'Bounce',
        bounce: { bouncedRecipients: [{ emailAddress: 'a@example.com' }] },
      }),
    ],
    [
      'a bounce with no recipients',
      JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent' } }),
    ],
    [
      'a bounce with an empty recipient list',
      JSON.stringify({
        eventType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [] },
      }),
    ],
    [
      'a recipient without an address',
      JSON.stringify({
        eventType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ status: '5.1.1' }] },
      }),
    ],
    [
      'an implausible number of recipients',
      bounce(
        'Permanent',
        'General',
        Array.from({ length: 101 }, (_, i) => `r${String(i)}@example.com`),
      ),
    ],
    ['a complaint without its object', JSON.stringify({ notificationType: 'Complaint' })],
    [
      'a complaint whose recipients are not a list',
      JSON.stringify({
        notificationType: 'Complaint',
        complaint: { complainedRecipients: 'a@example.com' },
      }),
    ],
  ])('%s is malformed', (_name, message) => {
    expect(parseSesFeedback(message).status).toBe('malformed');
  });

  it('a malformed reason never quotes the payload', () => {
    const result = parseSesFeedback(
      JSON.stringify({
        eventType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ status: 'jane@example.com' }] },
      }),
    );
    expect(result.status === 'malformed' && result.reason).not.toContain('jane');
  });
});

describe('normalizeFeedbackAddress', () => {
  it.each([
    ['jane@example.com', 'jane@example.com'],
    ['  Jane@Example.COM ', 'jane@example.com'],
    ['Jane Doe <Jane@Example.com>', 'jane@example.com'],
    ['<jane@example.com>', 'jane@example.com'],
    ['nobody', null],
    ['a b@example.com', null],
    ['', null],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeFeedbackAddress(raw)).toBe(expected);
  });
});

describe('applyEmailFeedback', () => {
  function recorder(revokedPerAddress = 1): {
    readonly suppressor: EmailSuppressor;
    readonly calls: [string, number][];
  } {
    const calls: [string, number][] = [];
    return {
      calls,
      suppressor: {
        suppress: (address, at) => {
          calls.push([address, at]);
          return Promise.resolve(revokedPerAddress);
        },
      },
    };
  }

  it('suppresses each suppressed address at `now` and counts what was revoked', async () => {
    const { suppressor, calls } = recorder(2);
    const outcome = await applyEmailFeedback(
      parsed(bounce('Permanent', 'General', ['a@example.com', 'bad', 'b@example.com'])),
      suppressor,
      NOW,
    );
    expect(calls).toEqual([
      ['a@example.com', NOW],
      ['b@example.com', NOW],
    ]);
    expect(outcome).toEqual({
      kind: 'bounce',
      type: 'Bounce',
      mailMessageId: MAIL.messageId,
      recipients: 3,
      suppressedAddresses: 2,
      ignoredAddresses: 1,
      revokedSubscriptions: 4,
      reasons: { permanent_bounce: 2, unparseable_address: 1 },
    });
  });

  it('never calls the port for an ignored document', async () => {
    const { suppressor, calls } = recorder();
    const outcome = await applyEmailFeedback(
      parsed(bounce('Transient', 'MailboxFull', ['a@example.com'])),
      suppressor,
      NOW,
    );
    expect(calls).toEqual([]);
    expect(outcome.revokedSubscriptions).toBe(0);
    expect(outcome.reasons).toEqual({ transient_bounce: 1 });
  });

  it('the summary carries no address', async () => {
    const { suppressor } = recorder();
    const outcome = await applyEmailFeedback(
      parsed(complaint(['jane@example.com'])),
      suppressor,
      NOW,
    );
    expect(JSON.stringify(outcome)).not.toContain('jane');
  });

  it('a failing port propagates, so SNS redelivers', async () => {
    const suppressor: EmailSuppressor = {
      suppress: () => Promise.reject(new Error('connection refused')),
    };
    await expect(
      applyEmailFeedback(parsed(complaint(['jane@example.com'])), suppressor, NOW),
    ).rejects.toThrow('connection refused');
  });
});
