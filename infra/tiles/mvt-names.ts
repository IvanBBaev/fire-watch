/**
 * Which characters the style will ask the glyph server for (ADR-001 A2.1 as amended by
 * TASKS A17): the label text of every feature, from the fields the style reads.
 *
 * The scan reads exactly the style's label fields (`label-contract.json`: `name:bg`, then
 * `name`), not every `name:*` column. A2.1 says "the `name*` fields"; narrowing it to the
 * two the style can ever render keeps a stray `name:ja` in a Greek village from demanding
 * a CJK glyph build nobody will see. If the style ever reads another field, the contract
 * file changes and so does this scan — both sides test against it.
 */

import { gunzipSync } from 'node:zlib';

import { readFields, repeatedVarints, utf8, WIRE_LEN } from './protobuf.js';

/** MVT field numbers (vector_tile.proto v2.1). */
const TILE_LAYERS = 3;
const LAYER_NAME = 1;
const LAYER_FEATURES = 2;
const LAYER_KEYS = 3;
const LAYER_VALUES = 4;
const FEATURE_TAGS = 2;
const VALUE_STRING = 1;

/** Label strings, per MVT layer, carried by one tile under the given fields. */
export function labelStrings(
  tile: Uint8Array,
  labelFields: readonly string[],
): Array<{ readonly layer: string; readonly field: string; readonly text: string }> {
  const out: Array<{ layer: string; field: string; text: string }> = [];
  const wanted = new Set(labelFields);
  for (const layerField of readFields(tile)) {
    if (layerField.field !== TILE_LAYERS || layerField.wireType !== WIRE_LEN) continue;
    const layer = readFields(layerField.bytes);
    let name = '';
    const keys: string[] = [];
    const values: Array<string | null> = [];
    const features: Uint8Array[] = [];
    for (const entry of layer) {
      if (entry.field === LAYER_NAME) name = utf8(entry.bytes);
      else if (entry.field === LAYER_KEYS) keys.push(utf8(entry.bytes));
      else if (entry.field === LAYER_VALUES) {
        const stringField = readFields(entry.bytes).find((value) => value.field === VALUE_STRING);
        values.push(stringField === undefined ? null : utf8(stringField.bytes));
      } else if (entry.field === LAYER_FEATURES) features.push(entry.bytes);
    }
    const wantedKeys = new Map<number, string>();
    keys.forEach((key, index) => {
      if (wanted.has(key)) wantedKeys.set(index, key);
    });
    if (wantedKeys.size === 0) continue;
    for (const feature of features) {
      const tags = repeatedVarints(readFields(feature), FEATURE_TAGS);
      for (let i = 0; i + 1 < tags.length; i += 2) {
        const field = wantedKeys.get(tags[i] ?? -1);
        const text = values[tags[i + 1] ?? -1];
        if (field !== undefined && typeof text === 'string') out.push({ layer: name, field, text });
      }
    }
  }
  return out;
}

/** Stored tile bytes → raw MVT: gzip is sniffed by magic, not trusted from the header. */
export function inflateTile(data: Uint8Array): Uint8Array {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b ? new Uint8Array(gunzipSync(data)) : data;
}

/**
 * Accumulates the codepoints the style will render. Whitespace and controls are dropped
 * (MapLibre never asks for a glyph for them), everything else counts — one stray
 * codepoint with no glyph range is a tofu box on the map.
 */
export class CodepointCollector {
  private readonly seen = new Map<number, string>();

  add(text: string, where: string): void {
    for (const char of text) {
      const codepoint = char.codePointAt(0) ?? 0;
      if (codepoint < 0x20 || codepoint === 0x7f || /\s/u.test(char)) continue;
      if (!this.seen.has(codepoint)) this.seen.set(codepoint, where);
    }
  }

  addTile(tile: Uint8Array, labelFields: readonly string[], where: string): void {
    for (const label of labelStrings(inflateTile(tile), labelFields)) {
      this.add(label.text, `${where} ${label.layer}.${label.field} "${label.text}"`);
    }
  }

  /** Sorted codepoints, each with the first label it was seen in (for error messages). */
  entries(): Array<{ readonly codepoint: number; readonly firstSeen: string }> {
    return [...this.seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([codepoint, firstSeen]) => ({ codepoint, firstSeen }));
  }
}
