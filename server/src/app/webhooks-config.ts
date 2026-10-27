/**
 * The webhook signing-secret keyring, read from the environment (TASKS V2-G2;
 * docs/WEBHOOKS.md).
 *
 * The same shape and rules as the zone-centre keyring (`zones-config.ts`), under its own
 * three variables, because it is a different key with a different blast radius: a leaked
 * zone key exposes where people watch, a leaked webhook key lets someone forge alerts to
 * every integrator. Keeping them apart means either can be rotated without the other.
 *
 *   * FIRE_WATCH_WEBHOOK_KEY_ID + FIRE_WATCH_WEBHOOK_KEY — the active key, together or not
 *     at all. The id is what each `webhook_endpoints.secret_key_id` names; the key is
 *     standard base64 of exactly 32 bytes.
 *   * FIRE_WATCH_WEBHOOK_KEYS_RETIRED — optional, `id:base64,id:base64`. Open-only keys:
 *     an endpoint sealed under one keeps working until its secret is rotated, which reseals
 *     it under the active key. There is no bulk re-encryption job for webhook secrets yet.
 *
 * Unset returns `null`, and each process decides what that means: the API does not
 * register the webhook routes, and the worker does not offer the `webhook` channel. Never
 * "store or send secrets in clear".
 *
 * No value reaches an error or a log line; {@link describeWebhooksConfig} prints key ids
 * only. Parsing is shared with the zone and TOTP keyrings (`keyring-env.ts`).
 */

import type { WebhookSealKeyring } from '../adapters/crypto/aes-gcm-webhook-secret-sealer.js';
import type { Environment } from './config.js';
import { readKeyringEnv } from './keyring-env.js';

export function loadWebhooksConfig(env: Environment): WebhookSealKeyring | null {
  return readKeyringEnv(env, {
    id: 'FIRE_WATCH_WEBHOOK_KEY_ID',
    key: 'FIRE_WATCH_WEBHOOK_KEY',
    retired: 'FIRE_WATCH_WEBHOOK_KEYS_RETIRED',
  });
}

/** Safe to print: key ids are labels; the keys themselves never leave the keyring. */
export function describeWebhooksConfig(
  keyring: WebhookSealKeyring | null,
): Record<string, unknown> {
  if (keyring === null) return { webhook_keys: 'unset' };
  return {
    webhook_key_active: keyring.active.id,
    webhook_keys_retired: keyring.retired.map((key) => key.id),
  };
}
