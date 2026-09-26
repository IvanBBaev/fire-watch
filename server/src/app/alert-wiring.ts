/**
 * The one place a channel adapter may be handed to the gateway.
 *
 * `only-the-gateway-sends` in `.dependency-cruiser.cjs` names this file — and only this
 * file — as the composition root allowed to import from `adapters/alerts/channels/`. The
 * exemption is deliberately one path rather than the whole of `app/`: wiring a provider
 * into the gateway is legitimate, and wiring is all that is. If a worker, a route or a CLI
 * ever needs to send something, it takes the gateway, not a provider.
 *
 * Everything here is assembly. There is no policy in this module that is not a citation.
 */

import { lintAlert, type NeverSendContext } from '@fire-watch/contracts';

import { createNotificationGateway } from '../adapters/alerts/gateway/notification-gateway.js';
import type {
  ContentLint,
  GatewayEvent,
  LintTarget,
  NotificationGateway,
} from '../adapters/alerts/gateway/notification-gateway.js';
import {
  CHANNEL_RATES,
  RATE_LIMIT_MAX_WAIT_MS,
} from '../adapters/alerts/channels/channel-rates.js';
import { createSesChannel } from '../adapters/alerts/channels/email/ses-channel.js';
import type { FetchLike } from '../adapters/alerts/channels/provider-http.js';
import { createRateLimitedChannel } from '../adapters/alerts/channels/rate-limited-channel.js';
import { createSinkChannel } from '../adapters/alerts/channels/sink-channel.js';
import { createTelegramChannel } from '../adapters/alerts/channels/telegram/telegram-channel.js';
import { createTokenBucket } from '../adapters/alerts/channels/token-bucket.js';
import { createWebPushChannel } from '../adapters/alerts/channels/web-push/web-push-channel.js';
import { lintContextFor } from '../core/alerts/templates/alert-templates.js';
import { DELIVERY_PARAMS } from '../core/config/delivery-params.js';
import type { AlertChannelAdapter } from '../core/ports/alert-channel.js';
import type { AlertDispatchQueue } from '../core/ports/alert-dispatch-queue.js';
import type { AlertRenderer } from '../core/ports/alert-renderer.js';
import { ALERT_CHANNELS } from '../core/ports/alert-outbox-store.js';
import type { RecipientResolver } from '../core/ports/recipient-resolver.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { ConfigError, type AlertChannelsConfig } from './config.js';

/**
 * ADR-004 D7's never-send list, in the shape the gateway consumes.
 *
 * The voice comes from {@link lintContextFor} — the same function CI-10 lints the full
 * rendered matrix with, reading the same bound parameters the template rendered from — so
 * the gate at dispatch and the gate in CI cannot disagree about which copy is exempt. It
 * is own voice for every template except the `official_then_redetected` escalation, which
 * relays a named authority's statement with its URL and timestamp; parameters that do not
 * validate fall back to own voice, the strict reading. The context is never assembled ad
 * hoc here: a hand-built `quoted-official` context would let the service speak in an
 * authority's voice without the template having been told which authority.
 *
 * Rule ids come back as plain strings because that is all the gateway records; the full
 * finding, with the offending span and why an exemption did not save it, is in
 * {@link lintAlert} for whoever reads the CI report.
 */
export function createNeverSendLint(
  contextFor: (target: LintTarget) => NeverSendContext = templateVoice,
): ContentLint {
  // Handed in whole rather than projected field by field: `RenderedAlert` extends the
  // lint's `LintableAlert`, so the compiler — not this call site — is what guarantees the
  // lint sees every piece of text we are about to send.
  return (rendered, target) =>
    lintAlert(rendered, contextFor(target)).map((violation) => violation.ruleId);
}

function templateVoice(target: LintTarget): NeverSendContext {
  return lintContextFor(target.templateId, target.templateParams);
}

export interface AlertGatewayDeps {
  readonly queue: AlertDispatchQueue;
  readonly recipients: RecipientResolver;
  readonly renderer: AlertRenderer;
  /**
   * The live providers. Empty is a legitimate configuration and not a silent one: with no
   * adapter a row is released rather than sent, and D6's queue-age alarm fires at 600 s.
   * A8's shadow mode is the same wiring with {@link createSinkChannel} in their place.
   */
  readonly channels?: readonly AlertChannelAdapter[];
  readonly now: () => number;
  readonly batchSize?: number;
  /** Per-row outcomes, for the dispatch job's cycle line. */
  readonly onEvent?: (event: GatewayEvent) => void;
}

/**
 * Assemble the gateway with the shipped policy: D6's deadlines and D7's lint.
 *
 * The delivery parameters are read from the versioned config rather than passed in, so
 * that a caller cannot quietly shorten a TTL; a deployment that needs different numbers
 * changes the config version, which is what a replayed month reads back.
 */
export function createAlertGateway(deps: AlertGatewayDeps): NotificationGateway {
  return createNotificationGateway({
    queue: deps.queue,
    recipients: deps.recipients,
    renderer: deps.renderer,
    lint: createNeverSendLint(),
    channels: deps.channels ?? [],
    params: DELIVERY_PARAMS.values,
    now: deps.now,
    // Spread rather than assigned: `exactOptionalPropertyTypes` draws a distinction
    // between "absent" and "explicitly undefined", and only the first takes the default.
    ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }),
    ...(deps.onEvent === undefined ? {} : { onEvent: deps.onEvent }),
  });
}

/**
 * The gateway with every channel pointed at a sink: renders everything, sends nothing.
 *
 * This is A8's shadow mode and the local development loop, and it is the only sanctioned
 * way to exercise the full pipeline without a provider account. Sinks are built for every
 * channel so that a routing mistake still shows up as a delivered message on the wrong
 * sink rather than as a released row.
 */
export function createShadowAlertGateway(
  deps: Omit<AlertGatewayDeps, 'channels'>,
): NotificationGateway {
  return createAlertGateway({
    ...deps,
    channels: ALERT_CHANNELS.map((channel) => createSinkChannel({ channel, now: deps.now })),
  });
}

export interface LiveChannelDeps {
  readonly config: AlertChannelsConfig;
  readonly now: () => number;
  /** For the bucket's short waits; the system sleeper in production. */
  readonly sleeper: Sleeper;
  /** Process shutdown: a rate-limit wait in progress releases its row unsent. */
  readonly signal?: AbortSignal;
  /** Overridable so a smoke test can point every provider at a stub. */
  readonly fetch?: FetchLike;
}

export interface LiveChannels {
  /** One paced adapter per configured provider, in D6's priority order. */
  readonly channels: readonly AlertChannelAdapter[];
  /** For the public-key route the client subscribes with; `null` without a push provider. */
  readonly vapidPublicKey: string | null;
}

/**
 * The provider adapters this deployment is configured for, each behind its D6 token
 * bucket — the one place the three providers, the bucket and the pacing constants meet.
 *
 * A provider whose credentials fail the adapter's own gate (a VAPID public key that is
 * not the private key's, a bot token of the wrong shape) is a {@link ConfigError} naming
 * the variables, thrown here rather than on the first send at 03:00. The adapters' own
 * messages describe the shape of the problem and never repeat the value, which is what
 * lets this re-throw them verbatim.
 */
export function createLiveChannels(deps: LiveChannelDeps): LiveChannels {
  const { config, now, sleeper } = deps;
  const fetchOption = deps.fetch === undefined ? {} : { fetch: deps.fetch };
  const signalOption = deps.signal === undefined ? {} : { signal: deps.signal };
  const channels: AlertChannelAdapter[] = [];
  let vapidPublicKey: string | null = null;

  const paced = (inner: AlertChannelAdapter): AlertChannelAdapter =>
    createRateLimitedChannel({
      inner,
      bucket: createTokenBucket({ ...CHANNEL_RATES[inner.channel], now }),
      sleeper,
      maxWaitMs: RATE_LIMIT_MAX_WAIT_MS,
      ...signalOption,
    });

  const { webPush, telegram, email } = config;
  if (webPush !== null) {
    const push = gated('FIRE_WATCH_VAPID_*', () =>
      createWebPushChannel({ vapid: webPush, now, ...fetchOption }),
    );
    vapidPublicKey = push.vapidPublicKey;
    channels.push(paced(push));
  }
  if (telegram !== null) {
    channels.push(
      paced(
        gated('FIRE_WATCH_TELEGRAM_BOT_TOKEN', () =>
          createTelegramChannel({ botToken: telegram.botToken, now, ...fetchOption }),
        ),
      ),
    );
  }
  if (email !== null) {
    channels.push(
      paced(
        gated('FIRE_WATCH_SES_*', () =>
          createSesChannel({
            credentials: {
              accessKeyId: email.accessKeyId,
              secretAccessKey: email.secretAccessKey,
            },
            region: email.region,
            fromAddress: email.fromAddress,
            now,
            ...fetchOption,
            ...(email.configurationSetName === null
              ? {}
              : { configurationSetName: email.configurationSetName }),
          }),
        ),
      ),
    );
  }

  return { channels, vapidPublicKey };
}

function gated<T>(variables: string, build: () => T): T {
  try {
    return build();
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      throw new ConfigError(`${variables}: ${error.message}`);
    }
    throw error;
  }
}
