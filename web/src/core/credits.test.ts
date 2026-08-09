import { describe, expect, it } from 'vitest';

import {
  CREDITS,
  MAP_CORNER_LINE,
  PRODUCT_PLACEHOLDER,
  YEAR_PLACEHOLDER,
  assertableCredits,
  assertedText,
  creditsFor,
  renderCredit,
  type Credit,
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

  it('never renders a dropped layer credit', () => {
    // eox-cloudless is a tripwire, not a rendered string: the layer is not shipped.
    const everySurface = (['map-corner', 'credits-page', 'about', 'alert-footer'] as const).flatMap(
      (surface) => creditsFor(surface, []).map((entry) => entry.id),
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

describe('the assembled map-corner line', () => {
  it('carries every mandatory corner clause', () => {
    const line = MAP_CORNER_LINE.split(YEAR_PLACEHOLDER).join('2026');
    expect(line).toContain('© OpenStreetMap contributors');
    expect(line).toContain('© OpenMapTiles');
    expect(line).toContain('NASA FIRMS');
    expect(line).toContain('EUMETSAT LSA SAF');
    expect(line).toContain('Contains modified Copernicus Sentinel data & Service information 2026');
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
