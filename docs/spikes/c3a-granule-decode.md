# Spike C3a — Granule decode: h5wasm in the sandboxed child vs a Python sidecar

**Status: done-when NOT met.** No real LSA-502 granule has been decoded yet. There are
no EUMETSAT / LSA SAF credentials (EXTERNAL-ACCOUNTS), so all the evidence below comes
from **synthetic** HDF5 files built from our own reading of the product layout. The
outcome doc exists. The second half of the done-when, "one real LSA-502 granule decodes
to a `fire-watch.granule.v1` payload", is still open.

**Question.** What should turn LSA SAF HDF5 bytes (LSA-502 SEVIRI FRP-PIXEL; later
LSA-509 FCI netCDF-4) into the payload the C3 reader accepts? The two options are
h5wasm (libhdf5 compiled to WebAssembly) run in the existing sandboxed child process,
or a Python sidecar (h5py/netCDF4) behind the same `GranuleDecoder` port. The comparison
covers decode time per slot, image size, and what each does to the E3 containment
argument.

**Decision.** Use **h5wasm 0.10.3 in the existing child-process wall**, run as a Node
child under the permission model, and keep the Python sidecar as Plan B. The decoder is
implemented behind the existing port as `createH5wasmDecoder`. It reads the LSA-502
*list* product, plain or `.bz2`, and is covered by 45 tests against synthetic granules
plus 26 for its bzip2 decompressor. It is not wired into the worker, because without a
real granule it has nothing to decode.

## What was built

| File | Role |
|---|---|
| `server/src/adapters/sandbox/lsa-frp-pixel-decoder.ts` | The child program. Reads stdin (capped), unpacks `.bz2`, and writes one payload to stdout, with exit 65 for a refusal and 70 for a WebAssembly trap. Its reason goes to stderr as a `fw-decoder-reason:` line. It has only `import type` dependencies on the rest of the server, plus its `bunzip2` sibling loaded with its own extension, so the same file runs from source in tests and from `dist/` in production. |
| `server/src/adapters/sandbox/bunzip2.ts` | A bounded bzip2 decompressor, written for this (see "bzip2" below). No imports; runs only inside the child. |
| `server/src/adapters/sandbox/h5wasm-decoder.ts` | `createH5wasmDecoder(options)`, which wraps `createChildProcessDecoder` with `process.execPath` and the permission flags. `decoderArgs()` is exported so the flags can be asserted without starting a process. |
| `server/src/adapters/sandbox/lsa-502-synthetic.ts` | Test support: writes synthetic LSA-502 list granules and full-disk grids with h5wasm. |
| `…/lsa-frp-pixel-decoder.test.ts` (29), `…/h5wasm-decoder.test.ts` (16) | In-process decode and refusal tests, plus child end-to-end and sandbox-escape tests. |
| `…/bunzip2.test.ts` (26) | Round trips against the system `bzip2` 1.0.8, damage, multistream and caps. |
| `…/child-process-decoder.ts` (+3 tests) | The wall now finds the child's `fw-decoder-reason:` line and puts it first. |

The dependency is `h5wasm` **0.10.3**, pinned exactly (`pnpm add -E`) in `server/package.json`.
bzip2 adds **no dependency**.

### Decoder behaviour

- **What is read.** Only the **list** product, which already holds one fire pixel per
  row. The full-disk quality grid is not read.
- **Datasets:**
  - required: `LATITUDE`, `LONGITUDE`, `FRP`, `FIRE_CONFIDENCE`;
  - optional: `BT_MIR` (→ `brightnessK`) and `BW_BT_MIR` (→ `brightnessBgK`);
  - anything else in the file is never opened.
- **Scaling.** Each dataset is a 1-D integer array. Physical value = raw / `SCALING_FACTOR`,
  and `MISSING_VALUE` becomes `null`.
- **Refusals for the attributes.** A zero scale is refused. A non-zero `OFFSET` is also
  refused until a real granule shows the sign convention.
- **Metadata checks come first.** Before `.value` is read, the decoder checks that each
  object is:
  - a dataset, not a VDS;
  - a numeric type;
  - an integer of at most 32 bits;
  - 1-D, with a declared length within `MAX_LIST_PIXELS` (200,000).

  All the required columns must have the same length.
- **Slot.** The slot comes from the root attribute `IMAGE_ACQUISITION_TIME` and must equal
  the slot the granule was fetched as, otherwise the granule is refused. `acq` is the slot
  time, because per-pixel scan time is not used (see the open questions).
- **Confidence.** `FIRE_CONFIDENCE` is a probability from 0 to 1:
  - ≥ 0.8 → `high`;
  - ≥ 0.5 → `nominal`;
  - otherwise `low`.

  `confidenceRaw` keeps the probability. These thresholds are **provisional** and need a
  data-science review.
- **Dropped and clipped rows.** The following are dropped and counted in the payload's
  `decoder` block (the reader ignores that block):
  - rows with no position, or with an out-of-range position;
  - rows with no confidence.

  An optional clip window (`FW_DECODE_CLIP`, the polling bbox) filters rows before the
  payload is written, so a busy full disk stays under the reader's 1,000,000-char cap.
- **bzip2.** A granule that starts with `BZh` is unpacked in the child before libhdf5
  sees it (see "bzip2" below). The `decoder` block records `compression`,
  `packedBytes` and `hdf5Bytes`.
- **Other refusals:**
  - a `.bz2` that is truncated, corrupt, over a cap, not HDF5 inside, or bzip2 inside
    bzip2;
  - input that is not HDF5;
  - a kind other than `frp`;
  - `lsasaf:fci:frp-pixel`, because the LSA-509 layout is unknown.
- **libhdf5 errors.** When libhdf5 throws while opening the file, the granule is refused.
  A `WebAssembly.RuntimeError` (a trap) exits 70, which the wall records as `crashed`.
- **Reasons survive libhdf5's stderr.** The child writes its reason as the last stderr
  line, prefixed `fw-decoder-reason: `. The wall keeps the first 8 KiB of stderr and a
  rolling last 4 KiB, takes the last such line, and builds the error as
  `decoder rejected the granule: <reason> [stderr: <the rest>]`. The 500-char cap then
  trims libhdf5's `HDF5-DIAG` stack, not the reason. Before this, a truncated file was
  recorded as 500 chars of `HDF5-DIAG` with the child's reason cut off.

### bzip2

LSA SAF ships the files as `.bz2`, and Node has no bzip2. The file is unpacked **inside
the child**, behind the wall and the permission model, never in the fetch adapter.

**Why not a library.** The candidates that were checked, and why each was turned down:

| Package | Licence | Why not |
|---|---|---|
| `seek-bzip` 2.0.0 | MIT | A stream cut after its last complete block (end-of-stream marker and stream CRC gone) decodes as **success**. It reads past the end as zero bits, depends on `commander` at runtime, and prints a `Buffer()` deprecation warning (DEP0005) on every run. |
| `unbzip2-stream` 1.4.3 | MIT | The same `bzip2.js` lineage, stream-shaped, with runtime deps `buffer` and `through`. |
| `bz2` (SheetJS) 1.0.1 | MIT | Returns the whole output in one go, so there is no way to stop a bomb part-way. |
| `compressjs` | GPL | Licence. |
| `@foxglove/wasm-bz2` 0.3.0 | MIT | Real libbzip2 in wasm, but the output size must be allocated up front, the child would need read access to its `.wasm`, and it needs async init and `tslib`. |

So `bunzip2.ts` is our own: about 500 lines, the bzip2 1.0.x algorithm with no imports.
It is tested byte-for-byte against the system `bzip2` 1.0.8, which is on the macOS dev
machines and on the Ubuntu CI runner. One inline base64 fixture runs without the binary.

**What it guarantees:**

- **Output caps**, both checked before each run is written, so a bomb is stopped at the
  cap and never fully built. The output buffer grows by doubling and is never allocated
  up front at the cap size.
  - An absolute cap: `FW_DECODE_MAX_UNPACKED_BYTES`, default **128 MiB**.
  - A ratio cap: `FW_DECODE_MAX_UNPACK_RATIO`, default **1000×**. It only applies above a
    **32 MiB** floor, because small padded HDF5 compresses by absurd ratios honestly.
  - Tested: 64 MiB of zeros (about 50 bytes packed) stops at an 8 MiB cap. 48 MiB of
    zeros stops on the ratio under the default caps. Both exit 65 with the cap as the
    reason.
- **Nothing accepted silently.**
  - Every block CRC and every stream CRC is checked.
  - Input that ends anywhere before the end-of-stream marker is `truncated`. That
    includes a cut on a block boundary, which is exactly the case `seek-bzip` accepts.
  - A bit-flip sweep over a whole stream is tested: every flip is either refused with
    the decoder's own error, or decodes to exactly what the system `bzip2` decodes.
- **Multistream follows `bzip2 -d`.** Concatenated streams (`cat a.bz2 b.bz2`, or what
  `pbzip2` writes) decode to the concatenation of their contents. All the streams count
  against the same caps.
  - Bytes after the last stream that are not another stream are **refused**. The
    `bzip2` CLI only warns about trailing garbage; here the choice is strict.
  - A `.bz2` that unpacks to another bzip2 stream is refused.
- **Obsolete modes refused.** Randomised blocks (bzip2 before 0.9.5, 1999) are not
  supported.
- **Reach.** `decoderArgs()` grants `--allow-fs-read` for exactly one more file: the
  `bunzip2` sibling with the entry's own extension, and only when that file exists. The
  sandbox-escape probes get no extra grant. The input cap (`FW_DECODE_MAX_INPUT_BYTES`,
  64 MiB) applies to the packed bytes.
- **Cost.** Not benchmarked. A list granule is small, and the bomb tests (up to 64 MiB
  of output) run within the ordinary test timeouts.

## Measurements

The runs were on an Apple-silicon Mac with Node 22.23.2, three runs each. Other agents
were busy on the machine at the same time, so read the spread as noise. The child was run
exactly as `createH5wasmDecoder` runs it (`--permission`, fs-read allowlist, 512 MiB wasm
cap, 256 MiB heap, no code generation). Python means CPython 3.9.6 with h5py 3.14.0
(HDF5 1.14.6) and numpy 2.0.2. Peak RSS comes from `/usr/bin/time -l`.

Synthetic inputs, written by `lsa-502-synthetic.ts`:

| Granule | Size | Content |
|---|---|---|
| list-500 | 23 KB | 500 fire pixels |
| list-6000 | 46 KB | 6,000 pixels, well above a busy SEVIRI slot |
| grid 3712² | 13.5 MB | SEVIRI full-disk int16, gzip 4, 464² chunks, noise field |
| grid 5568² | 30.2 MB | FCI-sized full-disk int16, same encoding |

End to end (process start → exit):

| Case | h5wasm child (wall / peak RSS) | Python h5py (wall / peak RSS) |
|---|---|---|
| Bare runtime start | 0.04 s / 38 MB | 0.02 s / 8 MB |
| list-500, no clip (75 KB payload) | 0.19–0.21 s / 113–116 MB | 0.12–0.15 s / 31 MB |
| list-500, clipped (261 B payload) | 0.19–0.23 s / 113–114 MB | — |
| list-6000, no clip (894 KB payload) | 0.23–0.25 s / 116–119 MB | 0.15–0.18 s / 37 MB |
| list-6000, clipped (263 B payload) | 0.19–0.24 s / 113–115 MB | — |
| grid 3712² full read | 0.27–0.49 s / 193–198 MB | 0.24–0.31 s / 89 MB |
| grid 5568² full read | 0.90–1.76 s / 226–338 MB | 0.42–0.48 s / 153–155 MB |

Breakdown inside the h5wasm child: the Node start takes about 40 ms and `h5wasm.ready`
(wasm instantiation) about 60–120 ms. After that, a list decode takes a few
milliseconds. A 3712² gzip grid read takes 150–270 ms, and 5568² takes 0.7–1.5 s.
Python's `import h5py, numpy` takes about 100 ms and the reads are faster: 120–150 ms and
280–320 ms respectively.

What the numbers mean:

- **Per slot, the cost is startup, not decode.** One slot is one list granule every
  15 minutes. Both runtimes finish it in about 0.2 s, which is roughly 0.02 % of the slot
  interval. The child is started fresh per granule, which is what E3 wants, and the
  startup is paid every time either way.
- **Grids work, and fit under the caps.** A full-disk grid can be decoded in the sandbox
  with room to spare under the 512 MiB wasm cap. That includes FCI's 5568², which is
  about 2–3× slower than h5py. The list product means we do not need to decode grids for
  LSA-502.
- **The payload cap is real.** An unclipped 6,000-pixel list produces an 894 KB payload,
  against a 1,000,000-char cap. Keep the clip on in production.

Image size:

- **h5wasm:** 14 MB unpacked in `node_modules`. Of that, `dist/esm/hdf5_util.js` is
  4.2 MB and is the only build the child loads. The other two builds (`dist/node`,
  `dist/iife`) are dead weight and could be pruned from the image.
- **Python sidecar:** at least 39 MB of venv (h5py 9.5 MB, numpy 20 MB) on top of a
  Python base image. `python:3.x-slim` is roughly 120–150 MB compressed. Adding netCDF4
  for LSA-509 is another ~10–20 MB. The sidecar is also a second runtime to patch, a
  second SBOM, and a second CI toolchain.

## Effect on the E3 containment argument

E3 (review 05 §5.6.2) asks for:

1. a separate container/process;
2. no DB credentials;
3. output that is validated JSON only;
4. memory and time limits.

| E3 property | h5wasm child (this spike) | Python sidecar |
|---|---|---|
| Separate process | Yes. A fresh child per granule, killed as a process group. | Yes. |
| No DB credentials | Yes. The wall builds the env from nothing: ref and clip only. | Yes, if built the same way. |
| Output = validated JSON | Yes. `parseGranulePayload` reads it, with its caps. | Same reader. |
| Time limit | Yes. The wall's deadline and SIGKILL. | Same wall. |
| Memory limit | **Partly.** `--wasm-max-mem-pages` gives a hard ceiling on libhdf5's heap (tested: a 600 MiB allocation fails at 512 MiB). `--max-old-space-size` caps the JS heap. The whole process is not capped without a cgroup. | **None** in-process; needs a cgroup / `ulimit`. |
| Blast radius of a libhdf5 memory bug | **Much smaller.** The bug corrupts wasm linear memory only. It cannot reach the Node heap, the stack or native code, and a trap is a catchable `RuntimeError`. | A native bug in libhdf5, h5py or numpy runs with the full rights of the process. |
| Host filesystem reach | **Minimal.** libhdf5 sees only MEMFS, so external links, external storage and VDS resolve against an empty in-memory directory. Node's `--permission` limits reads to the decoder file and the h5wasm package, and denies all writes (tested). | Full, unless a container with a read-only root adds the limit. |
| Child processes / eval | Denied (tested: `execFileSync` and `eval` both fail). | Allowed, unless seccomp/container adds the limit. |
| Network | **Not covered.** Node 22's permission model has no network control (`--allow-net` is later). A container network policy is still needed. | Not covered either. |

**Net:** h5wasm makes E3 *stronger than the spec asks* on a bare host. Two layers stand
between a malicious granule and the host: the wasm memory sandbox and the Node permission
model. The container is still needed for the network, CPU and cgroup memory, and a
read-only root. The Python sidecar needs the container for *all* of those, and it widens
the native attack surface: libhdf5, h5py, numpy, and the libc it links.

## What was validated, and how

- **Payload contract.** The decoded payloads from synthetic granules pass
  `parseGranulePayload` unchanged, in-process and through the child, both plain and
  `.bz2`. Constants shared with the reader and the wall are asserted equal: format
  string, refused exit code, ref env name, reason prefix.
- **Storage variants.** Contiguous and gzip-chunked storage decode to the same result. An
  empty list decodes to `ok` with zero rows.
- **Refusals.** Each refusal listed above has a test, including:
  - a truncated file, which is refused on libhdf5's error rather than trapping, and
    whose error starts with the child's reason despite the `HDF5-DIAG` stack;
  - a truncated, corrupt or bomb `.bz2`, each refused (exit 65) through the child;
  - a declared length over the cap, rejected before any data is read;
  - a 64-bit integer column;
  - a 2-D column.
- **Sandbox.** Scripts run with exactly `decoderArgs()`, and each of these fails and is
  recorded as `crashed`:
  - reading a file outside the allowlist;
  - writing a file;
  - spawning a program;
  - `eval`;
  - allocating 600 MiB of wasm memory.

**Not validated:**

- **The LSA-502 layout itself.** The dataset names, integer types, scale factors,
  `OFFSET` convention, fill values and the name/format of the acquisition-time attribute
  come from our reading of the FRP-PIXEL product user manual. The synthetic files were
  built from the *same* reading. So the tests prove that the decoder and the reader agree
  with each other. They do **not** prove that either agrees with EUMETSAT. Every layout
  assumption is written to fail as a *refusal* rather than decode to something
  plausible, so a wrong guess surfaces as refused slots on the first real fetch, not as
  wrong fires.
- **Real `.bz2` files.** The bzip2 path is proven against the system `bzip2` on
  synthetic granules. Whether LSA SAF wraps one HDF5 file per `.bz2`, as assumed, or
  something else (a tar, several files) is not known until a real download.
- **LSA-509 (FCI, netCDF-4).** It is not implemented, and the source is refused. netCDF-4
  is HDF5 underneath, so h5wasm can open it. The variable names and scaling are unknown.
- The worker wiring. `createH5wasmDecoder` is not yet passed to the GEO poll cycle.

## Plan B: Python sidecar

Switch to the sidecar if either of these happens:

- a real granule needs a filter h5wasm does not ship, such as szip/`H5Z_FILTER_SZIP`,
  a third-party filter, or a bzip2-inside-HDF5 filter;
- libhdf5-in-wasm diverges from native libhdf5 on real files.

The port does not change. A Python program that follows the same stdin/stdout/exit-code
contract (65 = refused) drops straight into `createChildProcessDecoder`. The cost is the
image size above, and a container becomes mandatory for any memory or filesystem
containment.

## Licence

- **h5wasm:** the NIST software notice (public-domain-style, attribution requested; the
  `package.json` says "SEE LICENSE IN LICENSE.txt").
- **Bundled libhdf5:** The HDF Group's BSD-style licence, reproduced in the same
  `LICENSE.txt`.
- **zlib**, for the gzip filter: zlib licence.

All three are permissive and compatible with this project. The bzip2 decompressor adds
no dependency and no licence: `bunzip2.ts` is original code in this repo. It follows the
public bzip2 format and algorithm, but it copies none of the libbzip2 source (which is
BSD-style in any case). Redistribution in an image
must keep `LICENSE.txt` intact. **The repo has no software-dependency licence register**:
`docs/licenses/` covers data sources only. So the licence is recorded here, and the gap
is flagged.

## Open questions

1. **bzip2 — closed 2026-09-25**, with option (a): an own decompressor inside the
   child, with an absolute cap and a ratio cap (see "bzip2" above). What is still
   open:
   - The default caps (128 MiB, 1000× above 32 MiB) are provisional until a real granule
     is measured.
   - Trailing non-bzip2 bytes are refused strictly, where the `bzip2` CLI only warns.
   - It is assumed that one `.bz2` holds exactly one HDF5 file.
2. **Layout confirmation.** Once credentials exist, fetch one real list granule and run
   `h5dump -H`. Then fix the names, types, `OFFSET` sign and time attribute in
   `LSA_502_LIST_FIELDS`, `ACQUISITION_TIME_ATTR` and `lsa-502-synthetic.ts`. After that,
   add the real file (or a trimmed copy, subject to the LSA SAF licence) as a fixture.
3. **Acquisition time.** Rows use the slot time. SEVIRI scans the disk south to north
   over about 12 minutes, so for European fires the real pixel time is several minutes
   later than the slot time. Is there a per-pixel time field in the list, or does the
   slot time plus a latitude-dependent offset do?
4. **Confidence thresholds** (0.8 / 0.5) are provisional and need a data-science review.
   The same goes for `PIXEL_SIZE`: `scanKm`/`trackKm` are currently null.
5. **libhdf5 version.** The HDF5 diagnostics identify the bundled library as **2.0.0**.
   h5wasm's changelog stops at 0.8.x, which used 1.14.6. A 2.0 major is new, so watch its
   advisories.
6. **stderr noise — closed 2026-09-25.** libhdf5 still prints its `HDF5-DIAG` stacks,
   because h5wasm neither exposes `H5Eset_auto` nor lets the caller hook `printErr`: the
   module is instantiated when it is imported. Instead, the child's reason travels as a
   `fw-decoder-reason:` line that the wall puts first (see "Decoder behaviour"). The
   `HDF5-DIAG` text is still kept after the reason as context, cut to the cap.
7. **Image pruning.** Drop `h5wasm/dist/node` and `dist/iife` from the production image
   (about 10 MB).
8. **Network.** Node 22 cannot deny network access to the child, so the deployment
   container must deny it, or the child must move to a Node release with `--allow-net`.
