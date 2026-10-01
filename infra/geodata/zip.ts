/**
 * Just enough of the ZIP format to read one named member out of a GeoNames dump
 * (stored or deflated, no ZIP64, no encryption) — so the build needs no `unzip`
 * binary and no dependency.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function readZipMember(zip: Buffer, name: string): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE)
      throw new Error('corrupt central directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('corrupt local header');
    const dataStart =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`${name}: unsupported compression method ${method}`);
  }
  throw new Error(`${name} not found in archive`);
}
