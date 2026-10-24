/**
 * The attribution and licence lines an export owes, per source actually in the file.
 *
 * The registry (`@fire-watch/contracts` `CREDITS`) already says which credits travel with
 * data rather than with the map: the `api` surface, the one the server's snapshot carries.
 * An export is that same data leaving the product, so it starts from the same set — and
 * then drops the credits of sources that contributed nothing to *this* file, which is what
 * "attribution follows the data actually used" means for a download.
 *
 * Narrowing only ever drops a credit when every record names its sources. One record whose
 * sources are unknown (an older snapshot without `source_ids`, or a source id this bundle
 * does not know) keeps the full set: over-crediting is the safe direction, a missing
 * licence line is not.
 */

import { creditsFor, renderCredit, SOURCE_IDS } from '@fire-watch/contracts';
import type { RenderContext } from '@fire-watch/contracts';

import type { ExportAttribution } from './export-document.js';

/**
 * Which source ids make a source-specific `api` credit owed. A credit not listed here is
 * owed by every export (OSM place names and the static-source mask, the Copernicus
 * service layers the scorer reads, and our own derivation sentence).
 */
export const CREDIT_SOURCE_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  // NASA FIRMS / LANCE: VIIRS (S-NPP, NOAA-20, NOAA-21) and MODIS.
  'firms-acknowledgement': ['firms:'],
  'lance-tactical-disclaimer': ['firms:'],
  'lance-as-is': ['firms:'],
  // Meteosat SEVIRI / MTG FCI via the LSA SAF FRP-PIXEL products.
  'eumetsat-meteosat': ['lsasaf:'],
  'lsa-saf-long': ['lsasaf:'],
  // Sentinel-3 SLSTR FRP, distributed by EUMETSAT.
  'sentinel-modified': ['eumetsat:slstr:'],
};

const KNOWN_SOURCES: ReadonlySet<string> = new Set(SOURCE_IDS);

/**
 * The lines owed for records whose sources are `sourceSets` (one entry per record; `null`
 * for a record that does not say). Registry order, placeholders resolved.
 */
export function exportAttribution(
  sourceSets: readonly (readonly string[] | null)[],
  context: RenderContext,
): readonly ExportAttribution[] {
  const used = new Set<string>();
  // An empty file names no source either way; it keeps the full set like any unknown.
  let complete = sourceSets.length > 0;
  for (const sources of sourceSets) {
    if (sources === null || sources.length === 0) {
      complete = false;
      continue;
    }
    for (const source of sources) {
      if (!KNOWN_SOURCES.has(source)) complete = false;
      used.add(source);
    }
  }
  return creditsFor('api', [])
    .filter((credit) => {
      const prefixes = CREDIT_SOURCE_PREFIXES[credit.id];
      if (prefixes === undefined || !complete) return true;
      return [...used].some((source) => prefixes.some((prefix) => source.startsWith(prefix)));
    })
    .map((credit) => ({
      id: credit.id,
      text: renderCredit(credit, context),
      ...(credit.href === undefined ? {} : { href: credit.href }),
    }));
}
