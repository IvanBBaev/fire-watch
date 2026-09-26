import { describe, expect, it } from 'vitest';

import { buildAreaQuery } from '../../core/ingest/firms-poller.js';
import type { Clock } from '../../core/ports/clock.js';
import type { FirmsAreaQuery } from '../../core/ports/firms-client.js';
import {
  FIRMS_AVAILABILITY_BASE_URL,
  FIRMS_BASE_URL,
  FirmsHttpError,
  areaUrl,
  availabilityUrl,
  createFirmsHttpClient,
} from './firms-http-client.js';

/** Shaped like a real one — 32 characters, alphanumeric — but obviously not one. */
const MAP_KEY = 'testtesttesttesttesttesttesttest';

const QUERY: FirmsAreaQuery = {
  source: 'firms:viirs:snpp',
  product: 'VIIRS_SNPP_NRT',
  area: '20,39,31,46',
  dayRange: 2,
};

function fixedClock(now: number): Clock {
  return { now: () => now };
}

interface FetchLog {
  readonly urls: string[];
  readonly fetch: typeof globalThis.fetch;
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function requestedUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function stubFetch(handler: (url: string) => Response | Promise<Response> | Error): FetchLog {
  const urls: string[] = [];
  return {
    urls,
    fetch: (input: FetchInput) => {
      const url = requestedUrl(input);
      urls.push(url);
      const outcome = handler(url);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

function client(log: FetchLog, now = 1_754_130_000_000) {
  return createFirmsHttpClient({ mapKey: MAP_KEY, clock: fixedClock(now), fetch: log.fetch });
}

describe('areaUrl', () => {
  it('is the documented path shape', () => {
    expect(areaUrl(FIRMS_BASE_URL, MAP_KEY, QUERY)).toBe(
      `${FIRMS_BASE_URL}/${MAP_KEY}/VIIRS_SNPP_NRT/20,39,31,46/2`,
    );
  });

  it('appends the start date only on a backfill query', () => {
    expect(areaUrl(FIRMS_BASE_URL, MAP_KEY, { ...QUERY, startDate: '2025-07-14' })).toMatch(
      /\/2\/2025-07-14$/,
    );
  });

  it('leaves the bbox commas alone, as the documented URL has them', () => {
    // A comma is legal unencoded in a path segment; sending `%2C` would bet the season on
    // FIRMS decoding the path before routing it.
    expect(areaUrl(FIRMS_BASE_URL, MAP_KEY, QUERY)).toContain('/20,39,31,46/');
  });

  it('encodes every segment so nothing can escape into the path', () => {
    const url = areaUrl(FIRMS_BASE_URL, MAP_KEY, { ...QUERY, product: '../../admin' });

    expect(url).not.toContain('../');
    expect(url).toContain('..%2F..%2Fadmin');
  });

  it('refuses a day range the API does not accept', () => {
    expect(() => areaUrl(FIRMS_BASE_URL, MAP_KEY, { ...QUERY, dayRange: 0 })).toThrow(/1\.\.10/);
    expect(() => areaUrl(FIRMS_BASE_URL, MAP_KEY, { ...QUERY, dayRange: 2.5 })).toThrow(/integer/);
  });

  it('carries the query the core built, day range and all', () => {
    // The core decides `day_range=2` (pitfall 2); the adapter only addresses it.
    expect(areaUrl(FIRMS_BASE_URL, MAP_KEY, buildAreaQuery('firms:viirs:noaa20'))).toContain(
      '/VIIRS_NOAA20_NRT/20,39,31,46/2',
    );
  });
});

describe('availabilityUrl', () => {
  it('is the documented path shape, with the key as a path segment', () => {
    expect(availabilityUrl(FIRMS_AVAILABILITY_BASE_URL, MAP_KEY, 'VIIRS_SNPP_NRT')).toBe(
      `${FIRMS_AVAILABILITY_BASE_URL}/${MAP_KEY}/VIIRS_SNPP_NRT`,
    );
  });

  it('encodes the product so it cannot escape into the path', () => {
    expect(availabilityUrl(FIRMS_AVAILABILITY_BASE_URL, MAP_KEY, '../../admin')).toContain(
      '..%2F..%2Fadmin',
    );
  });

  it('refuses an empty product', () => {
    expect(() => availabilityUrl(FIRMS_AVAILABILITY_BASE_URL, MAP_KEY, ' ')).toThrow(/product/);
  });
});

describe('createFirmsHttpClient — data availability (pitfall 10)', () => {
  const availabilityQuery = { source: 'firms:viirs:snpp', product: 'VIIRS_SNPP_NRT' } as const;

  it('asks the data_availability endpoint and stamps fetched_at from the clock', async () => {
    const log = stubFetch(() => new Response('data_id,min_date,max_date\n'));

    const result = await client(log, 1_754_130_000_000).fetchDataAvailability?.(availabilityQuery);

    expect(log.urls).toEqual([`${FIRMS_AVAILABILITY_BASE_URL}/${MAP_KEY}/VIIRS_SNPP_NRT`]);
    expect(result?.csv).toBe('data_id,min_date,max_date\n');
    expect(result?.fetchedAt).toBe(1_754_130_000_000);
  });

  it('follows a redirected base url instead of leaving one leg pointed at NASA', async () => {
    // A test or a mirror that redirects the area fetch must not have its health check
    // quietly talk to the internet.
    const log = stubFetch(() => new Response(''));
    const redirected = createFirmsHttpClient({
      mapKey: MAP_KEY,
      clock: fixedClock(0),
      fetch: log.fetch,
      baseUrl: 'http://127.0.0.1:9/api/area/csv',
    });

    await redirected.fetchDataAvailability?.(availabilityQuery);

    expect(log.urls[0]).toBe(
      `http://127.0.0.1:9/api/data_availability/csv/${MAP_KEY}/VIIRS_SNPP_NRT`,
    );
  });

  it('redacts the key from an availability failure too', async () => {
    const log = stubFetch(
      (url) => new TypeError(`fetch failed: ECONNREFUSED while requesting ${url}`),
    );

    const error = await client(log)
      .fetchDataAvailability?.(availabilityQuery)
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message).not.toContain(MAP_KEY);
    expect((error as Error).message).toContain('<MAP_KEY>');
    expect((error as Error).message).toContain('VIIRS_SNPP_NRT availability');
  });
});

describe('createFirmsHttpClient', () => {
  it('returns the body and stamps available_at from the clock', async () => {
    const log = stubFetch(() => new Response('country_id,latitude\n'));

    const result = await client(log, 1_754_130_000_000).fetchArea(QUERY);

    expect(result.csv).toBe('country_id,latitude\n');
    expect(result.availableAt).toBe(1_754_130_000_000);
  });

  it('requests exactly one URL, built from the key it holds', async () => {
    const log = stubFetch(() => new Response(''));

    await client(log).fetchArea(QUERY);

    expect(log.urls).toHaveLength(1);
    expect(log.urls[0]).toContain(`/${MAP_KEY}/VIIRS_SNPP_NRT/`);
  });

  it('rejects a map key that is not a single opaque path segment', () => {
    const clock = fixedClock(0);

    expect(() => createFirmsHttpClient({ mapKey: '', clock })).toThrow(/map key/);
    expect(() => createFirmsHttpClient({ mapKey: 'short', clock })).toThrow(/map key/);
    expect(() => createFirmsHttpClient({ mapKey: `${MAP_KEY}/../x`, clock })).toThrow(/map key/);
    expect(() => createFirmsHttpClient({ mapKey: `${MAP_KEY}\n`, clock })).toThrow(/map key/);
  });
});

describe('createFirmsHttpClient — the key never leaves this module', () => {
  it('redacts the key from an HTTP error', async () => {
    const log = stubFetch(() => new Response('Invalid MAP_KEY', { status: 401 }));

    const error = await client(log)
      .fetchArea(QUERY)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FirmsHttpError);
    expect((error as FirmsHttpError).status).toBe(401);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).toContain('Invalid MAP_KEY');
    expect((error as Error).message).not.toContain(MAP_KEY);
  });

  it('redacts the key from a transport error, which quotes the URL it failed on', async () => {
    const log = stubFetch(
      (url) => new TypeError(`fetch failed: ECONNREFUSED while requesting ${url}`),
    );

    const error = await client(log)
      .fetchArea(QUERY)
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message).not.toContain(MAP_KEY);
    expect((error as Error).message).toContain('<MAP_KEY>');
    expect((error as FirmsHttpError).status).toBeNull();
  });

  it('unwraps the cause, where undici keeps the real reason', async () => {
    const failure = new TypeError('fetch failed');
    failure.cause = new Error('getaddrinfo ENOTFOUND firms.modaps.eosdis.nasa.gov');
    const log = stubFetch(() => failure);

    const error = await client(log)
      .fetchArea(QUERY)
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message).toContain('ENOTFOUND');
  });

  it('truncates a long error page instead of logging the whole thing', async () => {
    const log = stubFetch(() => new Response('x'.repeat(5000), { status: 503 }));

    const error = await client(log)
      .fetchArea(QUERY)
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message.length).toBeLessThan(400);
    expect((error as Error).message).toContain('…');
  });

  it('treats a 200 that is not CSV as the parser problem it is, not a transport one', async () => {
    // FIRMS serves rate-limit notices with a 200. The adapter hands the body over and the
    // core's parser is what refuses it, so the failed poll is recorded with its reason.
    const log = stubFetch(() => new Response('You have exceeded your transaction limit'));

    const result = await client(log).fetchArea(QUERY);

    expect(result.csv).toContain('exceeded');
  });
});
