/**
 * An in-memory payload store that can also be read back, for the F15 tests. Core tests may
 * not import `node:crypto`, so the "sha256" is a 64-hex-digit FNV-1a spread: not a real
 * digest, but it has the shape the sidecar check demands and changes with every byte.
 */

import type { PayloadRead, PayloadReader } from '../../ports/payload-reader.js';
import type { PayloadStore, PayloadWriteResult } from '../../ports/payload-store.js';

export function fakeSha256(bytes: Uint8Array): string {
  let out = '';
  for (let seed = 0; seed < 8; seed += 1) {
    let hash = (0x811c9dc5 ^ seed) >>> 0;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    out += hash.toString(16).padStart(8, '0');
  }
  return out;
}

export class MemoryPayloads implements PayloadStore, PayloadReader {
  readonly files = new Map<string, Uint8Array>();
  /** Paths matching this throw on write — a full disk, a permission error. */
  failWritesOn: RegExp | null = null;
  existsThrows = false;
  /** Reads of paths matching this throw — a store that has gone away. */
  failReadsOn: RegExp | null = null;
  readonly writes: string[] = [];

  exists(relativePath: string): Promise<boolean> {
    if (this.existsThrows) return Promise.reject(new Error('stat failed'));
    return Promise.resolve(this.files.has(relativePath));
  }

  writePayload(relativePath: string, bytes: Uint8Array): Promise<PayloadWriteResult> {
    if (this.failWritesOn?.test(relativePath) === true) {
      return Promise.reject(new Error(`disk full: ${relativePath}`));
    }
    this.files.set(relativePath, bytes.slice());
    this.writes.push(relativePath);
    return Promise.resolve({ bytes: bytes.byteLength, sha256: fakeSha256(bytes) });
  }

  writeText(relativePath: string, text: string): Promise<PayloadWriteResult> {
    return this.writePayload(relativePath, new TextEncoder().encode(text));
  }

  readPayload(relativePath: string): Promise<PayloadRead | null> {
    if (this.failReadsOn?.test(relativePath) === true) {
      return Promise.reject(new Error(`read failed: ${relativePath}`));
    }
    const bytes = this.files.get(relativePath);
    if (bytes === undefined) return Promise.resolve(null);
    return Promise.resolve({ bytes: bytes.slice(), sha256: fakeSha256(bytes) });
  }

  async readText(relativePath: string): Promise<string | null> {
    const read = await this.readPayload(relativePath);
    return read === null ? null : new TextDecoder().decode(read.bytes);
  }

  text(relativePath: string): string | undefined {
    const bytes = this.files.get(relativePath);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }
}
