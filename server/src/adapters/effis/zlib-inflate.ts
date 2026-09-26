/**
 * Adapter: the `Inflate` port over node:zlib (TASKS G4).
 *
 * `maxOutputLength` makes zlib itself stop at the cap (it throws a RangeError), so a
 * decompression bomb never materialises past one image's worth of memory. Every
 * failure — corrupt data, truncation, cap exceeded — maps to `null` per the port.
 */

import { inflateSync } from 'node:zlib';

import type { Inflate } from '../../core/ports/inflate.js';

export const zlibInflate: Inflate = (compressed, maxOutputBytes) => {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) return null;
  try {
    // zlib rejects a zero cap; an empty image stream is still a valid zlib stream.
    const out = inflateSync(compressed, { maxOutputLength: Math.max(1, maxOutputBytes) });
    if (out.byteLength > maxOutputBytes) return null;
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    return null;
  }
};
