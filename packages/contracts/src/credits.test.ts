import { describe, expect, it } from 'vitest';

import {
  CREDITS,
  CREDIT_SURFACE_OWNER,
  MAP_CORNER_LINE,
  PRODUCT_PLACEHOLDER,
  YEAR_PLACEHOLDER,
  assertableCredits,
  assertedText,
  attributionGaps,
  creditsFor,
  ecmwfComponents,
  renderCredit,
  renderMapCornerLine,
  type Credit,
  type CreditSurface,
  type RenderContext,
} from './credits.js';

const CONTEXT: RenderContext = { year: 2026, productName: 'Fire Watch' };

function credit(id: string): Credit {
  const found = CREDITS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no credit with id ${id}`);
  return found;
}

describe('the registry itself', () => {
  it('has unique ids', () => {
    const ids = CREDITS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every credit at least one surface', () => {
    for (const entry of CREDITS) {
      expect(entry.surfaces.length, `${entry.id} owes attribution nowhere`).toBeGreaterThan(0);
    }
  });

  it('leaves no placeholder unresolved after rendering', () => {
    for (const entry of CREDITS) {
      const rendered = renderCredit(entry, CONTEXT);
      expect(rendered, entry.id).not.toContain(YEAR_PLACEHOLDER);
      expect(rendered, entry.id).not.toContain(PRODUCT_PLACEHOLDER);
    }
  });

  it('keeps every asserted clause inside the string that is actually rendered', () => {
    // If this drifts, CI-13 would be asserting a substring that never reaches the page.
    for (const entry of CREDITS) {
      expect(renderCredit(entry, CONTEXT), entry.id).toContain(assertedText(entry, CONTEXT));
    }
  });
});

describe('wording that is the licence condition', () => {
  // These are reproduced from the provider, not written by us. A failure here means
  // someone paraphrased a string we are only allowed to redistribute data under.
  it('keeps the LANCE tactical-use disclaimer verbatim', () => {
    expect(renderCredit(credit('lance-tactical-disclaimer'), CONTEXT)).toBe(
      'Due to the spatial resolution and other characteristics of these data, their use ' +
        'for tactical decision-making or informing about conditions at a local scale are ' +
        'not advised.',
    );
  });

  it('asserts only the provider\'s clause of the "as is" sentence', () => {
    const asIs = credit('lance-as-is');
    expect(assertedText(asIs, CONTEXT)).toBe(
      'are provided "as is" and users bear all responsibility and liability for their use',
    );
    expect(renderCredit(asIs, CONTEXT)).toContain('These data ');
  });

  it('keeps all three Copernicus DEM sentences, including the liability one', () => {
    const dem = CREDITS.filter((entry) => entry.id.startsWith('copernicus-dem-'));
    expect(dem.map((entry) => entry.id)).toEqual([
      'copernicus-dem-distribution',
      'copernicus-dem-adapted',
      'copernicus-dem-liability',
    ]);
    expect(renderCredit(credit('copernicus-dem-liability'), CONTEXT)).toBe(
      'The organisations in charge of the Copernicus programme by law or by delegation ' +
        'do not incur any liability for any use of the Copernicus WorldDEM-30',
    );
  });

  it('keeps the four ECMWF strings ECMWF wrote, and only those, verbatim', () => {
    // The Terms print these; re-wording any of them is the breach. `ecmwf-modified` is
    // deliberately absent from this list: the indication is mandatory but the sentence
    // is ours, so it is the one ECMWF line a reviewer may edit.
    expect(credit('ecmwf-service').text).toBe(
      'This service is based on data and products of the European Centre for ' +
        'Medium-Range Weather Forecasts (ECMWF)',
    );
    expect(credit('ecmwf-source').text).toBe('Source www.ecmwf.int');
    expect(credit('ecmwf-licence').text).toBe(
      'This ECMWF data is published under a Creative Commons Attribution 4.0 ' +
        'International (CC BY 4.0). https://creativecommons.org/licenses/by/4.0/',
    );
    expect(credit('ecmwf-liability').text).toBe(
      'ECMWF does not accept any liability whatsoever for any error or omission in the ' +
        'data, their availability, or for any loss or damage arising from their use.',
    );
  });

  it('names the deriver in the derivation sentence', () => {
    expect(renderCredit(credit('derivation'), CONTEXT)).toBe(
      'Fire events shown on this map are derived by Fire Watch from the sources above ' +
        "(clustering, filtering, enrichment). Errors and omissions are ours, not the data providers'.",
    );
  });

  it('substitutes the year into every Copernicus formula', () => {
    expect(renderCredit(credit('sentinel-modified'), CONTEXT)).toBe(
      'Contains modified Copernicus Sentinel data 2026',
    );
    expect(renderCredit(credit('copernicus-service'), CONTEXT)).toBe(
      'Contains modified Copernicus Service information 2026',
    );
    expect(renderCredit(credit('eumetsat-meteosat'), CONTEXT)).toBe(
      'Contains modified EUMETSAT Meteosat data 2026',
    );
  });
});

describe('what is owed when', () => {
  it('always owes OpenStreetMap on the map corner, whatever the basemap', () => {
    const ids = creditsFor('map-corner', []).map((entry) => entry.id);
    expect(ids).toContain('osm');
  });

  it('owes the tile provider only while that basemap is in use', () => {
    expect(creditsFor('map-corner', []).map((e) => e.id)).not.toContain('openfreemap');
    expect(creditsFor('map-corner', ['basemap:openfreemap']).map((e) => e.id)).toContain(
      'openfreemap',
    );
  });

  it('owes the data credits, not the tile credits, to an API consumer', () => {
    // ADR-003 A1.3: the payload carries the obligations of the data it contains — the
    // detections' providers, the OSM-derived place name, the derivation statement and
    // the not-for-tactical-use disclaimer — and nothing about a basemap it does not ship.
    const api = creditsFor('api', ['basemap:openfreemap', 'layer:terrain']).map((e) => e.id);
    for (const id of [
      'osm',
      'firms-acknowledgement',
      'lance-tactical-disclaimer',
      'lance-as-is',
      'eumetsat-meteosat',
      'lsa-saf-long',
      'sentinel-modified',
      'copernicus-service',
      'derivation',
    ]) {
      expect(api, id).toContain(id);
    }
    expect(api).not.toContain('openfreemap');
    expect(api).not.toContain('terrarium-eu-dem');
  });

  it('never renders a dropped layer credit', () => {
    // eox-cloudless is a tripwire, not a rendered string: the layer is not shipped.
    const surfaces = Object.keys(CREDIT_SURFACE_OWNER) as CreditSurface[];
    const everySurface = surfaces.flatMap((surface) =>
      creditsFor(surface, []).map((entry) => entry.id),
    );
    expect(everySurface).not.toContain('eox-cloudless');
  });

  it('excludes plugin-injected and unverified wording from the assertion set', () => {
    const esri = assertableCredits('map-corner', ['toggle:esri']).map((entry) => entry.id);
    expect(esri).not.toContain('esri-world-imagery');

    const terrain = assertableCredits('credits-page', ['layer:terrain']).map((entry) => entry.id);
    expect(terrain).toContain('terrarium-eu-dem');
    expect(terrain).not.toContain('terrarium-etopo1');
  });

  it('excludes credits the provider only requests', () => {
    expect(assertableCredits('map-corner', ['basemap:protomaps']).map((e) => e.id)).not.toContain(
      'protomaps',
    );
  });
});

describe('the ECMWF attribution as one unit', () => {
  const IDS = [
    'ecmwf-service',
    'ecmwf-source',
    'ecmwf-licence',
    'ecmwf-liability',
    'ecmwf-modified',
  ];

  it('owes all five components together, or none of them', () => {
    const off = creditsFor('credits-page', []).map((entry) => entry.id);
    for (const id of IDS)
      expect(off, `${id} is owed with no ECMWF-derived value on the page`).not.toContain(id);

    const on = creditsFor('credits-page', ['derived:ecmwf']).map((entry) => entry.id);
    for (const id of IDS)
      expect(on, `${id} is not owed although a derived value is shown`).toContain(id);
  });

  it('returns the components in the order the Terms give them', () => {
    expect(ecmwfComponents().map((entry) => entry.id)).toEqual(IDS);
  });

  it('asserts every component, since all five are required and verified', () => {
    const asserted = assertableCredits('credits-page', ['derived:ecmwf']).map((entry) => entry.id);
    for (const id of IDS) expect(asserted, id).toContain(id);
  });

  it('owes them on the credits page only', () => {
    // The map corner cannot carry a four-sentence disclaimer; the Terms' "prominently"
    // is satisfied by the credits page, not by shrinking the wording to fit a corner.
    for (const surface of ['map-corner', 'about', 'alert-footer', 'api'] as const) {
      const ids = creditsFor(surface, ['derived:ecmwf']).map((entry) => entry.id);
      for (const id of IDS) expect(ids, `${id} on ${surface}`).not.toContain(id);
    }
  });
});

describe('the assembled map-corner line', () => {
  it('carries every mandatory corner clause', () => {
    const line = MAP_CORNER_LINE.split(YEAR_PLACEHOLDER).join('2026');
    expect(line).toContain('© OpenStreetMap contributors');
    expect(line).toContain('© OpenMapTiles');
    expect(line).toContain('NASA FIRMS');
    expect(line).toContain('EUMETSAT LSA SAF');
    expect(line).toContain('Contains modified Copernicus Sentinel data & Service information 2026');
  });

  it('renders with the year resolved and no placeholder left', () => {
    const rendered = renderMapCornerLine(CONTEXT);
    expect(rendered).toContain(
      'Contains modified Copernicus Sentinel data & Service information 2026',
    );
    expect(rendered).not.toContain(YEAR_PLACEHOLDER);
  });
});

describe('render context validation', () => {
  it('rejects a year that is not four digits', () => {
    expect(() => renderCredit(credit('sentinel-modified'), { ...CONTEXT, year: 26 })).toThrow(
      RangeError,
    );
  });

  it('rejects an empty product name', () => {
    expect(() => renderCredit(credit('derivation'), { ...CONTEXT, productName: '' })).toThrow(
      RangeError,
    );
  });
});

describe('attributionGaps — the CI-13 presence check', () => {
  const about = assertableCredits('about', []);
  const full = {
    text: about.map((entry) => renderCredit(entry, CONTEXT)).join('\n'),
    hrefs: [],
  };

  it('finds nothing missing when every owed credit is rendered', () => {
    expect(about.length).toBeGreaterThan(0);
    expect(attributionGaps('about', [], full, CONTEXT)).toStrictEqual([]);
  });

  it('names the credit whose wording was dropped', () => {
    const dropped = renderCredit(credit('derivation'), CONTEXT);
    const rendered = { ...full, text: full.text.replace(dropped, '') };
    expect(attributionGaps('about', [], rendered, CONTEXT)).toStrictEqual([
      { creditId: 'derivation', missing: 'text' },
    ]);
  });

  it('asserts only the verbatim clause, so our connective words stay editable', () => {
    const rendered = {
      text: assertableCredits('alert-footer', [])
        .map((entry) => assertedText(entry, CONTEXT))
        .join(' '),
      hrefs: [],
    };
    expect(rendered.text).not.toContain('These data ');
    expect(attributionGaps('alert-footer', [], rendered, CONTEXT)).toStrictEqual([]);
  });

  it('reports a licence link the surface does not carry', () => {
    const osm = renderCredit(credit('osm'), CONTEXT);
    const gaps = attributionGaps('map-corner', [], { text: osm, hrefs: [] }, CONTEXT);
    expect(gaps).toContainEqual({ creditId: 'osm', missing: 'href' });
    expect(gaps).not.toContainEqual({ creditId: 'osm', missing: 'text' });
  });

  it('asks nothing of a credit the context does not owe', () => {
    const gaps = attributionGaps('map-corner', [], { text: '', hrefs: [] }, CONTEXT);
    expect(gaps.map((gap) => gap.creditId)).not.toContain('openfreemap');
    const onBasemap = attributionGaps(
      'map-corner',
      ['basemap:openfreemap'],
      { text: '', hrefs: [] },
      CONTEXT,
    );
    expect(onBasemap.map((gap) => gap.creditId)).toContain('openfreemap');
  });
});
