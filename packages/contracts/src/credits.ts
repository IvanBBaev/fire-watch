/**
 * Attribution registry — the licence fee, in code.
 *
 * Every string here is reproduced exactly as its provider publishes it, in the
 * provider's own language and punctuation. The source of truth is the table
 * "Attribution strings — verbatim" in docs/DATA-SOURCES.md; this file is built from
 * that table and must be changed only together with it. Do not paraphrase, translate,
 * reflow or tidy a string: several of them are the literal condition on which we are
 * allowed to redistribute the data at all (ADR-001 A1.4).
 *
 * WP5's CI-13 asserts that the rendered attribution block contains the asserted text of
 * every credit that is currently rendering. Entries that are not verified against the
 * provider yet, and the Esri entry (whose wording is injected live by the ArcGIS plugin
 * and must never be hand-copied), are deliberately outside that assertion set.
 *
 * This is the *single* registry (ADR-003 A1.3): the map corner, the credits page and the
 * `attribution` member on every JSON API response and snapshot all render from it, which
 * is why it lives in the shared contracts package and not in the web bundle — the server
 * must not import the web, and two registries would drift.
 */

/**
 * Where a credit has to appear. A credit may need several surfaces at once. `api` is the
 * `attribution` member every JSON API response and snapshot carries (ADR-003 A1.3): a
 * consumer who takes the data instead of the map inherits the obligation with it.
 * `imagery-compare` is the V2-E2 before/after panel on an event page, which draws imagery
 * outside the map and so carries its own credit line while it is open.
 */
export type CreditSurface =
  'map-corner' | 'credits-page' | 'about' | 'alert-footer' | 'api' | 'imagery-compare';

/** The package whose code produces a surface's output. */
export type CreditSurfaceOwner = 'web' | 'server';

/**
 * Which package renders each surface. CI-13 probes every surface in the package that
 * produces it, and each package's probe table is typed over exactly the surfaces this
 * record assigns to it — so a new surface is a missing-property error here, and once
 * assigned, a missing-property error in that package's CI-13 test.
 */
export const CREDIT_SURFACE_OWNER = {
  'map-corner': 'web',
  'credits-page': 'web',
  about: 'web',
  'alert-footer': 'server',
  api: 'server',
  'imagery-compare': 'web',
} as const satisfies Record<CreditSurface, CreditSurfaceOwner>;

/** The surfaces {@link CREDIT_SURFACE_OWNER} assigns to `Owner`. */
export type CreditSurfacesOf<Owner extends CreditSurfaceOwner> = {
  [S in CreditSurface]: (typeof CREDIT_SURFACE_OWNER)[S] extends Owner ? S : never;
}[CreditSurface];

/**
 * What has to be true for a credit to be owed. Attribution follows the data actually
 * used, so a layer that is switched off owes nothing — and a layer that is switched on
 * owes immediately, which is why this is a machine-readable condition and not a comment.
 */
export type CreditCondition =
  | 'always'
  | 'basemap:openfreemap'
  | 'basemap:protomaps'
  | 'layer:gibs'
  | 'layer:effis'
  | 'layer:gwis'
  | 'layer:terrain'
  | 'layer:landsat'
  | 'imagery:sentinel-unmodified'
  | 'derived:ecmwf'
  | 'toggle:esri'
  | 'never';

export interface Credit {
  /** Stable key. Referenced by CI-13 failure messages; never reused for a new string. */
  readonly id: string;
  /** Which source or layer this credit pays for. */
  readonly source: string;
  /**
   * The string as rendered, verbatim from the provider, possibly containing the
   * placeholders below.
   */
  readonly text: string;
  /**
   * Set only when the rendered sentence embeds a verbatim clause inside wording of
   * ours. CI-13 then asserts this substring instead of the whole sentence, so our
   * connective words stay editable while the provider's words do not.
   */
  readonly verbatim?: string;
  /** Link the string must carry, where the licence requires a reachable one. */
  readonly href?: string;
  readonly surfaces: readonly CreditSurface[];
  readonly condition: CreditCondition;
  /** False for credits the provider requests but does not require (Protomaps). */
  readonly required: boolean;
  /**
   * True when a third-party plugin renders the attribution itself. We assert that its
   * element is present; we never keep our own copy of the wording, because the provider
   * changes it (Maxar → Vantor) without warning us.
   */
  readonly pluginInjected?: boolean;
  /**
   * False while the exact wording has not been checked against the provider. Unverified
   * entries render but are excluded from the CI-13 assertion set, so an approximate
   * string can never harden into a "verified" one just by sitting in CI.
   */
  readonly verified: boolean;
  /** Where the wording comes from, for the next person who is asked to change it. */
  readonly authority: string;
}

/** Substituted with the year of publication or distribution of the data actually used. */
export const YEAR_PLACEHOLDER = '[YEAR]';

/** Substituted with the product name, so the derivation sentence names the deriver. */
export const PRODUCT_PLACEHOLDER = '[Product]';

export const CREDITS: readonly Credit[] = [
  {
    id: 'osm',
    // Also pays for the static hot-source mask (TASKS F16), an ODbL derived database of
    // OSM: the same string and link, owed always, because the scorer uses the mask whether
    // or not the reader draws it (docs/licenses/openstreetmap-static-sources.md).
    source: 'OpenStreetMap (basemap, place names, static hot-source mask)',
    text: '© OpenStreetMap contributors',
    href: 'https://www.openstreetmap.org/copyright',
    surfaces: ['map-corner', 'credits-page', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'OSMF Attribution Guidelines',
  },
  {
    id: 'openfreemap',
    source: 'OpenFreeMap / OpenMapTiles (beta tiles)',
    // The "OpenFreeMap" part is optional; the rest is not.
    text: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
    surfaces: ['map-corner'],
    condition: 'basemap:openfreemap',
    required: true,
    verified: true,
    authority: 'openfreemap.org',
  },
  {
    id: 'protomaps',
    source: 'Protomaps self-hosted build',
    // Requested, not required — but the OSM row above stays mandatory regardless,
    // because a Protomaps tileset is an ODbL produced work.
    text: 'Protomaps',
    surfaces: ['map-corner'],
    condition: 'basemap:protomaps',
    required: false,
    verified: true,
    authority: 'Protomaps LICENSE_DATA',
  },
  {
    id: 'firms-acknowledgement',
    source: 'NASA FIRMS / LANCE',
    text:
      "We acknowledge the use of data and/or imagery from NASA's Fire Information for " +
      "Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near real-time " +
      "Capability for Earth observations (LANCE) and NASA's Earth Science Data and " +
      'Information System (ESDIS).',
    surfaces: ['credits-page', 'about', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'FIRMS official citation',
  },
  {
    id: 'lance-tactical-disclaimer',
    source: 'NASA LANCE — redistribution disclaimer',
    text:
      'Due to the spatial resolution and other characteristics of these data, their use ' +
      'for tactical decision-making or informing about conditions at a local scale are ' +
      'not advised.',
    surfaces: ['credits-page', 'alert-footer', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'LANCE disclaimer, replication requested',
  },
  {
    id: 'lance-as-is',
    source: 'NASA LANCE — "as is" clause',
    // Only the clause is the provider's; the subject in front of it is ours, which is
    // why the asserted substring is narrower than the rendered sentence.
    text:
      'These data are provided "as is" and users bear all responsibility and liability ' +
      'for their use.',
    verbatim: 'are provided "as is" and users bear all responsibility and liability for their use',
    surfaces: ['credits-page', 'alert-footer', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'LANCE disclaimer, replication requested',
  },
  {
    id: 'gibs',
    source: 'NASA GIBS / Worldview imagery',
    text:
      "We acknowledge the use of imagery provided by services from NASA's Global Imagery " +
      "Browse Services (GIBS), part of NASA's Earth Science Data and Information System " +
      '(ESDIS).',
    surfaces: ['credits-page'],
    // The V2-E2 before/after comparison draws GIBS imagery on any event page, so the full
    // acknowledgement is listed on /credits always rather than only while a panel is open:
    // over-crediting is the safe direction (founder decision, TASKS V2-E2).
    condition: 'always',
    required: true,
    verified: true,
    authority: 'GIBS citation guidance',
  },
  {
    id: 'gibs-short',
    source: 'NASA GIBS true-colour imagery (event-page before/after comparison, TASKS V2-E2)',
    // NASA imagery carries no use restriction; GIBS asks for an acknowledgement. The short
    // form names the service and its system where the imagery is drawn; the long sentence
    // above is the full acknowledgement on /credits. Our connective word stays editable.
    text: 'Imagery: NASA GIBS / EOSDIS',
    verbatim: 'NASA GIBS / EOSDIS',
    href: 'https://nasa-gibs.github.io/gibs-api-docs/',
    surfaces: ['imagery-compare'],
    condition: 'layer:gibs',
    required: true,
    verified: true,
    authority:
      'GIBS citation guidance (nasa-gibs.github.io/gibs-api-docs/) — attribution requested; short form ours',
  },
  {
    id: 'eumetsat-meteosat',
    source: 'EUMETSAT data (Meteosat/MTG products)',
    // Instantiation of the Art. 6.3 pattern
    // "[Contains modified] EUMETSAT [Meteosat/Metop] [data/product] [Year]".
    text: `Contains modified EUMETSAT Meteosat data ${YEAR_PLACEHOLDER}`,
    surfaces: ['credits-page', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'EUMETSAT Data Policy Art. 6.3',
  },
  {
    id: 'lsa-saf-short',
    source: 'LSA SAF FRP-PIXEL (LSA-502 / LSA-509)',
    text: 'EUMETSAT LSA SAF',
    surfaces: ['map-corner'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'LSA SAF data-access pages',
  },
  {
    id: 'lsa-saf-long',
    source: 'LSA SAF FRP-PIXEL (LSA-502 / LSA-509)',
    text: 'Data source: EUMETSAT LSA SAF, FRP-PIXEL (LSA-502 / LSA-509)',
    surfaces: ['credits-page', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'LSA SAF data-access pages',
  },
  {
    id: 'sentinel-modified',
    source: 'Copernicus Sentinel data — modified',
    text: `Contains modified Copernicus Sentinel data ${YEAR_PLACEHOLDER}`,
    surfaces: ['credits-page', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'Sentinel Data Legal Notice',
  },
  {
    id: 'sentinel-unmodified',
    source: 'Copernicus Sentinel data — unmodified renders',
    text: `Copernicus Sentinel data ${YEAR_PLACEHOLDER}`,
    surfaces: ['credits-page'],
    condition: 'imagery:sentinel-unmodified',
    required: true,
    verified: true,
    authority: 'Sentinel Data Legal Notice',
  },
  {
    id: 'copernicus-service',
    source: 'Copernicus Service outputs (EFFIS, CAMS, CLMS)',
    text: `Contains modified Copernicus Service information ${YEAR_PLACEHOLDER}`,
    surfaces: ['map-corner', 'credits-page', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'Copernicus legal notice',
  },
  {
    id: 'effis',
    source: 'EFFIS (fire danger, burnt areas)',
    // Our chosen form: EFFIS publishes no canonical string and CC BY only requires
    // appropriate credit. Pairs with copernicus-service.
    text: `© European Union, ${YEAR_PLACEHOLDER}, European Forest Fire Information System (EFFIS)`,
    surfaces: ['credits-page'],
    condition: 'layer:effis',
    required: true,
    verified: true,
    authority: 'EFFIS data-licence page',
  },
  {
    id: 'gwis',
    source: 'GWIS',
    text: `© European Union, ${YEAR_PLACEHOLDER}, Global Wildfire Information System (GWIS)`,
    surfaces: ['credits-page'],
    condition: 'layer:gwis',
    required: true,
    verified: true,
    authority: 'GWIS data-licence page',
  },
  // ECMWF Open Data, the *service* form (DATA-SOURCES row 22). We compute from the
  // fields and publish a derived product rather than republishing GRIB, so the Terms'
  // second wording block binds, not the direct-data one. The five rows below are one
  // obligation split across five strings: ECMWF requires them *together*, so a surface
  // that renders the credit line without the source, licence link and disclaimer does
  // not satisfy the Terms. They share `condition` and `surfaces` for that reason, and
  // `ecmwfComponents()` below exists so a caller cannot pick one up alone. The Terms
  // also require the attribution be displayed *prominently* — it may not sit behind an
  // expander that defaults to closed, which is a rendering obligation this file can
  // state but not enforce.
  {
    id: 'ecmwf-service',
    source: 'ECMWF Open Data (IFS/AIFS) — copyright statement',
    text:
      'This service is based on data and products of the European Centre for ' +
      'Medium-Range Weather Forecasts (ECMWF)',
    surfaces: ['credits-page'],
    condition: 'derived:ecmwf',
    required: true,
    verified: true,
    authority: 'ECMWF Terms of Use for Open Data Products (retrieved 2026-08-15)',
  },
  {
    id: 'ecmwf-source',
    source: 'ECMWF Open Data — source line',
    text: 'Source www.ecmwf.int',
    href: 'https://www.ecmwf.int',
    surfaces: ['credits-page'],
    condition: 'derived:ecmwf',
    required: true,
    verified: true,
    authority: 'ECMWF Terms of Use for Open Data Products (retrieved 2026-08-15)',
  },
  {
    id: 'ecmwf-licence',
    source: 'ECMWF Open Data — licence statement',
    text:
      'This ECMWF data is published under a Creative Commons Attribution 4.0 ' +
      'International (CC BY 4.0). https://creativecommons.org/licenses/by/4.0/',
    href: 'https://creativecommons.org/licenses/by/4.0/',
    surfaces: ['credits-page'],
    condition: 'derived:ecmwf',
    required: true,
    verified: true,
    authority: 'ECMWF Terms of Use for Open Data Products (retrieved 2026-08-15)',
  },
  {
    id: 'ecmwf-liability',
    source: 'ECMWF Open Data — disclaimer',
    text:
      'ECMWF does not accept any liability whatsoever for any error or omission in the ' +
      'data, their availability, or for any loss or damage arising from their use.',
    surfaces: ['credits-page'],
    condition: 'derived:ecmwf',
    required: true,
    verified: true,
    authority: 'ECMWF Terms of Use for Open Data Products (retrieved 2026-08-15)',
  },
  {
    id: 'ecmwf-modified',
    source: 'ECMWF Open Data — modification indication',
    // Our wording, not a provider-mandated string: ECMWF dictates that the indication be
    // present ("where applicable") and CC BY 4.0 independently requires "indicate if
    // changes were made", but neither dictates the sentence. It is mandatory for us
    // regardless of the qualifier, because everything we publish from this feed is
    // resampled, interpolated or fed into a derived index. This is the one ECMWF line a
    // reviewer may re-word; the four above may not be touched.
    text: 'ECMWF data has been modified.',
    surfaces: ['credits-page'],
    condition: 'derived:ecmwf',
    required: true,
    verified: true,
    authority: 'ECMWF Terms of Use + CC BY 4.0 §3(a)(1)(B); wording ours',
  },
  {
    id: 'copernicus-dem-distribution',
    source: 'Copernicus DEM GLO-30 — distribution/communication',
    text:
      '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under ' +
      'COPERNICUS by the European Union and ESA; all rights reserved.',
    surfaces: ['credits-page'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'COP-DEM-GLO-30-F licence, Art. 6(a)',
  },
  {
    id: 'copernicus-dem-adapted',
    source: 'Copernicus DEM GLO-30 — adapted (slope, aspect, hillshade)',
    text:
      'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence ' +
      'and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; ' +
      'all rights reserved',
    surfaces: ['credits-page'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'COP-DEM-GLO-30-F licence, Art. 6(b)',
  },
  {
    id: 'copernicus-dem-liability',
    source: 'Copernicus DEM GLO-30 — liability sentence',
    text:
      'The organisations in charge of the Copernicus programme by law or by delegation ' +
      'do not incur any liability for any use of the Copernicus WorldDEM-30',
    surfaces: ['credits-page'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'COP-DEM-GLO-30-F licence, Art. 6(c)',
  },
  {
    id: 'terrarium-short',
    source: 'Terrarium terrain tiles (Tilezen/Mapzen composite)',
    text: 'Terrain: Mapzen/Tilezen & sources',
    surfaces: ['map-corner'],
    condition: 'layer:terrain',
    required: true,
    verified: true,
    authority: 'tilezen/joerd attribution.md',
  },
  {
    id: 'terrarium-eu-dem',
    source: 'Terrarium terrain tiles — EU-DEM component',
    text:
      'Produced using Copernicus data and information funded by the European Union - ' +
      'EU-DEM layers',
    surfaces: ['credits-page'],
    condition: 'layer:terrain',
    required: true,
    verified: true,
    authority: 'tilezen/joerd attribution.md',
  },
  {
    id: 'terrarium-usgs',
    source: 'Terrarium terrain tiles — USGS component',
    text: 'courtesy of the U.S. Geological Survey',
    surfaces: ['credits-page'],
    condition: 'layer:terrain',
    required: true,
    verified: true,
    authority: 'tilezen/joerd attribution.md',
  },
  {
    id: 'terrarium-etopo1',
    source: 'Terrarium terrain tiles — NOAA ETOPO1 component',
    // UNVERIFIED: docs/DATA-SOURCES.md records that an ETOPO1 credit is owed but not its
    // exact wording. Copy it verbatim from tilezen/joerd attribution.md in the same PR
    // that lands the terrain layer, then flip verified to true.
    text: 'ETOPO1 1 Arc-Minute Global Relief Model courtesy of NOAA',
    surfaces: ['credits-page'],
    condition: 'layer:terrain',
    required: true,
    verified: false,
    authority: 'tilezen/joerd attribution.md — wording not yet checked against source',
  },
  {
    id: 'landsat',
    source: 'Landsat 8/9',
    text: 'Landsat imagery courtesy of USGS',
    surfaces: ['credits-page'],
    condition: 'layer:landsat',
    required: true,
    verified: true,
    authority: 'USGS courtesy line',
  },
  {
    id: 'esri-world-imagery',
    source: 'Esri World Imagery (optional toggle)',
    // Never hand-coded: the ArcGIS MapLibre plugin renders "Powered by Esri" plus a live
    // provider list that changes without notice (Maxar became Vantor). CI-13 asserts the
    // plugin's element is present, not our copy of its words.
    text: 'Powered by Esri',
    surfaces: ['map-corner'],
    condition: 'toggle:esri',
    required: true,
    pluginInjected: true,
    verified: true,
    authority: 'Esri Master Agreement + ArcGIS attribution docs',
  },
  {
    id: 'geonames',
    source: 'GeoNames gazetteer (place search, built by infra/geodata)',
    // CC BY 4.0 requires appropriate credit and a licence link but prescribes no sentence;
    // this is our chosen form, as for EFFIS. The derivation sentence below indicates changes.
    text: 'Place names: GeoNames (geonames.org), CC BY 4.0',
    verbatim: 'GeoNames',
    href: 'https://www.geonames.org/',
    surfaces: ['credits-page'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'GeoNames export readme + CC BY 4.0 §3(a) — our chosen form',
  },
  {
    id: 'natural-earth',
    source: 'Natural Earth admin-1 (oblast boundaries for the region filter)',
    // Public domain: no credit is owed; Natural Earth asks for this line and we give it.
    text: 'Made with Natural Earth.',
    href: 'https://www.naturalearthdata.com/',
    surfaces: ['credits-page'],
    condition: 'always',
    required: false,
    verified: true,
    authority: 'naturalearthdata.com terms of use — requested, not required',
  },
  {
    id: 'celestrak',
    source: 'CelesTrak GP orbital elements (satellite-pass predictions, TASKS F15)',
    // CelesTrak asks to be cited when its data is used publicly and prescribes no sentence;
    // the wording is ours. We publish predicted pass times computed from the elements,
    // never the elements themselves.
    text: 'Orbital elements: CelesTrak (celestrak.org)',
    verbatim: 'CelesTrak',
    href: 'https://celestrak.org/',
    surfaces: ['credits-page'],
    condition: 'always',
    required: false,
    verified: true,
    authority: 'CelesTrak GP data documentation — citation requested; our chosen form',
  },
  {
    id: 'eea-natura2000',
    source: 'EEA Natura 2000 sites (protected-site layer and event note, V2-F1)',
    // CC BY 4.0 requires appropriate credit and a licence link but the EEA prescribes no
    // sentence; this is our chosen form. Always owed: the event note reads the sites
    // whether or not the layer is drawn. The derivation sentence indicates the changes
    // (clipped to the served box, simplified).
    text: 'Natura 2000 sites © European Environment Agency (EEA), CC BY 4.0',
    verbatim: 'European Environment Agency',
    href: 'https://www.eea.europa.eu/data-and-maps/data/natura-12',
    surfaces: ['credits-page'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'EEA legal notice + CC BY 4.0 §3(a) — our chosen form',
  },
  {
    id: 'esa-worldcover',
    source: 'ESA WorldCover 2021 v200 (land-cover note, V2-F4)',
    // The PUM §5.2 string, verbatim. Always owed: the event note reads the grid on every
    // opened event. The derivation sentence indicates the changes (pooled to 0.02°, eight
    // class groups, shares in tenths).
    text:
      '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) ' +
      'processed by ESA WorldCover consortium',
    verbatim: 'ESA WorldCover project 2021',
    href: 'https://doi.org/10.5281/zenodo.7254221',
    surfaces: ['credits-page'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'WorldCover PUM V2.0 §5.2',
  },
  {
    id: 'meteoalarm',
    source: 'MeteoAlarm national warning feeds (forest-fire and heat warnings, V2-B3)',
    // The legacy Atom feeds carry this sentence in their <rights> element. The warnings
    // themselves stay the national services' own: we relay level, area and validity and
    // link back to MeteoAlarm, never rewording a warning as ours.
    text: `Copyright © ${YEAR_PLACEHOLDER} MeteoAlarm.Org. Licensed under terms equivalent to CC BY 4.0`,
    verbatim: 'MeteoAlarm',
    href: 'https://meteoalarm.org',
    surfaces: ['credits-page'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'MeteoAlarm legacy Atom feed <rights> element (read 2026-10-24)',
  },
  {
    id: 'copernicus-ems',
    source: 'Copernicus EMS Rapid Mapping activations (event-page badge, TASKS V2-E3)',
    // The citation guidelines prescribe "Copernicus Emergency Management Service (© YEAR
    // European Union), [activation code]" for a map or product; the badge itself carries
    // that form with its code, and this line names what the rest of the product uses: the
    // activation list (code, name, times, area-of-interest extents), never the maps.
    text: `Copernicus Emergency Management Service (© ${YEAR_PLACEHOLDER} European Union), Rapid Mapping activation list`,
    verbatim: `Copernicus Emergency Management Service (© ${YEAR_PLACEHOLDER} European Union)`,
    href: 'https://mapping.emergency.copernicus.eu/',
    surfaces: ['credits-page'],
    condition: 'always',
    required: true,
    verified: true,
    authority:
      'Copernicus EMS citation guidelines (mapping.emergency.copernicus.eu/about/citation-guidelines/); Regulation (EU) 2021/696',
  },
  {
    id: 'derivation',
    source: 'Fire Watch — derivation sentence',
    // Satisfies CC BY "indicate changes" for every row above and keeps our output from
    // reading as an official product.
    text:
      `Fire events shown on this map are derived by ${PRODUCT_PLACEHOLDER} from the ` +
      'sources above (clustering, filtering, enrichment). Errors and omissions are ours, ' +
      "not the data providers'.",
    surfaces: ['credits-page', 'about', 'api'],
    condition: 'always',
    required: true,
    verified: true,
    authority: 'ADR-001 A1.4',
  },
  {
    id: 'eox-cloudless',
    source: 'EOX Sentinel-2 cloudless 2018+',
    // Layer dropped (ADR-001 A1.3): 2018+ is non-commercial without a paid contract.
    // Kept here as a tripwire so re-adding the layer means re-reading this line.
    text:
      'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified ' +
      `Copernicus Sentinel data ${YEAR_PLACEHOLDER})`,
    surfaces: ['credits-page'],
    condition: 'never',
    required: true,
    verified: true,
    authority: 'EOX licence page — layer not shipped',
  },
];

/**
 * The assembled map-corner line. Kept as one string rather than joined from CREDITS at
 * render time: the corner has a fixed reading order and merges the two Copernicus rows
 * into a single clause, which no generic join would reproduce.
 */
export const MAP_CORNER_LINE =
  '© OpenStreetMap contributors | © OpenMapTiles | Fire data: NASA FIRMS · EUMETSAT LSA SAF | ' +
  `Contains modified Copernicus Sentinel data & Service information ${YEAR_PLACEHOLDER} | ` +
  'Terrain: Tilezen/Mapzen';

export interface RenderContext {
  /** Year of publication or distribution of the data actually used. */
  readonly year: number;
  /** Product name substituted into the derivation sentence. */
  readonly productName: string;
}

const YEAR_RE = /^\d{4}$/;

function substitute(text: string, context: RenderContext): string {
  const year = String(context.year);
  if (!YEAR_RE.test(year)) {
    throw new RangeError(`credits: year must be a four-digit year, received ${year}`);
  }
  if (context.productName.length === 0) {
    throw new RangeError('credits: productName must not be empty');
  }
  return text
    .split(YEAR_PLACEHOLDER)
    .join(year)
    .split(PRODUCT_PLACEHOLDER)
    .join(context.productName);
}

/** The credit as it appears on screen, with placeholders resolved. */
export function renderCredit(credit: Credit, context: RenderContext): string {
  return substitute(credit.text, context);
}

/**
 * The map-corner line as rendered, with the data year resolved. The corner control must
 * receive this, never `MAP_CORNER_LINE` itself — the raw constant still carries the
 * year placeholder.
 */
export function renderMapCornerLine(context: RenderContext): string {
  return substitute(MAP_CORNER_LINE, context);
}

/**
 * The substring CI-13 must find in the rendered block: the provider's own words, which
 * is the whole string unless we wrapped a verbatim clause in wording of ours.
 */
export function assertedText(credit: Credit, context: RenderContext): string {
  return substitute(credit.verbatim ?? credit.text, context);
}

/** The credits owed right now, given which layers and basemap are active. */
export function creditsFor(
  surface: CreditSurface,
  activeConditions: readonly CreditCondition[],
): readonly Credit[] {
  const active = new Set<CreditCondition>(activeConditions);
  active.add('always');
  return CREDITS.filter(
    (credit) =>
      credit.condition !== 'never' &&
      active.has(credit.condition) &&
      credit.surfaces.includes(surface),
  );
}

/**
 * The subset CI-13 asserts: owed, not optional, wording verified, and not rendered for
 * us by a third-party plugin.
 */
export function assertableCredits(
  surface: CreditSurface,
  activeConditions: readonly CreditCondition[],
): readonly Credit[] {
  return creditsFor(surface, activeConditions).filter(
    (credit) => credit.required && credit.verified && credit.pluginInjected !== true,
  );
}

/** A surface's actual output, reduced to what CI-13 reads: its visible text and its links. */
export interface RenderedAttribution {
  readonly text: string;
  readonly hrefs: readonly string[];
}

/** One owed credit a rendered surface does not carry. */
export interface AttributionGap {
  readonly creditId: string;
  /** `text`: the asserted wording is absent. `href`: the licence link is absent. */
  readonly missing: 'text' | 'href';
}

/**
 * CI-13's presence check: every credit {@link assertableCredits} says is owed on `surface`
 * under `activeConditions`, compared with what that surface actually rendered. The
 * expected set is walked from the registry, never copied into a test, so a credit added
 * here is asserted on every surface it names without anyone editing the gate.
 */
export function attributionGaps(
  surface: CreditSurface,
  activeConditions: readonly CreditCondition[],
  rendered: RenderedAttribution,
  context: RenderContext,
): readonly AttributionGap[] {
  const gaps: AttributionGap[] = [];
  for (const credit of assertableCredits(surface, activeConditions)) {
    if (!rendered.text.includes(assertedText(credit, context))) {
      gaps.push({ creditId: credit.id, missing: 'text' });
    }
    if (credit.href !== undefined && !rendered.hrefs.includes(credit.href)) {
      gaps.push({ creditId: credit.id, missing: 'href' });
    }
  }
  return gaps;
}

/**
 * The ECMWF attribution as one unit, in the order the Terms give the components.
 *
 * ECMWF requires the five strings *together* — the copyright statement alone, without the
 * source, licence link, disclaimer and modification indication, does not satisfy the
 * Terms. `creditsFor` cannot express that: it returns a filtered list, and nothing stops a
 * caller from rendering one row of it. This function is the unit, so a surface that shows
 * an ECMWF-derived value asks for the obligation rather than for a credit that happens to
 * be part of it. It throws rather than returning a short list, because a partial ECMWF
 * attribution is a licence breach and not a rendering degradation.
 */
export function ecmwfComponents(): readonly Credit[] {
  const order = [
    'ecmwf-service',
    'ecmwf-source',
    'ecmwf-licence',
    'ecmwf-liability',
    'ecmwf-modified',
  ] as const;
  return order.map((id) => {
    const credit = CREDITS.find((entry) => entry.id === id);
    if (credit === undefined) {
      throw new Error(
        `credits: the ECMWF attribution is incomplete — "${id}" is missing. All five ` +
          'components are required together by the ECMWF Terms of Use.',
      );
    }
    return credit;
  });
}
