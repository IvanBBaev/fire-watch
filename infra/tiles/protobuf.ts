/**
 * A minimal protobuf wire-format reader — just enough for MVT tiles (label scan) and
 * glyph PBFs (range verification). No dependency: the build tool must run from a clean
 * checkout with only Node, and the two schemas it reads are tiny and frozen.
 */

export const WIRE_VARINT = 0;
export const WIRE_I64 = 1;
export const WIRE_LEN = 2;
export const WIRE_I32 = 5;

export interface ProtoField {
  readonly field: number;
  readonly wireType: number;
  /** Set for varint fields. */
  readonly varint: number;
  /** Set for length-delimited fields (a view into the parent buffer, not a copy). */
  readonly bytes: Uint8Array;
}

const EMPTY = new Uint8Array(0);

export class ProtoReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.buf.length) throw new RangeError('protobuf: truncated varint');
      const byte = this.buf[this.pos++] ?? 0;
      // Multiplication, not `<<`: values past 2^31 (tile ids, offsets) must stay exact.
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new RangeError('protobuf: varint too long');
    }
  }

  /** Reads the next field; unknown fixed-width fields are skipped and returned empty. */
  next(): ProtoField {
    const key = this.varint();
    const field = Math.floor(key / 8);
    const wireType = key & 7;
    switch (wireType) {
      case WIRE_VARINT:
        return { field, wireType, varint: this.varint(), bytes: EMPTY };
      case WIRE_LEN: {
        const length = this.varint();
        const end = this.pos + length;
        if (end > this.buf.length) throw new RangeError('protobuf: truncated length-delimited field');
        const bytes = this.buf.subarray(this.pos, end);
        this.pos = end;
        return { field, wireType, varint: 0, bytes };
      }
      case WIRE_I64:
        this.skip(8);
        return { field, wireType, varint: 0, bytes: EMPTY };
      case WIRE_I32:
        this.skip(4);
        return { field, wireType, varint: 0, bytes: EMPTY };
      default:
        throw new RangeError(`protobuf: unsupported wire type ${wireType}`);
    }
  }

  private skip(count: number): void {
    if (this.pos + count > this.buf.length) throw new RangeError('protobuf: truncated fixed field');
    this.pos += count;
  }
}

/** Every field of a message, in wire order. */
export function readFields(buf: Uint8Array): ProtoField[] {
  const reader = new ProtoReader(buf);
  const out: ProtoField[] = [];
  while (!reader.done) out.push(reader.next());
  return out;
}

/** A repeated uint32 that may arrive packed (one LEN field) or unpacked (many varints). */
export function repeatedVarints(fields: readonly ProtoField[], field: number): number[] {
  const out: number[] = [];
  for (const entry of fields) {
    if (entry.field !== field) continue;
    if (entry.wireType === WIRE_VARINT) out.push(entry.varint);
    else if (entry.wireType === WIRE_LEN) {
      const reader = new ProtoReader(entry.bytes);
      while (!reader.done) out.push(reader.varint());
    }
  }
  return out;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function utf8(bytes: Uint8Array): string {
  return UTF8.decode(bytes);
}

// ---------------------------------------------------------------------------------------
// Writer — used by the tests to build fixtures, and nowhere in the build path.

export class ProtoWriter {
  private readonly chunks: number[] = [];

  varintRaw(value: number): this {
    let rest = value;
    while (rest >= 0x80) {
      this.chunks.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.chunks.push(rest);
    return this;
  }

  varint(field: number, value: number): this {
    return this.varintRaw(field * 8 + WIRE_VARINT).varintRaw(value);
  }

  bytes(field: number, value: Uint8Array): this {
    this.varintRaw(field * 8 + WIRE_LEN).varintRaw(value.length);
    for (const byte of value) this.chunks.push(byte);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }

  packed(field: number, values: readonly number[]): this {
    const inner = new ProtoWriter();
    for (const value of values) inner.varintRaw(value);
    return this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}
