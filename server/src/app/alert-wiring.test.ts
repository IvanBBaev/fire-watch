import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createAlertGateway,
  createLiveChannels,
  createNeverSendLint,
  createShadowAlertGateway,
} from './alert-wiring.js';
import { ConfigError, type AlertChannelsConfig } from './config.js';
import { renderAlertTemplate } from '../core/alerts/templates/alert-templates.js';
import type { OutboundMessage, RenderedAlert } from '../core/ports/alert-channel.js';
import { CLAIM_SEND_WINDOW_MS } from '../core/alerts/claim-lease.js';
import { RATE_LIMIT_MAX_WAIT_MS } from '../adapters/alerts/channels/channel-rates.js';
import { DEFAULT_SES_TIMEOUT_MS } from '../adapters/alerts/channels/email/ses-channel.js';
import { DEFAULT_TELEGRAM_TIMEOUT_MS } from '../adapters/alerts/channels/telegram/telegram-channel.js';
import { DEFAULT_PUSH_TIMEOUT_MS } from '../adapters/alerts/channels/web-push/web-push-channel.js';
import type { GatewayEvent, LintTarget } from '../adapters/alerts/gateway/notification-gateway.js';

/** Satisfies all three of D7's positive footer obligations. */
const FOOTER =
  'Source: NASA FIRMS (LANCE). Near real-time data, not advised for tactical decision-making. ' +
  'Fire Watch is best-effort informational monitoring — in an emergency call 112.';

const TARGET: LintTarget = {
  channel: 'push',
  templateId: 'new_fire.bg.v3',
  templateParams: {},
};

function alert(overrides: Partial<RenderedAlert> = {}): RenderedAlert {
  return {
    title: 'Hotspot near your zone',
    body: 'A satellite detected a hotspot 3 km from Zone A.',
    footer: FOOTER,
    url: null,
    ...overrides,
  };
}

describe('createNeverSendLint', () => {
  it('passes copy that keeps to what the service can know', () => {
    expect(createNeverSendLint()(alert(), TARGET)).toEqual([]);
  });

  it('refuses an all-clear in the service voice (D7 hard rule 2)', () => {
    const ruleIds = createNeverSendLint()(alert({ body: 'The fire is out.' }), TARGET);
    expect(ruleIds).toContain('own-voice-extinguished');
  });

  it('refuses a footer that lost its attribution', () => {
    const stripped = FOOTER.replace('Source: NASA FIRMS (LANCE). ', '');
    expect(createNeverSendLint()(alert({ footer: stripped }), TARGET)).toContain(
      'footer-attribution',
    );
  });

  it('lints the title, which is all a push recipient sees', () => {
    expect(createNeverSendLint()(alert({ title: 'The fire is out.' }), TARGET)).toContain(
      'own-voice-extinguished',
    );
  });
});

/** An `official_then_redetected` escalation: the one template that relays an authority. */
const OFFICIAL_ESCALATION: Record<string, unknown> = {
  eventUrl: 'https://firewatch.example/e/gdv6q',
  placeName: { bg: 'Ивайловград', en: 'Ivaylovgrad' },
  distanceKm: 4.26,
  zoneLabel: 'Вила',
  observedAt: '2026-08-12T11:05:00Z',
  scoreBucket: 'likely',
  burnedAreaHa: 320,
  areaSource: 'EFFIS',
  agriBurn: true,
  rung: 'lifecycle_worsening',
  variant: 'official_then_redetected',
  officialStatus: 'extinguished',
  officialStatementAt: '2026-08-10T09:00:00+03:00',
  officialSourceLabel: 'ГДПБЗН',
  officialSourceUrl: 'https://www.gdpbzn.bg/',
};

describe('createNeverSendLint voice (lintContextFor)', () => {
  const escalationTarget = (templateParams: Record<string, unknown>): LintTarget => ({
    channel: 'push',
    templateId: 'escalation.v1',
    templateParams,
  });

  function renderEscalation(locale: string): RenderedAlert {
    return renderAlertTemplate({
      templateId: 'escalation.v1',
      templateParams: OFFICIAL_ESCALATION,
      channel: 'push',
      locale,
      timeZone: 'Europe/Sofia',
    });
  }

  it.each(['bg', 'en'])(
    'lets a quoted official statement through with the source the template read (%s)',
    (locale) => {
      expect(
        createNeverSendLint()(renderEscalation(locale), escalationTarget(OFFICIAL_ESCALATION)),
      ).toEqual([]);
    },
  );

  it.each(['bg', 'en'])(
    'lints the same copy in own voice once the source metadata is missing (%s)',
    (locale) => {
      const { officialSourceUrl: _url, ...withoutUrl } = OFFICIAL_ESCALATION;
      const stripped = { ...withoutUrl, officialSourceUrl: null };
      expect(createNeverSendLint()(renderEscalation(locale), escalationTarget(stripped))).toContain(
        'own-voice-extinguished',
      );
    },
  );

  it('never lends the exemption to another template id', () => {
    const rendered = renderEscalation('en');
    expect(
      createNeverSendLint()(rendered, {
        ...escalationTarget(OFFICIAL_ESCALATION),
        templateId: 'new_fire.v1',
      }),
    ).toContain('own-voice-extinguished');
  });
});

describe('createShadowAlertGateway', () => {
  it('builds without a provider and dispatches an empty queue', async () => {
    const gateway = createShadowAlertGateway({
      queue: {
        claim: () => Promise.resolve([]),
        settle: () => Promise.resolve(),
      },
      recipients: {
        resolve: () => Promise.resolve({ live: false, reason: 'no recipients in this test' }),
        applyDisposition: () => Promise.resolve(),
      },
      renderer: {
        render: () => alert(),
      },
      now: () => 1_757_000_000_000,
    });

    expect(await gateway.runOnce()).toEqual({
      claimed: 0,
      sent: 0,
      closed: 0,
      released: 0,
      errored: 0,
      channelMismatches: 0,
      leaseExhausted: 0,
      lintViolations: [],
    });
  });
});

describe('the claim lease send window (H4)', () => {
  it('covers the slowest live send end to end, with room for the prune and the settle', () => {
    // A send that starts inside the lease must end inside it (claim-lease.ts, rule 2). If
    // a provider timeout or the rate-limit ceiling grows, this fails before the lease can
    // expire under an in-flight provider call.
    const slowestSend =
      RATE_LIMIT_MAX_WAIT_MS +
      Math.max(DEFAULT_PUSH_TIMEOUT_MS, DEFAULT_SES_TIMEOUT_MS, DEFAULT_TELEGRAM_TIMEOUT_MS);
    expect(slowestSend).toBe(17_000);
    expect(slowestSend + 10_000).toBeLessThanOrEqual(CLAIM_SEND_WINDOW_MS);
  });
});

describe('createAlertGateway', () => {
  it("claims its batch size and reports each row's outcome to the dispatch job", async () => {
    const now = 1_757_000_000_000;
    const limits: number[] = [];
    const events: GatewayEvent[] = [];
    const gateway = createAlertGateway({
      queue: {
        claim: (limit) => {
          limits.push(limit);
          return Promise.resolve([
            {
              id: '1',
              watchZoneId: '11111111-0000-4000-8000-000000000001',
              fireEventId: '42',
              alertType: 'new_fire',
              alertSubkey: 'once',
              triggerType: 'new_fire',
              triggerRefSeq: '41',
              ruleVersion: 'alert_gating_v1',
              templateId: 'new_fire.bg.v3',
              templateParams: {},
              channel: 'push',
              channelSubscriptionId: '3f2b0a5e-0000-4000-8000-000000000001',
              priority: 10,
              budgetSeq: null,
              status: 'claimed',
              actorId: null,
              approverId: null,
              approvalMode: null,
              approvedAt: null,
              budgetOverride: false,
              decidedAt: now - 1_000,
              claimedAt: now,
              locale: 'bg',
            },
          ]);
        },
        settle: () => Promise.resolve(),
      },
      recipients: {
        resolve: () =>
          Promise.resolve({
            live: true,
            endpoint: 'https://example.invalid/push/not-a-real-endpoint',
            channel: 'push',
            timeZone: 'Europe/Sofia',
          }),
        applyDisposition: () => Promise.resolve(),
      },
      renderer: { render: () => alert() },
      now: () => now,
      batchSize: 7,
      onEvent: (event) => events.push(event),
    });

    // No providers configured: the row is released, and the job hears why.
    expect(await gateway.runOnce()).toMatchObject({ claimed: 1, released: 1 });
    expect(limits).toEqual([7]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'released', outboxId: '1' });
  });
});

/** A throwaway P-256 pair in the raw base64url form the env carries. */
function vapidKeys(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
    privateKey: jwk.d ?? '',
  };
}

const NONE: AlertChannelsConfig = { webPush: null, telegram: null, email: null };
const BOT_TOKEN = '123456789:AAHfiqksKZ8WmR2zSjiQ7_v4TMAKdiHm9T0';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function everything(): AlertChannelsConfig {
  return {
    webPush: { ...vapidKeys(), subject: 'mailto:alerts@example.invalid' },
    telegram: { botToken: BOT_TOKEN },
    email: {
      region: 'eu-central-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: SECRET_ACCESS_KEY,
      fromAddress: 'alerts@alerts.example.invalid',
      configurationSetName: null,
    },
  };
}

const sleeper = { sleep: () => Promise.resolve() };

describe('createLiveChannels', () => {
  it('wires nothing when nothing is configured, and says there is no public key', () => {
    const live = createLiveChannels({ config: NONE, now: () => 0, sleeper });
    expect(live.channels).toEqual([]);
    expect(live.vapidPublicKey).toBeNull();
  });

  it('wires one paced adapter per configured provider, push first', () => {
    const config = everything();
    const live = createLiveChannels({ config, now: () => 0, sleeper });
    expect(live.channels.map((channel) => channel.channel)).toEqual(['push', 'telegram', 'email']);
    expect(live.vapidPublicKey).toBe(config.webPush?.publicKey);
  });

  it('wires only the providers present', () => {
    const { telegram } = everything();
    const live = createLiveChannels({ config: { ...NONE, telegram }, now: () => 0, sleeper });
    expect(live.channels.map((channel) => channel.channel)).toEqual(['telegram']);
    expect(live.vapidPublicKey).toBeNull();
  });

  it('sends through the bucket and the provider adapter, not around them', async () => {
    const calls: string[] = [];
    const fetch = (input: string | URL | Request) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const { telegram } = everything();
    const live = createLiveChannels({
      config: { ...NONE, telegram },
      now: () => 1_758_200_000_000,
      sleeper,
      fetch,
    });
    const message: OutboundMessage = {
      outboxId: '11111111-1111-4111-8111-111111111111',
      channel: 'telegram',
      endpoint: '987654321',
      rendered: alert(),
      locale: 'bg',
      ttlSeconds: 1800,
    };
    const [channel] = live.channels;
    if (channel === undefined) throw new Error('unreachable');
    expect(await channel.deliver(message)).toEqual({
      kind: 'delivered',
      providerAckAt: 1_758_200_000_000,
    });
    expect(calls).toEqual([`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`]);
  });

  it('refuses a VAPID pair that does not match, naming the variables and not the key', () => {
    const config = everything();
    if (config.webPush === null) throw new Error('unreachable');
    const other = vapidKeys();
    const webPush = { ...config.webPush, privateKey: other.privateKey };
    let thrown: unknown;
    try {
      createLiveChannels({ config: { ...config, webPush }, now: () => 0, sleeper });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const text = thrown instanceof Error ? thrown.message : '';
    expect(text).toContain('FIRE_WATCH_VAPID_*');
    expect(text).toContain('does not belong');
    expect(text).not.toContain(other.privateKey);
    expect(text).not.toContain(config.webPush.publicKey);
  });

  it('refuses a bot token or SES settings of the wrong shape, by variable name only', () => {
    expect(() =>
      createLiveChannels({
        config: { ...NONE, telegram: { botToken: 'not a token' } },
        now: () => 0,
        sleeper,
      }),
    ).toThrow(/^FIRE_WATCH_TELEGRAM_BOT_TOKEN: Telegram bot token must look like/);

    const { email } = everything();
    if (email === null) throw new Error('unreachable');
    let thrown: unknown;
    try {
      createLiveChannels({
        config: { ...NONE, email: { ...email, region: 'Frankfurt' } },
        now: () => 0,
        sleeper,
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const text = thrown instanceof Error ? thrown.message : '';
    expect(text).toMatch(/^FIRE_WATCH_SES_\*: SES region/);
    expect(text).not.toContain(SECRET_ACCESS_KEY);
  });
});
