/**
 * The owner's endpoint registry (TASKS V2-G2; `/api/v1/webhooks`; docs/WEBHOOKS.md): what
 * the routes call to register, list, remove an endpoint and rotate its secret.
 *
 * **Registration runs the SSRF guard once, up front.** The URL must pass
 * `validateWebhookUrl` (https, port 443, no credentials, no fragment, no internal name, no
 * private IP literal), and a name must resolve, now, to public addresses only. That is a
 * courtesy check — an owner learns at once that `https://intranet.corp/hook` will never
 * work — not the protection: every send re-runs the full guard (`webhook-transport.ts`),
 * because a name's answer can change after registration.
 *
 * **The signing secret is shown once.** A create and a rotation answer with the plaintext;
 * the store keeps only its seal (`aes-gcm-webhook-secret-sealer.ts`), and no read returns
 * it again. A rotation takes effect on the next attempt, including the retries of an alert
 * already queued; there is no overlap window in which the old secret still signs, which
 * docs/WEBHOOKS.md tells integrators.
 */

import { randomUUID } from 'node:crypto';

import type { WebhookParams } from '../../core/config/webhook-params.js';
import type { EpochMs } from '../../core/ports/clock.js';
import type {
  HostResolver,
  WebhookEndpointStore,
  WebhookEndpointView,
  WebhookSecretSealer,
} from '../../core/ports/webhook-store.js';
import {
  allAddressesPublic,
  validateWebhookUrl,
  type WebhookUrlRejection,
} from '../../core/webhooks/webhook-url.js';
import { generateWebhookSigningSecret } from '../crypto/aes-gcm-webhook-secret-sealer.js';

/** Why a registration was refused; the route maps each to a problem document. */
export type WebhookRegistrationRefusal =
  | { readonly kind: 'url_invalid'; readonly reason: WebhookUrlRejection | 'unresolvable' }
  | { readonly kind: 'limit_reached'; readonly limit: number };

export class WebhookRegistrationError extends Error {
  constructor(readonly refusal: WebhookRegistrationRefusal) {
    // A literal: the URL is never quoted, its path may carry the receiver's own token.
    super(`webhook registration refused: ${refusal.kind}`);
    this.name = 'WebhookRegistrationError';
  }
}

export interface RegisteredWebhook {
  readonly endpoint: WebhookEndpointView;
  /** The plaintext signing secret, returned this once. */
  readonly secret: string;
}

export interface RotatedWebhookSecret {
  readonly secret: string;
  readonly rotatedAtMs: EpochMs;
}

export interface WebhookRegistry {
  /** Throws {@link WebhookRegistrationError} for a refused URL or a full account. */
  create(accountId: string, rawUrl: string, atMs: EpochMs): Promise<RegisteredWebhook>;
  list(accountId: string): Promise<readonly WebhookEndpointView[]>;
  /** False when the account owns no endpoint by that id. */
  remove(accountId: string, endpointId: string, atMs: EpochMs): Promise<boolean>;
  /** Null when the account owns no endpoint by that id. */
  rotateSecret(
    accountId: string,
    endpointId: string,
    atMs: EpochMs,
  ): Promise<RotatedWebhookSecret | null>;
}

export interface WebhookRegistryOptions {
  readonly store: WebhookEndpointStore;
  readonly sealer: WebhookSecretSealer;
  readonly resolver: HostResolver;
  readonly params: WebhookParams;
  readonly newId?: () => string;
  /** The secret generator; tests pass a deterministic one. */
  readonly newSecret?: (bytes: number) => string;
}

export function createWebhookRegistry(options: WebhookRegistryOptions): WebhookRegistry {
  const { store, sealer, params } = options;
  const newId = options.newId ?? (() => randomUUID());
  const newSecret = options.newSecret ?? ((bytes: number) => generateWebhookSigningSecret(bytes));
  const rules = { allowedPorts: params.allowedPorts, maxUrlLength: params.maxUrlLength };

  return {
    async create(accountId, rawUrl, atMs) {
      const check = validateWebhookUrl(rawUrl, rules);
      if (!check.ok) {
        throw new WebhookRegistrationError({ kind: 'url_invalid', reason: check.reason });
      }
      if (!check.ipLiteral) {
        let addresses: readonly string[];
        try {
          addresses = await options.resolver.resolve(check.host);
        } catch {
          throw new WebhookRegistrationError({ kind: 'url_invalid', reason: 'unresolvable' });
        }
        if (!allAddressesPublic(addresses)) {
          throw new WebhookRegistrationError({ kind: 'url_invalid', reason: 'private_address' });
        }
      }

      const id = newId();
      const secret = newSecret(params.secretBytes);
      const created = await store.create(
        { id, accountId, url: check.href, sealed: sealer.seal(id, secret), atMs },
        params.maxEndpointsPerAccount,
      );
      if (!created) {
        throw new WebhookRegistrationError({
          kind: 'limit_reached',
          limit: params.maxEndpointsPerAccount,
        });
      }
      return {
        endpoint: {
          id,
          url: check.href,
          createdAtMs: atMs,
          secretRotatedAtMs: atMs,
          confirmed: false,
          disabledAtMs: null,
          disabledReason: null,
          consecutiveFailures: 0,
          lastSuccessAtMs: null,
          lastFailureAtMs: null,
        },
        secret,
      };
    },

    list: (accountId) => store.list(accountId),

    remove: (accountId, endpointId, atMs) => store.remove(accountId, endpointId, atMs),

    async rotateSecret(accountId, endpointId, atMs) {
      if ((await store.get(accountId, endpointId)) === null) return null;
      const secret = newSecret(params.secretBytes);
      const rotated = await store.rotateSecret(
        accountId,
        endpointId,
        sealer.seal(endpointId, secret),
        atMs,
      );
      return rotated ? { secret, rotatedAtMs: atMs } : null;
    },
  };
}
