import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import type {
  FeedValidators,
  MeteoalarmCapFetch,
  MeteoalarmClient,
  MeteoalarmFeedFetch,
} from '../ports/meteoalarm-client.js';
import { MemoryFeedStatus } from '../passes/__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from '../passes/__fixtures__/memory-payloads.js';
import {
  GREECE_FEED,
  SYNTHETIC_BULGARIA_FEED,
  SYNTHETIC_CAP_DUST,
  SYNTHETIC_CAP_DUST_URL,
  SYNTHETIC_CAP_FIRE,
  SYNTHETIC_CAP_FIRE_URL,
  SYNTHETIC_CAP_HEAT,
  SYNTHETIC_CAP_HEAT_URL,
  SYNTHETIC_NOW_MS,
} from './__fixtures__/meteoalarm-feeds.js';
import {
  METEOALARM_CURRENT_META_PATH,
  METEOALARM_CURRENT_PATH,
  parseMeteoalarmDocument,
} from './meteoalarm-document.js';
import type { MeteoalarmCountry } from './meteoalarm-feed.js';
import { createMeteoalarmRefresh, meteoalarmRefreshFailed } from './meteoalarm-refresh.js';

const BG: MeteoalarmCountry = { code: 'BG', slug: 'bulgaria' };
const GR: MeteoalarmCountry = { code: 'GR', slug: 'greece' };

type FeedAnswer = MeteoalarmFeedFetch | Error;

class ScriptedClient implements MeteoalarmClient {
  readonly feedCalls: { slug: string; validators: FeedValidators | null }[] = [];
  readonly capCalls: string[] = [];
  feeds: Record<string, FeedAnswer> = {};
  caps: Record<string, MeteoalarmCapFetch | Error> = {};

  fetchFeed(slug: string, validators: FeedValidators | null): Promise<MeteoalarmFeedFetch> {
    this.feedCalls.push({ slug, validators });
    const answer = this.feeds[slug];
    if (answer === undefined) throw new Error(`unscripted feed ${slug}`);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }

  fetchCap(url: string): Promise<MeteoalarmCapFetch> {
    this.capCalls.push(url);
    const answer = this.caps[url] ?? { body: null, error: 'HTTP 404' };
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
}

const ok = (body: string, etag: string | null = null): MeteoalarmFeedFetch => ({
  kind: 'ok',
  body,
  validators: { etag, lastModified: null },
});
const cap = (body: string): MeteoalarmCapFetch => ({ body, error: null });

function setup(countries: readonly MeteoalarmCountry[] = [BG, GR]) {
  const client = new ScriptedClient();
  const payloads = new MemoryPayloads();
  const feedStatus = new MemoryFeedStatus();
  const clock = new VirtualClock(SYNTHETIC_NOW_MS);
  const refresh = createMeteoalarmRefresh({ client, payloads, clock, feedStatus, countries });
  const stored = () => parseMeteoalarmDocument(payloads.text(METEOALARM_CURRENT_PATH) ?? '');
  return { client, payloads, feedStatus, clock, refresh, stored };
}

function scriptBulgaria(client: ScriptedClient): void {
  client.feeds['bulgaria'] = ok(SYNTHETIC_BULGARIA_FEED, '"v1"');
  client.feeds['greece'] = ok(GREECE_FEED);
  client.caps[SYNTHETIC_CAP_FIRE_URL] = cap(SYNTHETIC_CAP_FIRE);
  client.caps[SYNTHETIC_CAP_HEAT_URL] = cap(SYNTHETIC_CAP_HEAT);
  client.caps[SYNTHETIC_CAP_DUST_URL] = cap(SYNTHETIC_CAP_DUST);
}

describe('createMeteoalarmRefresh', () => {
  it('relays the fire and heat warnings, confirmed by CAP, and drops the rest', async () => {
    const { client, refresh, stored, feedStatus, payloads } = setup();
    scriptBulgaria(client);

    const report = await refresh.run();

    expect(meteoalarmRefreshFailed(report)).toBe(false);
    expect(report).toMatchObject({ warnings: 2, capFetches: 3, unresolved: 0, written: true });
    // Only the candidates' CAP alerts were read: not the wind one, not the expired fire
    // one, and none of Greece's twelve fog/rain/thunderstorm entries.
    expect(client.capCalls.sort()).toEqual(
      [SYNTHETIC_CAP_FIRE_URL, SYNTHETIC_CAP_HEAT_URL, SYNTHETIC_CAP_DUST_URL].sort(),
    );
    const document = stored()!;
    expect(document.generated_at).toBe('2026-08-14T12:00:00Z');
    expect(document.countries).toEqual([
      { country: 'BG', checked_at: '2026-08-14T12:00:00Z', ok: true },
      { country: 'GR', checked_at: '2026-08-14T12:00:00Z', ok: true },
    ]);
    expect(document.warnings).toMatchObject([
      {
        country: 'BG',
        region: 'Haskovo',
        emma_id: 'BG009',
        kind: 'forest-fire',
        level: 3,
        headline: 'Orange forest-fire warning for Haskovo',
        onset: '2026-08-14T09:00:00Z',
        expires: '2026-08-15T21:00:00Z',
        source_url: 'https://meteoalarm.org?geocode=EMMA_ID:BG009',
        issuer_url: 'https://www.meteo.bg',
        cap_confirmed: true,
      },
      { region: 'Kardzhali', kind: 'high-temperature', level: 2, cap_confirmed: true },
    ]);
    const meta = JSON.parse(payloads.text(METEOALARM_CURRENT_META_PATH)!) as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({ provider: 'meteoalarm', warnings: 2 });
    expect(meta['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(feedStatus.attempts).toEqual([
      {
        row: 'meteoalarm:warnings',
        attemptAt: SYNTHETIC_NOW_MS,
        succeeded: true,
        hadData: true,
        error: null,
      },
    ]);
  });

  it('reads each CAP alert once and sends the previous validators', async () => {
    const { client, refresh, clock } = setup();
    scriptBulgaria(client);
    await refresh.run();
    clock.advanceMinutes(15);
    client.feeds['bulgaria'] = { kind: 'not-modified' };

    const report = await refresh.run();

    expect(report.capFetches).toBe(0);
    expect(report.warnings).toBe(2);
    expect(report.countries[0]).toMatchObject({ outcome: 'not_modified', entries: 5 });
    expect(client.feedCalls[2]).toEqual({
      slug: 'bulgaria',
      validators: { etag: '"v1"', lastModified: null },
    });
  });

  it('falls back to the title when a CAP alert cannot be read', async () => {
    const { client, refresh, stored, feedStatus } = setup([BG]);
    scriptBulgaria(client);
    client.caps[SYNTHETIC_CAP_FIRE_URL] = { body: null, error: 'HTTP 500' };
    client.caps[SYNTHETIC_CAP_DUST_URL] = new Error('socket hang up');

    const report = await refresh.run();

    expect(report).toMatchObject({ capFailures: 2, unresolved: 1, warnings: 2, written: true });
    expect(stored()!.warnings[0]).toMatchObject({
      kind: 'forest-fire',
      level: 3,
      cap_confirmed: false,
      headline: null,
    });
    expect(feedStatus.attempts[0]).toMatchObject({ succeeded: false, hadData: true });
    expect(feedStatus.attempts[0]!.error).toContain('2 CAP alert(s) unreadable');
    expect(feedStatus.attempts[0]!.error).toContain('1 warning(s) unclassified');
  });

  it('defers CAP alerts beyond the per-cycle budget to the next cycle', async () => {
    const client = new ScriptedClient();
    scriptBulgaria(client);
    const clock = new VirtualClock(SYNTHETIC_NOW_MS);
    const refresh = createMeteoalarmRefresh({
      client,
      payloads: new MemoryPayloads(),
      clock,
      feedStatus: new MemoryFeedStatus(),
      countries: [BG],
      maxCapFetchesPerCycle: 1,
    });

    expect(await refresh.run()).toMatchObject({ capFetches: 1, capDeferred: 2 });
    clock.advanceMinutes(15);
    expect(await refresh.run()).toMatchObject({ capFetches: 1, capDeferred: 1 });
    clock.advanceMinutes(15);
    expect(await refresh.run()).toMatchObject({ capFetches: 1, capDeferred: 0, unresolved: 0 });
  });

  it('keeps a failed country’s last warnings and marks it not ok', async () => {
    const { client, refresh, clock, stored } = setup();
    scriptBulgaria(client);
    await refresh.run();
    clock.advanceMinutes(15);
    client.feeds['bulgaria'] = { kind: 'failed', status: 503, error: 'HTTP 503' };

    const report = await refresh.run();

    expect(report.countries[0]).toMatchObject({ outcome: 'fetch_failed', entries: 5 });
    const document = stored()!;
    expect(document.generated_at).toBe('2026-08-14T12:15:00Z');
    expect(document.countries[0]).toEqual({
      country: 'BG',
      checked_at: '2026-08-14T12:00:00Z',
      ok: false,
    });
    expect(document.warnings).toHaveLength(2);
  });

  it('does not rewrite the document when no country could be read', async () => {
    const { client, refresh, clock, stored, feedStatus } = setup();
    scriptBulgaria(client);
    await refresh.run();
    clock.advanceMinutes(15);
    client.feeds['bulgaria'] = new Error('ECONNRESET');
    client.feeds['greece'] = ok('<html/>');

    const report = await refresh.run();

    expect(meteoalarmRefreshFailed(report)).toBe(true);
    expect(report.written).toBe(false);
    expect(report.countries.map((c) => c.outcome)).toEqual(['fetch_failed', 'invalid']);
    expect(stored()!.generated_at).toBe('2026-08-14T12:00:00Z');
    expect(feedStatus.attempts[1]).toMatchObject({ succeeded: false, hadData: false });
    expect(feedStatus.attempts[1]!.error).toContain('no country feed could be read');
  });

  it('treats a 304 with no previous answer as invalid', async () => {
    const { client, refresh } = setup([BG]);
    client.feeds['bulgaria'] = { kind: 'not-modified' };
    const report = await refresh.run();
    expect(report.countries[0]).toMatchObject({ outcome: 'invalid' });
    expect(report.written).toBe(false);
  });

  it('drops warnings that expire while held', async () => {
    const { client, refresh, clock } = setup([BG]);
    scriptBulgaria(client);
    await refresh.run();
    clock.advanceHours(31); // past Kardzhali (18:00 next day), before Haskovo (21:00)
    client.feeds['bulgaria'] = { kind: 'not-modified' };
    expect((await refresh.run()).warnings).toBe(1);
  });

  it('reports write and feed-status failures', async () => {
    const { client, refresh, payloads, feedStatus } = setup([BG]);
    scriptBulgaria(client);
    payloads.failWritesOn = /current\.json$/;
    feedStatus.throws = true;
    const report = await refresh.run();
    expect(report.written).toBe(false);
    expect(report.warnings).toBe(0);
    expect(report.writeError).toContain('disk full');
    expect(report.feedStatusError).toContain('unwritable');
    expect(meteoalarmRefreshFailed(report)).toBe(true);
  });
});
