/**
 * Message encryption for web push — RFC 8291, over the `aes128gcm` content coding of
 * RFC 8188.
 *
 * The push service is a relay that must not read the alert, so the payload is encrypted
 * to the subscription's own key pair: ECDH between a fresh ephemeral key of ours and the
 * browser's `p256dh` public key, mixed with the browser's `auth` secret through HKDF,
 * then AES-128-GCM over a single record. The result is a self-describing body — salt,
 * record size, our ephemeral public key, ciphertext — and the browser needs nothing else
 * to decrypt it.
 *
 * Every step is the RFC's, in the RFC's order and with the RFC's info strings, and the
 * test pins the output against RFC 8291 Appendix A byte for byte: the salt and the
 * ephemeral key are injectable precisely so that the vector can be reproduced, and in
 * production both come from `randomBytes`.
 */

import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

/** The decoded half of a `PushSubscriptionJSON` that the cipher needs. */
export interface SubscriptionKeys {
  /** 65-byte uncompressed P-256 point (`keys.p256dh`). */
  readonly p256dh: Uint8Array;
  /** 16-byte authentication secret (`keys.auth`). */
  readonly auth: Uint8Array;
}

export interface EncryptOptions {
  /** Test seam only: RFC 8291 Appendix A supplies fixed values for these. */
  readonly salt?: Uint8Array;
  /** Test seam only: the application server's ephemeral private scalar. */
  readonly ephemeralPrivateKey?: Uint8Array;
}

/**
 * Push services cap the request body at 4096 bytes (RFC 8030 §7.2 recommends at least
 * that; FCM, Mozilla and Apple all enforce exactly it). This is the ciphertext-body
 * limit; the plaintext must leave room for the 86-byte header and 17 bytes of record
 * overhead.
 */
export const MAX_PUSH_BODY_BYTES = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;
const RECORD_OVERHEAD_BYTES = 1 + 16; // padding delimiter + GCM tag
export const MAX_PUSH_PLAINTEXT_BYTES = MAX_PUSH_BODY_BYTES - HEADER_BYTES - RECORD_OVERHEAD_BYTES;

const RECORD_SIZE = 4096;
const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0', 'utf8');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8');

/**
 * Encrypts `plaintext` for the subscription. Throws `RangeError` for keys of the wrong
 * shape or a plaintext that cannot fit one record — both are caller errors decided
 * before any network call, and the channel adapter turns them into a `permanent`
 * outcome.
 */
export function encryptForSubscription(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  options: EncryptOptions = {},
): Buffer {
  if (keys.p256dh.length !== 65 || keys.p256dh[0] !== 0x04) {
    throw new RangeError('p256dh must be a 65-byte uncompressed P-256 point');
  }
  if (keys.auth.length !== 16) {
    throw new RangeError('auth must be 16 bytes');
  }
  if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new RangeError(
      `plaintext is ${String(plaintext.length)} bytes; at most ${String(MAX_PUSH_PLAINTEXT_BYTES)} fit one push`,
    );
  }
  const salt = options.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new RangeError('salt must be 16 bytes');

  // Ephemeral application-server key pair, one per message (RFC 8291 §3.1).
  const ecdh = createECDH('prime256v1');
  if (options.ephemeralPrivateKey === undefined) {
    ecdh.generateKeys();
  } else {
    ecdh.setPrivateKey(Buffer.from(options.ephemeralPrivateKey));
  }
  const asPublic = ecdh.getPublicKey(null, 'uncompressed');
  const uaPublic = Buffer.from(keys.p256dh);
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3–3.4: auth secret → IKM, then RFC 8188 §2.2: IKM → CEK and nonce.
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, Buffer.from(keys.auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, NONCE_INFO, 12));

  // One record, last-record delimiter 0x02, no padding: the plaintext is already sized
  // to fit and padding a fire alert to a fixed length buys nothing against a relay
  // that already knows it is a fire alert.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // RFC 8188 §2.1 header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(idlen).
  const header = Buffer.alloc(HEADER_BYTES);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return Buffer.concat([header, record]);
}
