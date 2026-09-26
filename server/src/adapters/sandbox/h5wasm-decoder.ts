/**
 * The h5wasm granule decoder (TASKS C3a), assembled from the existing wall and the Node
 * permission model.
 *
 * `createChildProcessDecoder` already supplies the parts of E3 (review 05 §5.6.2) a parent
 * process can supply: a separate process, an environment built from nothing, a deadline
 * that kills the process group, and a cap on what comes back. This factory adds what the
 * *child's runtime* can supply on top, so that a granule which gets code execution inside
 * libhdf5 lands somewhere with very little reach:
 *
 * - **`--permission`** with read access to the decoder's own file, its `bunzip2` sibling
 *   and the h5wasm package, and nothing else. No filesystem writes, no child processes, no worker threads, no
 *   native addons. (On Node 22 the permission model does **not** cover the network —
 *   `--allow-net` arrives in a later release — so outbound network is still the
 *   container's job; see `docs/spikes/c3a-granule-decode.md`.)
 * - **`--wasm-max-mem-pages`**: a hard ceiling on the WebAssembly linear memory libhdf5
 *   runs in. A chunk that inflates to more than this is a failed allocation inside the
 *   module, not a host that swaps.
 * - **`--max-old-space-size`**: the same for the JavaScript heap the decoded rows live in.
 * - **`--disallow-code-generation-from-strings`**: no `eval`, no `new Function` — the
 *   decoder never needs them, so a compromise does not get them either.
 *
 * None of this replaces the container limits E3 asks for (cgroup memory and CPU, no
 * network, read-only root, no DB credentials in the environment). It is what can be had
 * without them, and what still holds on a developer laptop.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BoundingBox } from '../../core/config/polling-bbox.js';
import type { GranuleDecoder } from '../../core/ports/granule-decoder.js';
import { createChildProcessDecoder } from './child-process-decoder.js';

export interface H5wasmDecoderOptions {
  /**
   * The decoder program. Defaults to the compiled `lsa-frp-pixel-decoder.js` beside this
   * file; tests point it at the TypeScript source, which Node runs with its types stripped.
   */
  readonly entry?: string;
  /** Wall-clock budget per granule. The wall's default is 60 s. */
  readonly timeoutMs?: number;
  /** Cap on the payload text the child may write. */
  readonly maxOutputBytes?: number;
  /** Cap on the granule bytes the child will accept on stdin — packed, if it is `.bz2`. */
  readonly maxInputBytes?: number;
  /** Cap on what a `.bz2` granule may unpack to. The child's default is 128 MiB. */
  readonly maxUnpackedBytes?: number;
  /** Cap on unpacked ÷ packed size above the child's 32 MiB floor. Its default is 1000. */
  readonly maxUnpackRatio?: number;
  /** WebAssembly memory ceiling, in MiB. Rounded down to whole 64 KiB pages. */
  readonly wasmMemoryMiB?: number;
  /** V8 old-space ceiling for the child, in MiB. */
  readonly heapMiB?: number;
  /**
   * A pre-filter window with a margin around the polling box. It is an optimisation that
   * keeps a full-disk list under the payload cap; the poller's own bbox test still rules.
   */
  readonly clip?: BoundingBox | null;
}

/**
 * 512 MiB of WebAssembly memory. A full-disk SEVIRI grid of int16 is 27 MiB and a list
 * product is kilobytes; the ceiling exists for the file that *claims* to be something
 * else, and 512 is far enough above any honest granule to never be the reason one fails.
 */
export const DEFAULT_WASM_MEMORY_MIB = 512;
export const DEFAULT_HEAP_MIB = 256;

/** WebAssembly pages are 64 KiB. */
const WASM_PAGE_BYTES = 64 * 1024;

export function createH5wasmDecoder(options: H5wasmDecoderOptions = {}): GranuleDecoder {
  const entry = resolve(
    options.entry ?? fileURLToPath(new URL('./lsa-frp-pixel-decoder.js', import.meta.url)),
  );
  const env: Record<string, string> = {};
  if (options.clip) env['FW_DECODE_CLIP'] = JSON.stringify(options.clip);
  if (options.maxInputBytes !== undefined) {
    env['FW_DECODE_MAX_INPUT_BYTES'] = String(options.maxInputBytes);
  }
  if (options.maxUnpackedBytes !== undefined) {
    env['FW_DECODE_MAX_UNPACKED_BYTES'] = String(options.maxUnpackedBytes);
  }
  if (options.maxUnpackRatio !== undefined) {
    env['FW_DECODE_MAX_UNPACK_RATIO'] = String(options.maxUnpackRatio);
  }

  return createChildProcessDecoder({
    command: process.execPath,
    args: decoderArgs(entry, options),
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
}

/** The child's command line. Exported so the flags can be asserted without a process. */
export function decoderArgs(entry: string, options: H5wasmDecoderOptions = {}): string[] {
  const wasmPages = Math.floor(
    ((options.wasmMemoryMiB ?? DEFAULT_WASM_MEMORY_MIB) * 1024 * 1024) / WASM_PAGE_BYTES,
  );
  // Node resolves the entry with a component-by-component realpath, and under the
  // permission model every symlinked component on the way (macOS's /var → /private/var)
  // would need its own grant. Handing it the resolved path avoids granting any of them.
  const real = existsSync(entry) ? realpathSync(entry) : entry;
  const readable = [real, ...siblingPaths(real), ...h5wasmPaths(dirname(real))];
  return [
    '--permission',
    ...readable.map((path) => `--allow-fs-read=${path}`),
    `--wasm-max-mem-pages=${String(wasmPages)}`,
    `--max-old-space-size=${String(options.heapMiB ?? DEFAULT_HEAP_MIB)}`,
    '--disallow-code-generation-from-strings',
    real,
  ];
}

/**
 * The decompressor the child loads beside itself, with the child's own extension (`.ts`
 * from the source, `.js` from the build) — granted only when it is actually there, so an
 * entry without one (the sandbox-escape probes) is granted nothing extra.
 */
function siblingPaths(entry: string): string[] {
  const sibling = join(dirname(entry), `bunzip2${extname(entry)}`);
  return existsSync(sibling) ? [sibling] : [];
}

/**
 * What the child must be able to read to `import 'h5wasm'`: the package itself, and — with
 * pnpm — the `node_modules/h5wasm` symlink the resolver walks through on its way there.
 * The permission model checks the path as written before it follows the link, so both
 * have to be named.
 */
function h5wasmPaths(from: string): string[] {
  const real = dirname(dirname(dirname(fileURLToPath(import.meta.resolve('h5wasm')))));
  const paths = [real];
  for (let dir = from; ; dir = dirname(dir)) {
    const link = join(dir, 'node_modules', 'h5wasm');
    if (existsSync(link)) {
      if (link !== real) paths.push(link);
      break;
    }
    if (dirname(dir) === dir) break;
  }
  return paths;
}
