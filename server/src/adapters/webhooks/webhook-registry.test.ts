import { describe, expect, it } from 'vitest';

import { WEBHOOK_PARAMS } from '../../core/config/webhook-params.js';
import type {
  NewWebhookEndpoint,
  SealedSecret,
  WebhookEndpointStore,
  WebhookEndpointView,
  WebhookSecretSealer,
} from '../../core/ports/webhook-store.js';
import { createWebhookRegistry, WebhookRegistrationError } from './webhook-registry.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const ACCOUNT = '35353535-0000-4000-8000-0000000000bb';
const ENDPOINT = '35353535-0000-4000-8000-0000000000aa';
const PARAMS = WEBHOOK_PARAMS.values;

/** The n-th placeholder the stub generator hands out; never a credential. */
const placeholder = (n: number): string => ['whsec', 'placeholder', String(n)].join('_');

function view(id: string): WebhookEndpointView {
  return {
    id,
    url: 'https://hooks.example-receiver.com/in',
    createdAtMs: NOW,
    secretRotatedAtMs: NOW,
    confirmed: false,
    disabledAtMs: null,
    disabledReason: null,
    consecutiveFailures: 0,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
  };
}

function setup(opts: { addresses?: readonly string[] | Error; full?: boolean } = {}) {
  const created: { endpoint: NewWebhookEndpoint; limit: number }[] = [];
  const rotated: { endpointId: string; sealed: SealedSecret }[] = [];
  const resolved: string[] = [];
  const sealed: { endpointId: string; plaintext: string }[] = [];
  const drawn: number[] = [];
  const store: WebhookEndpointStore = {
    create(endpoint, limit) {
      created.push({ endpoint, limit });
      return Promise.resolve(opts.full !== true);
    },
    list: () => Promise.resolve([view(ENDPOINT)]),
    get: (accountId, endpointId) =>
      Promise.resolve(accountId === ACCOUNT && endpointId === ENDPOINT ? view(ENDPOINT) : null),
    remove: (accountId, endpointId) =>
      Promise.resolve(accountId === ACCOUNT && endpointId === ENDPOINT),
    rotateSecret(_accountId, endpointId, seal) {
      rotated.push({ endpointId, sealed: seal });
      return Promise.resolve(true);
    },
  };
  const sealer: WebhookSecretSealer = {
    seal(endpointId, plaintext) {
      sealed.push({ endpointId, plaintext });
      return { ciphertext: new Uint8Array(60), keyId: 'k1' };
    },
    open() {
      throw new Error('not used');
    },
  };
  const addresses = opts.addresses ?? ['93.184.216.34'];
  const registry = createWebhookRegistry({
    store,
    sealer,
    params: PARAMS,
    resolver: {
      resolve(host) {
        resolved.push(host);
        return addresses instanceof Error ? Promise.reject(addresses) : Promise.resolve(addresses);
      },
    },
    newId: () => ENDPOINT,
    newSecret: (bytes) => {
      drawn.push(bytes);
      return placeholder(drawn.length);
    },
  });
  return { registry, created, rotated, resolved, sealed, drawn };
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof WebhookRegistrationError) return error.refusal;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('createWebhookRegistry', () => {
  it('registers a normalised URL with a sealed secret it returns once', async () => {
    const { registry, created, sealed, resolved, drawn } = setup();
    const result = await registry.create(ACCOUNT, 'https://Hooks.Example-Receiver.com/in', NOW);
    expect(resolved).toEqual(['hooks.example-receiver.com']);
    expect(drawn).toEqual([PARAMS.secretBytes]);
    expect(result.secret).toBe(placeholder(1));
    expect(sealed).toEqual([{ endpointId: ENDPOINT, plaintext: placeholder(1) }]);
    expect(created[0]).toMatchObject({
      limit: PARAMS.maxEndpointsPerAccount,
      endpoint: { id: ENDPOINT, accountId: ACCOUNT, url: 'https://hooks.example-receiver.com/in' },
    });
    expect(result.endpoint).toMatchObject({ id: ENDPOINT, confirmed: false, disabledAtMs: null });
  });

  it('refuses a URL the guard rejects without resolving or storing it', async () => {
    const { registry, created, resolved } = setup();
    expect(await refusal(registry.create(ACCOUNT, 'http://hooks.example.com/in', NOW))).toEqual({
      kind: 'url_invalid',
      reason: 'not_https',
    });
    expect(await refusal(registry.create(ACCOUNT, 'https://10.1.2.3/in', NOW))).toEqual({
      kind: 'url_invalid',
      reason: 'private_address',
    });
    expect(resolved).toEqual([]);
    expect(created).toEqual([]);
  });

  it('refuses a name that resolves privately or not at all', async () => {
    const internal = setup({ addresses: ['93.184.216.34', '10.0.0.5'] });
    expect(
      await refusal(internal.registry.create(ACCOUNT, 'https://hooks.example.com/in', NOW)),
    ).toEqual({ kind: 'url_invalid', reason: 'private_address' });
    const missing = setup({ addresses: new Error('ENOTFOUND') });
    expect(
      await refusal(missing.registry.create(ACCOUNT, 'https://hooks.example.com/in', NOW)),
    ).toEqual({ kind: 'url_invalid', reason: 'unresolvable' });
    expect([...internal.created, ...missing.created]).toEqual([]);
  });

  it('refuses past the per-account cap', async () => {
    const { registry } = setup({ full: true });
    expect(await refusal(registry.create(ACCOUNT, 'https://hooks.example.com/in', NOW))).toEqual({
      kind: 'limit_reached',
      limit: PARAMS.maxEndpointsPerAccount,
    });
  });

  it('rotates to a fresh sealed secret, and answers null for a foreign endpoint', async () => {
    const { registry, rotated, sealed } = setup();
    const result = await registry.rotateSecret(ACCOUNT, ENDPOINT, NOW);
    expect(result?.secret).toBe(placeholder(1));
    expect(result?.rotatedAtMs).toBe(NOW);
    expect(sealed).toEqual([{ endpointId: ENDPOINT, plaintext: placeholder(1) }]);
    expect(rotated).toHaveLength(1);
    expect(
      await registry.rotateSecret('35353535-0000-4000-8000-0000000000dd', ENDPOINT, NOW),
    ).toBeNull();
    expect(rotated).toHaveLength(1);
  });
});
