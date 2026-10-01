import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFirmsCsv } from '../../core/ingest/firms-csv.js';
import type { FirmsAreaQuery } from '../../core/ports/firms-client.js';
import { FirmsHttpError } from './firms-http-client.js';
import {
  FIRMS_KEYLESS_BASE_URL,
  clipKeylessCsv,
  createFirmsKeylessClient,
  keylessFileUrl,
} from './firms-keyless-client.js';

/** Trimmed from the real NOAA-20 Europe file of 2026-09-28: 7 rows in the bbox, 3 outside. */
const SAMPLE = readFileSync(
  join(import.meta.dirname, '__fixtures__', 'J1_VIIRS_C2_Europe_24h.sample.csv'),
  'utf8',
);

const QUERY: FirmsAreaQuery = {
  source: 'firms:viirs:noaa20',
  product: 'VIIRS_NOAA20_NRT',
  area: '20,39,31,46',
  dayRange: 2,
};

const EVENING = Date.parse('2026-09-28T19:00:00Z');
const NEXT_NIGHT = Date.parse('2026-09-29T01:00:00Z');

type FetchInput = Parameters<typeof globalThis.fetch>[0];

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function stubFetch(responses: (() => Response | Error)[]): {
  calls: Call[];
  fetch: typeof globalThis.fetch;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (input: FetchInput, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
      const next = responses.shift();
      if (next === undefined) return Promise.reject(new Error('unexpected fetch'));
      const outcome = next();
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

function csvResponse(body: string, etag = '"abc"'): Response {
  return new Response(body, {
    status: 200,
    headers: { etag, 'last-modified': 'Mon, 28 Sep 2026 18:42:08 GMT' },
  });
}

function dataLines(csv: string): string[] {
  return csv
    .split('\n')
    .slice(1)
    .filter((line) => line !== '');
}

describe('keylessFileUrl', () => {
  it('maps every active VIIRS source to its public Europe file', () => {
    expect(keylessFileUrl(FIRMS_KEYLESS_BASE_URL, 'firms:viirs:snpp')).toBe(
      'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_24h.csv',
    );
    expect(keylessFileUrl(FIRMS_KEYLESS_BASE_URL, 'firms:viirs:noaa20')).toMatch(
      /noaa-20-viirs-c2\/csv\/J1_VIIRS_C2_Europe_24h\.csv$/,
    );
    expect(keylessFileUrl(FIRMS_KEYLESS_BASE_URL, 'firms:viirs:noaa21')).toMatch(
      /noaa-21-viirs-c2\/csv\/J2_VIIRS_C2_Europe_24h\.csv$/,
    );
  });

  it('refuses a source that has no public file', () => {
    expect(() => keylessFileUrl(FIRMS_KEYLESS_BASE_URL, 'eumetsat:slstr:frp')).toThrow(
      FirmsHttpError,
    );
  });
});

describe('clipKeylessCsv', () => {
  const area = { west: 20, south: 39, east: 31, north: 46 };

  it('keeps the header and only rows inside the area and the day window', () => {
    const clipped = clipKeylessCsv(SAMPLE, area, '2026-09-27');
    expect(clipped.split('\n')[0]).toBe(SAMPLE.split('\n')[0]);
    expect(dataLines(clipped)).toHaveLength(7);
    expect(
      dataLines(clipped).every((line) => !line.startsWith('64.') && !line.startsWith('59.')),
    ).toBe(true);
  });

  it('drops rows from before the first day, as the Area API day_range would', () => {
    const clipped = clipKeylessCsv(SAMPLE, area, '2026-09-28');
    expect(dataLines(clipped)).toHaveLength(4);
    expect(dataLines(clipped).every((line) => line.includes(',2026-09-28,'))).toBe(true);
  });

  it('maps spelled-out confidence to the Area API letters', () => {
    const clipped = clipKeylessCsv(SAMPLE, area, '2026-09-27');
    expect(clipped).not.toContain('nominal');
    expect(dataLines(clipped)[0]).toContain(',N20,n,2.0NRT,');
  });

  it('keeps a row it cannot read so the parser rejects it visibly', () => {
    const header = SAMPLE.split('\n')[0] ?? '';
    const broken = `${header}\nnot-a-number,25,300,0.4,0.4,2026-09-28,0011,N20,n,2.0NRT,280,1,N\n`;
    expect(dataLines(clipKeylessCsv(broken, area, '2026-09-28'))).toHaveLength(1);
  });

  it('returns a body without the expected columns unchanged', () => {
    const html = '<html>outage</html>';
    expect(clipKeylessCsv(html, area, '2026-09-28')).toBe(html);
  });

  it('produces rows the strict Area API parser accepts', () => {
    const parsed = parseFirmsCsv(clipKeylessCsv(SAMPLE, area, '2026-09-27'), {
      source: 'firms:viirs:noaa20',
    });
    expect(parsed.rows).toHaveLength(7);
    expect(parsed.rejections).toEqual([]);
  });
});

describe('createFirmsKeylessClient', () => {
  it('fetches the source file and clips it to the query area and day range', async () => {
    const stub = stubFetch([() => csvResponse(SAMPLE)]);
    const client = createFirmsKeylessClient({ clock: { now: () => EVENING }, fetch: stub.fetch });

    const response = await client.fetchArea(QUERY);

    expect(stub.calls[0]?.url).toMatch(/J1_VIIRS_C2_Europe_24h\.csv$/);
    expect(response.availableAt).toBe(EVENING);
    expect(dataLines(response.csv)).toHaveLength(7);
    expect('fetchDataAvailability' in client).toBe(false);
  });

  it('anchors the day window on the clock, so yesterday ages out after midnight UTC', async () => {
    const stub = stubFetch([() => csvResponse(SAMPLE)]);
    const client = createFirmsKeylessClient({
      clock: { now: () => NEXT_NIGHT },
      fetch: stub.fetch,
    });

    const response = await client.fetchArea(QUERY);

    expect(dataLines(response.csv)).toHaveLength(4);
  });

  it('sends conditional headers and reuses the cached body on 304', async () => {
    const stub = stubFetch([() => csvResponse(SAMPLE), () => new Response(null, { status: 304 })]);
    const client = createFirmsKeylessClient({ clock: { now: () => EVENING }, fetch: stub.fetch });

    await client.fetchArea(QUERY);
    const second = await client.fetchArea(QUERY);

    expect(stub.calls[0]?.headers['if-none-match']).toBeUndefined();
    expect(stub.calls[1]?.headers['if-none-match']).toBe('"abc"');
    expect(stub.calls[1]?.headers['if-modified-since']).toBe('Mon, 28 Sep 2026 18:42:08 GMT');
    expect(dataLines(second.csv)).toHaveLength(7);
  });

  it('treats a 200 with an unchanged ETag as the same file', async () => {
    const header = SAMPLE.split('\n')[0] ?? '';
    const stub = stubFetch([() => csvResponse(SAMPLE), () => csvResponse(`${header}\n`)]);
    const client = createFirmsKeylessClient({ clock: { now: () => EVENING }, fetch: stub.fetch });

    await client.fetchArea(QUERY);
    const second = await client.fetchArea(QUERY);

    expect(dataLines(second.csv)).toHaveLength(7);
  });

  it('takes the new body when the ETag changes', async () => {
    const header = SAMPLE.split('\n')[0] ?? '';
    const stub = stubFetch([
      () => csvResponse(SAMPLE, '"one"'),
      () => csvResponse(`${header}\n`, '"two"'),
    ]);
    const client = createFirmsKeylessClient({ clock: { now: () => EVENING }, fetch: stub.fetch });

    await client.fetchArea(QUERY);
    const second = await client.fetchArea(QUERY);

    expect(dataLines(second.csv)).toHaveLength(0);
  });

  it('refuses a backfill query instead of answering with the wrong days', async () => {
    const stub = stubFetch([]);
    const client = createFirmsKeylessClient({ clock: { now: () => EVENING }, fetch: stub.fetch });

    await expect(client.fetchArea({ ...QUERY, startDate: '2026-08-01' })).rejects.toThrow(
      /cannot serve a backfill/,
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('raises FirmsHttpError with the status on a non-2xx answer', async () => {
    const stub = stubFetch([() => new Response('not found', { status: 404 })]);
    const client = createFirmsKeylessClient({ clock: { now: () => EVENING }, fetch: stub.fetch });

    const error = await client.fetchArea(QUERY).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FirmsHttpError);
    expect((error as FirmsHttpError).status).toBe(404);
  });

  it('raises FirmsHttpError without a status when the request itself fails', async () => {
    const stub = stubFetch([() => new TypeError('fetch failed')]);
    const client = createFirmsKeylessClient({ clock: { now: () => EVENING }, fetch: stub.fetch });

    const error = await client.fetchArea(QUERY).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FirmsHttpError);
    expect((error as FirmsHttpError).status).toBeNull();
  });

  it('honours a base URL override', async () => {
    const stub = stubFetch([() => csvResponse(SAMPLE)]);
    const client = createFirmsKeylessClient({
      clock: { now: () => EVENING },
      baseUrl: 'http://127.0.0.1:9999/active_fire/',
      fetch: stub.fetch,
    });

    await client.fetchArea(QUERY);

    expect(stub.calls[0]?.url).toBe(
      'http://127.0.0.1:9999/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv',
    );
  });
});
