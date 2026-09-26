import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { ForecastCycleRef } from '../../core/ports/weather-client.js';
import { ECMWF_BASE_URL, createEcmwfHttpClient, ecmwfFileUrl } from './ecmwf-http-client.js';

const CYCLE: ForecastCycleRef = { dateYmd: '20260813', hour: 6 };

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function fetchAnswering(response: () => Response): { calls: Captured[]; fetch: typeof fetch } {
  const calls: Captured[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(response());
  };
  return { calls, fetch: fake };
}

describe('ecmwfFileUrl', () => {
  it('renders the documented open-data layout exactly', () => {
    expect(ecmwfFileUrl(ECMWF_BASE_URL, CYCLE, 0, 'index')).toBe(
      'https://data.ecmwf.int/forecasts/20260813/06z/ifs/0p25/oper/20260813060000-0h-oper-fc.index',
    );
    expect(ecmwfFileUrl(ECMWF_BASE_URL, { dateYmd: '20260812', hour: 18 }, 12, 'grib2')).toBe(
      'https://data.ecmwf.int/forecasts/20260812/18z/ifs/0p25/oper/20260812180000-12h-oper-fc.grib2',
    );
  });
});

describe('createEcmwfHttpClient', () => {
  describe('fetchIndex', () => {
    it('returns the index text with an availableAt stamp', async () => {
      const clock = new VirtualClock('2026-08-13T15:00:00Z');
      const { calls, fetch } = fetchAnswering(() => new Response('{"param":"10u"}\n'));
      const client = createEcmwfHttpClient({ clock, fetch });

      const fetched = await client.fetchIndex(CYCLE, 0);

      expect(calls[0]?.url).toContain('20260813060000-0h-oper-fc.index');
      expect(calls[0]?.init?.redirect).toBe('error');
      expect(fetched.error).toBeNull();
      expect(fetched.text).toBe('{"param":"10u"}\n');
      expect(fetched.availableAt).toBe(clock.now());
    });

    it('turns a 404 into a failure value naming the cycle', async () => {
      // The realistic shape: asking for a run that is not fully published yet.
      const { fetch } = fetchAnswering(() => new Response('Not Found', { status: 404 }));
      const client = createEcmwfHttpClient({ clock: new VirtualClock(0), fetch });

      const fetched = await client.fetchIndex(CYCLE, 6);

      expect(fetched.text).toBeNull();
      expect(fetched.error).toBe('ECMWF returned 404 for index 20260813/6z step 6: Not Found');
    });
  });

  describe('fetchRange', () => {
    it('sends a closed byte range and accepts exactly a 206 of the right size', async () => {
      const body = new Uint8Array(80);
      const clock = new VirtualClock('2026-08-13T15:00:00Z');
      const { calls, fetch } = fetchAnswering(() => new Response(body, { status: 206 }));
      const client = createEcmwfHttpClient({ clock, fetch });

      const fetched = await client.fetchRange(CYCLE, 0, { offset: 100, length: 80 });

      expect(calls[0]?.url).toContain('20260813060000-0h-oper-fc.grib2');
      expect((calls[0]?.init?.headers as Record<string, string>)['range']).toBe('bytes=100-179');
      expect(fetched.error).toBeNull();
      expect(fetched.bytes).toEqual(body);
      expect(fetched.availableAt).toBe(clock.now());
    });

    it('refuses a 200 — the server ignoring Range means the whole run file is coming', async () => {
      const { fetch } = fetchAnswering(() => new Response(new Uint8Array(4096), { status: 200 }));
      const client = createEcmwfHttpClient({ clock: new VirtualClock(0), fetch });

      const fetched = await client.fetchRange(CYCLE, 0, { offset: 0, length: 64 });

      expect(fetched.bytes).toBeNull();
      expect(fetched.error).toBe(
        'ECMWF ignored the range request for 20260813/6z step 0 (answered 200, not 206)',
      );
    });

    it('refuses a 206 with the wrong byte count as truncated', async () => {
      const { fetch } = fetchAnswering(() => new Response(new Uint8Array(50), { status: 206 }));
      const client = createEcmwfHttpClient({ clock: new VirtualClock(0), fetch });

      const fetched = await client.fetchRange(CYCLE, 0, { offset: 0, length: 64 });

      expect(fetched.bytes).toBeNull();
      expect(fetched.error).toBe(
        'ECMWF range for 20260813/6z step 0 was truncated: asked for 64 bytes, got 50',
      );
    });

    it('rejects malformed ranges before touching the network', async () => {
      const { calls, fetch } = fetchAnswering(() => new Response(new Uint8Array(1)));
      const client = createEcmwfHttpClient({ clock: new VirtualClock(0), fetch });

      const badOffset = await client.fetchRange(CYCLE, 0, { offset: -1, length: 64 });
      const badLength = await client.fetchRange(CYCLE, 0, { offset: 0, length: 0 });

      expect(badOffset.error).toBe('invalid range offset -1 for 20260813/6z step 0');
      expect(badLength.error).toBe('invalid range length 0 for 20260813/6z step 0');
      expect(calls).toHaveLength(0);
    });

    it('turns a network throw into a failure value', async () => {
      const failing = () =>
        Promise.reject(new Error('fetch failed', { cause: new Error('ETIMEDOUT') }));
      const client = createEcmwfHttpClient({
        clock: new VirtualClock(0),
        fetch: failing,
      });

      const fetched = await client.fetchRange(CYCLE, 0, { offset: 0, length: 64 });

      expect(fetched.error).toBe(
        'ECMWF range request failed for 20260813/6z step 0: fetch failed (ETIMEDOUT)',
      );
    });
  });
});
