import { describe, expect, it } from 'vitest';

import { createRedactor, patternOnlyRedactor, placeholder } from './redact.js';

/**
 * Not a key. Never was a key, and could not be one: `notarealfirmskey` is written on the
 * front of it, and the remaining sixteen characters are zeroes. It has the *shape* of a
 * FIRMS map key — 32 alphanumerics — because shape is what the redactor matches on, and a
 * test that used a shapeless placeholder would pass while the real thing leaked.
 */
const FAKE_MAP_KEY = 'notarealfirmskey0000000000000000';

/** Equally fake, and the reason the DSN leg exists: a password inside a URL. */
const FAKE_DATABASE_URL = 'postgres://fire_watch:notarealpassword@db.invalid:5432/fire_watch';

const FIRMS_URL =
  `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FAKE_MAP_KEY}` +
  '/VIIRS_SNPP_NRT/-10,35,45,72/1/2026-08-14';

describe('createRedactor — known secret values', () => {
  it('replaces a held secret wherever it appears, not only in a URL', () => {
    const redactor = createRedactor([FAKE_MAP_KEY]);

    const output = redactor.text(`key ${FAKE_MAP_KEY} used by ${FAKE_MAP_KEY} again`);

    expect(output).toBe('key <32 characters> used by <32 characters> again');
  });

  it('describes the length instead of showing a prefix', () => {
    const redactor = createRedactor([FAKE_MAP_KEY]);

    const output = redactor.text(FIRMS_URL);

    // A prefix would be a search-space reduction handed to whoever reads the log.
    expect(output).not.toContain(FAKE_MAP_KEY.slice(0, 8));
    expect(output).toContain(placeholder(FAKE_MAP_KEY.length));
  });

  it('replaces the longest secret first, so a DSN is not left as a shell of itself', () => {
    const redactor = createRedactor(['notarealpassword', FAKE_DATABASE_URL]);

    expect(redactor.text(`connecting to ${FAKE_DATABASE_URL}`)).toBe(
      `connecting to ${placeholder(FAKE_DATABASE_URL.length)}`,
    );
  });

  it('ignores values too short to be a credential', () => {
    // Redacting every occurrence of `app` would shred the logs it exists to keep readable.
    const redactor = createRedactor(['app', '', 'fire']);

    expect(redactor.text('the app role is fire_watch_app')).toBe('the app role is fire_watch_app');
  });
});

describe('createRedactor — credential-shaped URL components', () => {
  it('redacts a FIRMS key it was never told about, from the URL path', () => {
    // The C8 case: the key is a path segment, so there is no `?key=` to strip and no field
    // name to blocklist — and an upstream error can carry a key config never saw.
    const output = patternOnlyRedactor.text(`request to ${FIRMS_URL} failed`);

    expect(output).not.toContain(FAKE_MAP_KEY);
    expect(output).toContain('<32 characters>');
  });

  it('keeps everything about the URL that makes the failure diagnosable', () => {
    const output = patternOnlyRedactor.text(FIRMS_URL);

    expect(output).toBe(
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/<32 characters>' +
        '/VIIRS_SNPP_NRT/-10,35,45,72/1/2026-08-14',
    );
  });

  it('finds a URL glued to digits or punctuation in front of its scheme', () => {
    // The scheme match starts at the beginning of a character run (the fix for a
    // quadratic rescan); a run that begins with digits must still yield its URL.
    expect(patternOnlyRedactor.text(`status 401https://api.invalid/v1/${FAKE_MAP_KEY}`)).toBe(
      'status 401https://api.invalid/v1/<32 characters>',
    );
    expect(patternOnlyRedactor.text(`(${FIRMS_URL})`)).not.toContain(FAKE_MAP_KEY);
    expect(patternOnlyRedactor.text('123://not-a-url/0000000000000000abcdefgh')).toBe(
      '123://not-a-url/0000000000000000abcdefgh',
    );
  });

  it('scans a long run with no URL in linear time', () => {
    // Before 2026-09-26 the URL pattern retried its scheme from every position of a
    // letter run: 200 000 letters took about a minute.
    const started = performance.now();
    patternOnlyRedactor.text('a'.repeat(200_000));
    patternOnlyRedactor.text(`${'1'.repeat(200_000)}:${'a'.repeat(200_000)}`);

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('leaves ordinary path segments alone', () => {
    const url = 'https://ies-ows.jrc.ec.europa.eu/gwis?LAYERS=ecmwf.fwi&TIME=2026-08-14';

    expect(patternOnlyRedactor.text(url)).toBe(url);
  });

  it('redacts the password out of a database URL it does not hold', () => {
    const output = patternOnlyRedactor.text(`pool error on ${FAKE_DATABASE_URL}`);

    expect(output).not.toContain('notarealpassword');
    expect(output).toContain('postgres://fire_watch:<16 characters>@db.invalid:5432/fire_watch');
  });

  it('redacts query values by name and by shape', () => {
    const byName = patternOnlyRedactor.text('https://api.invalid/v1?MAP_KEY=shortish1&page=2');
    const byShape = patternOnlyRedactor.text(`https://api.invalid/v1?q=${FAKE_MAP_KEY}&page=2`);

    expect(byName).toBe('https://api.invalid/v1?MAP_KEY=<9 characters>&page=2');
    expect(byShape).toBe('https://api.invalid/v1?q=<32 characters>&page=2');
  });

  it('leaves digests and ids in free text readable', () => {
    // The deliberate trade-off: rule 2 is scoped to URL-looking substrings, because a
    // redactor that ate every hash would be routed around, and one nobody routes through
    // redacts nothing.
    const line = 'digest 9f2c1b0a4e6d8f7a9f2c1b0a4e6d8f7a9f2c1b0a4e6d8f7a9f2c1b0a4e6d8f7a matched';

    expect(patternOnlyRedactor.text(line)).toBe(line);
  });

  it('does not re-redact an existing marker into a lie about its own length', () => {
    // `describeConfig` already writes `<32 characters>`; redacting that would turn a true
    // statement about the key's length into a false one about the marker's.
    const described = { firms_map_key: '<32 characters>', heartbeat: '<configured>' };

    expect(patternOnlyRedactor.value(described)).toStrictEqual(described);
  });
});

describe('createRedactor — errors', () => {
  it('follows the cause chain, where fetch keeps the URL', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error(`connect ECONNREFUSED for ${FIRMS_URL}`),
    });

    const described = patternOnlyRedactor.error(error);

    expect(described).not.toContain(FAKE_MAP_KEY);
    expect(described).toBe(
      'fetch failed: connect ECONNREFUSED for ' +
        'https://firms.modaps.eosdis.nasa.gov/api/area/csv/<32 characters>' +
        '/VIIRS_SNPP_NRT/-10,35,45,72/1/2026-08-14',
    );
  });

  it('redacts a stack, and reports none when there is none', () => {
    const error = new Error(`GET ${FIRMS_URL} → 401`);

    const stack = patternOnlyRedactor.stack(error);

    expect(stack).not.toBeNull();
    expect(stack).not.toContain(FAKE_MAP_KEY);
    expect(stack).toContain('<32 characters>');
    expect(patternOnlyRedactor.stack(`GET ${FIRMS_URL}`)).toBeNull();
  });

  it('renders a thrown non-error without leaking it', () => {
    expect(patternOnlyRedactor.error(FIRMS_URL)).not.toContain(FAKE_MAP_KEY);
  });

  it('looks inside a thrown object rather than flattening it to [object Object]', () => {
    // `String({url})` would hide the URL from the redactor and from the operator alike —
    // and the value would then reach some other printer intact.
    const described = patternOnlyRedactor.error(
      new Error('rejected', { cause: { url: FIRMS_URL } }),
    );

    expect(described).not.toContain(FAKE_MAP_KEY);
    expect(described).toContain('<32 characters>');
  });
});

describe('createRedactor — structural values', () => {
  it('redacts nested strings and arrays without renaming keys', () => {
    const redactor = createRedactor([FAKE_MAP_KEY]);

    const output = redactor.value({
      ingest_cycle: {
        sources: [
          { source: 'firms:viirs:snpp', error: `GET ${FIRMS_URL} → 401` },
          { source: 'firms:modis', error: null },
        ],
      },
    });

    expect(output).toStrictEqual({
      ingest_cycle: {
        sources: [
          {
            source: 'firms:viirs:snpp',
            error:
              'GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/<32 characters>' +
              '/VIIRS_SNPP_NRT/-10,35,45,72/1/2026-08-14 → 401',
          },
          { source: 'firms:modis', error: null },
        ],
      },
    });
  });

  it('redacts by field name a value no pattern would catch', () => {
    // The field-name leg is the backstop for values too word-like for the shape leg.
    const wordy = 'a plain sentence that happens to be the key';

    expect(patternOnlyRedactor.value({ firms_map_key: wordy, note: wordy })).toStrictEqual({
      firms_map_key: placeholder(wordy.length),
      note: wordy,
    });
  });

  it('turns an Error property into its redacted description', () => {
    const output = patternOnlyRedactor.value({ failure: new Error(`GET ${FIRMS_URL}`) });

    expect(output).toStrictEqual({
      failure:
        'GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/<32 characters>' +
        '/VIIRS_SNPP_NRT/-10,35,45,72/1/2026-08-14',
    });
  });

  it('replaces a value deeper than the guard rather than passing it through', () => {
    let deep: unknown = { url: FIRMS_URL };
    for (let level = 0; level < 25; level++) deep = { nested: deep };

    // "Unreadable" is a bug report; "unredacted" is an incident.
    expect(JSON.stringify(patternOnlyRedactor.value(deep))).toContain('<depth limit>');
    expect(JSON.stringify(patternOnlyRedactor.value(deep))).not.toContain(FAKE_MAP_KEY);
  });

  it('leaves non-string scalars as they are', () => {
    expect(patternOnlyRedactor.value({ count: 3, ok: true, missing: null })).toStrictEqual({
      count: 3,
      ok: true,
      missing: null,
    });
  });
});
