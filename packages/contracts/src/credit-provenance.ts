/**
 * Provenance of every credit in `CREDITS` (TASKS G5, CI-13): which source or layer the
 * credit pays for, and where its wording comes from.
 *
 * Split out of `credits.ts` by the founder decision of 2026-10-30 on CI-12 (F8-a in
 * docs/decisions/founder-2026-10-30/thresholds-ops.md): the critical-path byte budget is
 * an ADR-005 spec number and is not raised, so bytes the web never renders leave the
 * bundle instead. The server reads `source` for its API attribution blocks; the web reads
 * neither field, and importing only `CREDITS` keeps this table out of its build.
 *
 * Keyed by credit id. `credit-provenance.test.ts` asserts the keys are exactly the
 * registry's ids, so a credit cannot be added without saying where it comes from.
 */

export interface CreditProvenance {
  /** Which source or layer this credit pays for. */
  readonly source: string;
  /** Where the wording comes from, for the next person who is asked to change it. */
  readonly authority: string;
}

export const CREDIT_PROVENANCE: Readonly<Record<string, CreditProvenance>> = {
  'osm': {
    source: 'OpenStreetMap (basemap, place names, static hot-source mask)',
    authority: 'OSMF Attribution Guidelines',
  },
  'openfreemap': {
    source: 'OpenFreeMap / OpenMapTiles (beta tiles)',
    authority: 'openfreemap.org',
  },
  'protomaps': {
    source: 'Protomaps self-hosted build',
    authority: 'Protomaps LICENSE_DATA',
  },
  'firms-acknowledgement': {
    source: 'NASA FIRMS / LANCE',
    authority: 'FIRMS official citation',
  },
  'lance-tactical-disclaimer': {
    source: 'NASA LANCE — redistribution disclaimer',
    authority: 'LANCE disclaimer, replication requested',
  },
  'lance-as-is': {
    source: 'NASA LANCE — "as is" clause',
    authority: 'LANCE disclaimer, replication requested',
  },
  'gibs': {
    source: 'NASA GIBS / Worldview imagery',
    authority: 'GIBS citation guidance',
  },
  'gibs-short': {
    source: 'NASA GIBS true-colour imagery (event-page before/after comparison, TASKS V2-E2)',
    authority: 'GIBS citation guidance (nasa-gibs.github.io/gibs-api-docs/) — attribution requested; short form ours',
  },
  'eumetsat-meteosat': {
    source: 'EUMETSAT data (Meteosat/MTG products)',
    authority: 'EUMETSAT Data Policy Art. 6.3',
  },
  'lsa-saf-short': {
    source: 'LSA SAF FRP-PIXEL (LSA-502 / LSA-509)',
    authority: 'LSA SAF data-access pages',
  },
  'lsa-saf-long': {
    source: 'LSA SAF FRP-PIXEL (LSA-502 / LSA-509)',
    authority: 'LSA SAF data-access pages',
  },
  'sentinel-modified': {
    source: 'Copernicus Sentinel data — modified',
    authority: 'Sentinel Data Legal Notice',
  },
  'sentinel-unmodified': {
    source: 'Copernicus Sentinel data — unmodified renders',
    authority: 'Sentinel Data Legal Notice',
  },
  'copernicus-service': {
    source: 'Copernicus Service outputs (EFFIS, CAMS, CLMS)',
    authority: 'Copernicus legal notice',
  },
  'effis': {
    source: 'EFFIS (fire danger, burnt areas)',
    authority: 'EFFIS data-licence page',
  },
  'gwis': {
    source: 'GWIS',
    authority: 'GWIS data-licence page',
  },
  'ecmwf-service': {
    source: 'ECMWF Open Data (IFS/AIFS) — copyright statement',
    authority: 'ECMWF Terms of Use for Open Data Products (retrieved 2026-08-15)',
  },
  'ecmwf-source': {
    source: 'ECMWF Open Data — source line',
    authority: 'ECMWF Terms of Use for Open Data Products (retrieved 2026-08-15)',
  },
  'ecmwf-licence': {
    source: 'ECMWF Open Data — licence statement',
    authority: 'ECMWF Terms of Use for Open Data Products (retrieved 2026-08-15)',
  },
  'ecmwf-liability': {
    source: 'ECMWF Open Data — disclaimer',
    authority: 'ECMWF Terms of Use for Open Data Products (retrieved 2026-08-15)',
  },
  'ecmwf-modified': {
    source: 'ECMWF Open Data — modification indication',
    authority: 'ECMWF Terms of Use + CC BY 4.0 §3(a)(1)(B); wording ours',
  },
  'copernicus-dem-distribution': {
    source: 'Copernicus DEM GLO-30 — distribution/communication',
    authority: 'COP-DEM-GLO-30-F licence, Art. 6(a)',
  },
  'copernicus-dem-adapted': {
    source: 'Copernicus DEM GLO-30 — adapted (slope, aspect, hillshade)',
    authority: 'COP-DEM-GLO-30-F licence, Art. 6(b)',
  },
  'copernicus-dem-liability': {
    source: 'Copernicus DEM GLO-30 — liability sentence',
    authority: 'COP-DEM-GLO-30-F licence, Art. 6(c)',
  },
  'terrarium-short': {
    source: 'Terrarium terrain tiles (Tilezen/Mapzen composite)',
    authority: 'tilezen/joerd attribution.md',
  },
  'terrarium-eu-dem': {
    source: 'Terrarium terrain tiles — EU-DEM component',
    authority: 'tilezen/joerd attribution.md',
  },
  'terrarium-usgs': {
    source: 'Terrarium terrain tiles — USGS component',
    authority: 'tilezen/joerd attribution.md',
  },
  'terrarium-etopo1': {
    source: 'Terrarium terrain tiles — NOAA ETOPO1 component',
    authority: 'tilezen/joerd attribution.md — wording not yet checked against source',
  },
  'landsat': {
    source: 'Landsat 8/9',
    authority: 'USGS courtesy line',
  },
  'esri-world-imagery': {
    source: 'Esri World Imagery (optional toggle)',
    authority: 'Esri Master Agreement + ArcGIS attribution docs',
  },
  'geonames': {
    source: 'GeoNames gazetteer (place search, built by infra/geodata)',
    authority: 'GeoNames export readme + CC BY 4.0 §3(a) — our chosen form',
  },
  'natural-earth': {
    source: 'Natural Earth admin-1 (oblast boundaries for the region filter)',
    authority: 'naturalearthdata.com terms of use — requested, not required',
  },
  'celestrak': {
    source: 'CelesTrak GP orbital elements (satellite-pass predictions, TASKS F15)',
    authority: 'CelesTrak GP data documentation — citation requested; our chosen form',
  },
  'eea-natura2000': {
    source: 'EEA Natura 2000 sites (protected-site layer and event note, V2-F1)',
    authority: 'EEA legal notice + CC BY 4.0 §3(a) — our chosen form',
  },
  'esa-worldcover': {
    source: 'ESA WorldCover 2021 v200 (land-cover note, V2-F4)',
    authority: 'WorldCover PUM V2.0 §5.2',
  },
  'meteoalarm': {
    source: 'MeteoAlarm national warning feeds (forest-fire and heat warnings, V2-B3)',
    authority: 'MeteoAlarm legacy Atom feed <rights> element (read 2026-10-24)',
  },
  'copernicus-ems': {
    source: 'Copernicus EMS Rapid Mapping activations (event-page badge, TASKS V2-E3)',
    authority: 'Copernicus EMS citation guidelines (mapping.emergency.copernicus.eu/about/citation-guidelines/); Regulation (EU) 2021/696',
  },
  'derivation': {
    source: 'Fire Watch — derivation sentence',
    authority: 'ADR-001 A1.4',
  },
  'eox-cloudless': {
    source: 'EOX Sentinel-2 cloudless 2018+',
    authority: 'EOX licence page — layer not shipped',
  },
};

/** The `source` label of a credit, for API attribution blocks. Throws on an unknown id. */
export function creditSource(id: string): string {
  const provenance = CREDIT_PROVENANCE[id];
  if (provenance === undefined) throw new RangeError(`no provenance for credit ${id}`);
  return provenance.source;
}
