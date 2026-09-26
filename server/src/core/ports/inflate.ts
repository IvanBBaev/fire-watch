/**
 * Port: zlib (RFC 1950) inflate, for the EFFIS PNG structural check (TASKS G4).
 *
 * The core may not import node builtins (ADR-002 D7), so the one platform step the PNG
 * validator needs arrives as a function. The contract is total: a corrupt stream, a
 * truncated stream or output past `maxOutputBytes` all return `null` — never throw —
 * because a hostile or broken upstream body is the routine input, not an error.
 *
 * `maxOutputBytes` is the decompression-bomb guard: the caller knows the exact size a
 * well-formed image inflates to and asks for no more.
 */
export type Inflate = (compressed: Uint8Array, maxOutputBytes: number) => Uint8Array | null;
