/**
 * VAPID (RFC 8292) — how a push service knows the request came from us.
 *
 * A push endpoint is a capability URL: anyone holding it can post to it. VAPID is the
 * countermeasure — the subscription was created with our public key, and the push
 * service accepts only requests carrying an ES256 JWT signed by the matching private
 * key. That private key is the tier-0 secret of the whole alert channel (08 §5.4.3,
 * OPERATIONS §3): rotating it invalidates every subscription, so this module takes it
 * once, at construction, and never exports, logs or stringifies it.
 *
 * Done with `node:crypto` rather than a library because the whole of it is: one JWT
 * header, three claims, one P-256 signature in the IEEE P1363 (`r || s`) form JWTs use
 * rather than the DER form `sign()` produces by default. A dependency for that would
 * be a dependency holding the tier-0 secret.
 */

import { createECDH, createPrivateKey, sign, type KeyObject } from 'node:crypto';

export interface VapidKeys {
  /** 65-byte uncompressed P-256 point, base64url — what the client passes to `subscribe`. */
  readonly publicKey: string;
  /** 32-byte P-256 scalar, base64url. Never leaves this process. */
  readonly privateKey: string;
  /** `mailto:` or `https:` contact the push service may use about us (RFC 8292 §2.1). */
  readonly subject: string;
}

export interface VapidSigner {
  /** The public key as the client needs it, for the `/api/push/public-key` route. */
  readonly publicKey: string;
  /** The `Authorization` header value for a request to a push endpoint at `audience`. */
  authorizationFor(audience: string, now: number): string;
}

/**
 * Token lifetime. RFC 8292 caps `exp` at 24 h from issue; push services reject longer.
 * Half of that leaves a rotated clock or a slow queue nowhere near the edge.
 */
export const VAPID_TOKEN_TTL_MS = 12 * 3_600_000;
/** A cached token is reissued once this much of its life is gone. */
const VAPID_TOKEN_REUSE_MS = 6 * 3_600_000;

const JWT_HEADER = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));

export function createVapidSigner(keys: VapidKeys): VapidSigner {
  const publicKeyBytes = decodePublicKey(keys.publicKey);
  const privateKey = decodePrivateKey(keys.privateKey, publicKeyBytes);
  assertSubject(keys.subject);

  const cache = new Map<string, { readonly token: string; readonly issuedAt: number }>();

  return {
    publicKey: keys.publicKey,
    authorizationFor(audience: string, now: number): string {
      const cached = cache.get(audience);
      const token =
        cached !== undefined && now - cached.issuedAt < VAPID_TOKEN_REUSE_MS
          ? cached.token
          : issue(audience, now);
      if (cached?.token !== token) cache.set(audience, { token, issuedAt: now });
      return `vapid t=${token}, k=${keys.publicKey}`;
    },
  };

  function issue(audience: string, now: number): string {
    const claims = {
      aud: audience,
      exp: Math.floor((now + VAPID_TOKEN_TTL_MS) / 1000),
      sub: keys.subject,
    };
    const signingInput = `${JWT_HEADER}.${base64url(Buffer.from(JSON.stringify(claims), 'utf8'))}`;
    const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${base64url(signature)}`;
  }
}

/**
 * The audience is the push endpoint's origin — scheme and host, nothing else (RFC 8292
 * §2). A token minted for one push service is useless at another, which is why the
 * cache above is keyed on it.
 */
export function vapidAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * Builds a private-key object from the raw scalar, using the public point for the `x`
 * and `y` a JWK requires — and then checks that the point really is that scalar's. A
 * mismatched pair (a rotated private key with last season's public key still in the
 * env) would sign tokens every push service rejects, and the failure would look like a
 * provider outage rather than the config error it is.
 */
function decodePrivateKey(privateKey: string, publicKeyBytes: Buffer): KeyObject {
  const d = fromBase64url(privateKey);
  if (d.length !== 32) {
    throw new RangeError(
      `VAPID private key must decode to 32 bytes, got ${String(d.length)} — expected the base64url scalar`,
    );
  }
  // Recompute the point from the scalar: `createPrivateKey` takes a JWK's `x`/`y` on
  // trust, so the comparison has to be against a derivation, not an export.
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  if (!ecdh.getPublicKey(null, 'uncompressed').equals(publicKeyBytes)) {
    throw new RangeError('VAPID public key does not belong to the VAPID private key');
  }
  const x = publicKeyBytes.subarray(1, 33);
  const y = publicKeyBytes.subarray(33, 65);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: base64url(d), x: base64url(x), y: base64url(y) },
    format: 'jwk',
  });
}

function decodePublicKey(publicKey: string): Buffer {
  const bytes = fromBase64url(publicKey);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new RangeError(
      `VAPID public key must decode to a 65-byte uncompressed P-256 point, got ${String(bytes.length)} bytes`,
    );
  }
  return bytes;
}

function assertSubject(subject: string): void {
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
    throw new RangeError('VAPID subject must be a mailto: address or an https: URL');
  }
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64url(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) {
    throw new RangeError('expected base64url');
  }
  return Buffer.from(text, 'base64url');
}
