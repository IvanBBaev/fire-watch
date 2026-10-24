import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  CEMS_MAX_STALENESS_MS,
  parseCemsDocument,
  parseCemsOutside,
  selectCems,
} from './cems-document.js';

const DOCUMENT = {
  schema_version: 1,
  available_at: '2026-10-24T09:00:00Z',
  activations: [
    {
      code: 'EMSR822',
      name: 'Wildfire in Bulgaria and Republic of Serbia',
      event_time: '2025-07-26T08:00:00Z',
      activation_time: '2025-07-26T20:04:00Z',
      last_update: '2025-08-05T15:29:32.927Z',
      closed: true,
      countries: ['Bulgaria'],
      centroid: [23.416672, 41.721618],
      aois: [[23.1987, 41.6323, 23.3816, 41.75]],
      aois_status: 'public',
    },
  ],
};

describe('parseCemsDocument', () => {
  it('reads the stored document', () => {
    expect(parseCemsDocument(JSON.stringify(DOCUMENT))).toEqual(DOCUMENT);
  });

  it('refuses a stored document that carries attribution (the route adds it)', () => {
    const served = { ...DOCUMENT, attribution: [{ id: 'x', source: 's', text: 't' }] };
    expect(parseCemsDocument(JSON.stringify(served))).toBeNull();
  });

  it('refuses text that is not the document', () => {
    expect(parseCemsDocument('{')).toBeNull();
    expect(parseCemsDocument('{"schema_version":2}')).toBeNull();
  });
});

describe('selectCems', () => {
  const body = parseCemsDocument(JSON.stringify(DOCUMENT))!;
  const at = epochMsFromIso(DOCUMENT.available_at);

  it('serves up to six hours after the last list read, then calls it stale', () => {
    expect(selectCems(body, at + CEMS_MAX_STALENESS_MS)).toEqual({ ok: true, body });
    expect(selectCems(body, at + CEMS_MAX_STALENESS_MS + 1)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});

describe('parseCemsOutside', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const text = JSON.stringify({
      EMSR922: '2026-09-18T08:34:57.039Z',
      EMSR923: 'yesterday',
      'not-a-code': '2026-09-18T08:34:57Z',
    });
    expect([...parseCemsOutside(text)]).toEqual([['EMSR922', '2026-09-18T08:34:57.039Z']]);
  });

  it('reads anything malformed as empty', () => {
    for (const text of ['{', '[]', 'null', '1']) expect(parseCemsOutside(text).size).toBe(0);
  });
});
