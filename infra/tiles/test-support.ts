/**
 * Fixture encoders for the tests: a tiny MVT tile with labelled features. Not used by the
 * build path — the build only ever reads what Protomaps produced.
 */

import { ProtoWriter } from './protobuf.js';

export interface FixtureLayer {
  readonly name: string;
  /** One record per feature; every value is a string property. */
  readonly features: ReadonlyArray<Readonly<Record<string, string>>>;
}

export function encodeMvt(layers: readonly FixtureLayer[]): Uint8Array {
  const tile = new ProtoWriter();
  for (const layer of layers) {
    const keys: string[] = [];
    const values: string[] = [];
    const index = (list: string[], item: string): number => {
      const at = list.indexOf(item);
      if (at >= 0) return at;
      list.push(item);
      return list.length - 1;
    };
    const features = layer.features.map((properties, id) => {
      const tags: number[] = [];
      for (const [key, value] of Object.entries(properties)) tags.push(index(keys, key), index(values, value));
      return new ProtoWriter()
        .varint(1, id + 1)
        .packed(2, tags)
        .varint(3, 1)
        // One MoveTo(0,0): a point. Geometry is irrelevant to the label scan.
        .packed(4, [9, 0, 0])
        .finish();
    });
    const writer = new ProtoWriter().varint(15, 2).string(1, layer.name);
    for (const feature of features) writer.bytes(2, feature);
    for (const key of keys) writer.string(3, key);
    for (const value of values) writer.bytes(4, new ProtoWriter().string(1, value).finish());
    writer.varint(5, 4096);
    tile.bytes(3, writer.finish());
  }
  return tile.finish();
}
