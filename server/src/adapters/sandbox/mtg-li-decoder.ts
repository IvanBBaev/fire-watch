/**
 * The MTG LI LFL decoder (TASKS F18): the same wall as the LSA SAF decoder — a separate
 * process under the Node permission model, a WebAssembly memory ceiling, no code from
 * strings — pointed at `mtg-li-flash-decoder.ts`.
 *
 * Only the entry and the ref type differ from `createH5wasmDecoder`; the command line is
 * `decoderArgs`, so both children get exactly the same grants and ceilings.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BoundingBox } from '../../core/config/polling-bbox.js';
import type { LightningDecoder, LightningGranuleRef } from '../../core/ports/lightning-decoder.js';
import { createChildProcessDecoder } from './child-process-decoder.js';
import { decoderArgs } from './h5wasm-decoder.js';

export interface MtgLiDecoderOptions {
  /** Defaults to the compiled `mtg-li-flash-decoder.js`; tests use the `.ts` source. */
  readonly entry?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxInputBytes?: number;
  readonly wasmMemoryMiB?: number;
  readonly heapMiB?: number;
  /** Flashes outside this box are dropped in the child (the polling box). */
  readonly clip?: BoundingBox | null;
}

export function createMtgLiDecoder(options: MtgLiDecoderOptions = {}): LightningDecoder {
  const entry = resolve(
    options.entry ?? fileURLToPath(new URL('./mtg-li-flash-decoder.js', import.meta.url)),
  );
  const env: Record<string, string> = {};
  if (options.clip) env['FW_DECODE_CLIP'] = JSON.stringify(options.clip);
  if (options.maxInputBytes !== undefined) {
    env['FW_DECODE_MAX_INPUT_BYTES'] = String(options.maxInputBytes);
  }
  return createChildProcessDecoder<LightningGranuleRef>({
    command: process.execPath,
    args: decoderArgs(entry, {
      ...(options.wasmMemoryMiB === undefined ? {} : { wasmMemoryMiB: options.wasmMemoryMiB }),
      ...(options.heapMiB === undefined ? {} : { heapMiB: options.heapMiB }),
    }),
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
}
