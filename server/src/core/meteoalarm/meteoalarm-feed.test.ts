import { describe, expect, it } from 'vitest';

import {
  BULGARIA_FEED_EMPTY,
  CAP_GREECE_FOG,
  GREECE_FEED,
  SYNTHETIC_BULGARIA_FEED,
  SYNTHETIC_CAP_DUST,
  SYNTHETIC_CAP_FIRE,
  SYNTHETIC_CAP_FIRE_URL,
  SYNTHETIC_CAP_HEAT,
  SYNTHETIC_CAP_OET_GRASS_FIRE,
} from './__fixtures__/meteoalarm-feeds.js';
import {
  classifyTitle,
  isCapUrl,
  kindOfCap,
  parseAtomFeed,
  parseCapAlert,
  warningLevel,
} from './meteoalarm-feed.js';

describe('classifyTitle', () => {
  it.each([
    ['Yellow Fog Warning issued for Greece - Epirus', { kind: 'not-relayed' }],
    ['Orange Thunderstorm Warning issued for Greece - Thraki', { kind: 'not-relayed' }],
    ['Yellow Rain-Flood Warning issued for Serbia - Belgrade', { kind: 'not-relayed' }],
    ['Green Forest Fire Warning issued for Bulgaria - Haskovo', { kind: 'not-relayed' }],
    [
      'Orange Forest Fire Warning issued for Bulgaria - Haskovo',
      { kind: 'candidate', guess: 'forest-fire', level: 3 },
    ],
    [
      'Red forest-fire Warning issued for Greece - Attica',
      { kind: 'candidate', guess: 'forest-fire', level: 4 },
    ],
    [
      'Yellow High Temperature Warning issued for Romania - Dolj',
      { kind: 'candidate', guess: 'high-temperature', level: 2 },
    ],
    [
      'Yellow Dust Warning issued for Bulgaria - Sliven',
      { kind: 'candidate', guess: null, level: 2 },
    ],
    ['Purple Fog Warning issued for Greece - Epirus', { kind: 'unplaceable' }],
    ['Something else entirely', { kind: 'unplaceable' }],
  ])('%s', (title, expected) => {
    expect(classifyTitle(title)).toEqual(expected);
  });
});

describe('parseAtomFeed — recorded', () => {
  it('reads all twelve Greek entries with their CAP and region links', () => {
    const feed = parseAtomFeed(GREECE_FEED);
    expect(feed?.updated).toBe('2026-10-24T00:05:28.771488Z');
    expect(feed?.skipped).toBe(0);
    expect(feed?.entries).toHaveLength(12);
    const first = feed!.entries[0]!;
    expect(first).toMatchObject({
      title: 'Yellow Fog Warning issued for Greece - North East Aegean Islands',
      region: 'North East Aegean Islands',
      emmaId: 'GR014',
      expires: '2026-10-24T05:00:00Z',
      capUrl:
        'https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/7741ad66-f6d0-4dea-b058-b8ccfb8ab999',
      regionUrl: 'https://meteoalarm.org?geocode=EMMA_ID:GR014',
    });
    expect(first.id).toContain('index_info=0&index_area=0');
  });

  it('every recorded Greek entry is out of scope by its title alone', () => {
    const feed = parseAtomFeed(GREECE_FEED)!;
    for (const entry of feed.entries) {
      expect(classifyTitle(entry.title)).toEqual({ kind: 'not-relayed' });
    }
  });

  it('reads an empty feed as no entries', () => {
    expect(parseAtomFeed(BULGARIA_FEED_EMPTY)).toMatchObject({ entries: [], skipped: 0 });
  });
});

describe('parseAtomFeed — synthetic', () => {
  it('skips the cancelled entry and keeps the rest in order', () => {
    const feed = parseAtomFeed(SYNTHETIC_BULGARIA_FEED)!;
    expect(feed.skipped).toBe(1);
    expect(feed.entries.map((entry) => entry.emmaId)).toEqual([
      'BG009',
      'BG010',
      'BG011',
      'BG012',
      'BG014',
    ]);
    expect(feed.entries[0]).toMatchObject({
      onset: '2026-08-14T09:00:00Z',
      expires: '2026-08-15T21:00:00Z',
      sent: '2026-08-14T06:00:00Z',
      capUrl: SYNTHETIC_CAP_FIRE_URL,
    });
  });

  it('refuses a CAP link off MeteoAlarm and a naive timestamp', () => {
    const tampered = SYNTHETIC_BULGARIA_FEED.replace(
      `href="${SYNTHETIC_CAP_FIRE_URL}"`,
      'href="https://evil.example/cap"',
    ).replace('<cap:onset>2026-08-14T09:00:00+00:00', '<cap:onset>2026-08-14T09:00:00');
    const first = parseAtomFeed(tampered)!.entries[0]!;
    expect(first.capUrl).toBeNull();
    expect(first.onset).toBeNull();
  });

  it('is null for something that is not an Atom feed', () => {
    expect(parseAtomFeed('<html><body/></html>')).toBeNull();
    expect(parseAtomFeed('not xml')).toBeNull();
  });
});

describe('isCapUrl', () => {
  it('accepts only https on the feed host', () => {
    expect(isCapUrl(SYNTHETIC_CAP_FIRE_URL)).toBe(true);
    expect(isCapUrl('http://feeds.meteoalarm.org/api/v1/x')).toBe(false);
    expect(isCapUrl('https://feeds.meteoalarm.org.evil.example/x')).toBe(false);
    expect(isCapUrl('https://user@feeds.meteoalarm.org/x')).toBe(false);
    expect(isCapUrl('not a url')).toBe(false);
  });
});

describe('parseCapAlert', () => {
  it('reads the recorded Greek fog alert from its English block', () => {
    const cap = parseCapAlert(CAP_GREECE_FOG)!;
    expect(cap).toEqual({
      awarenessType: 4,
      awarenessLevel: 2,
      fireEventCode: null,
      headline: 'Yellow warning for North East Aegean Islands',
      issuerUrl: 'https://www.emy.gr',
    });
    expect(kindOfCap(cap)).toBeNull();
  });

  it('prefers the English block when it is not first', () => {
    const cap = parseCapAlert(SYNTHETIC_CAP_FIRE)!;
    expect(cap.headline).toBe('Orange forest-fire warning for Haskovo');
    expect(kindOfCap(cap)).toBe('forest-fire');
    expect(warningLevel(cap.awarenessLevel)).toBe(3);
  });

  it('classifies heat, a non-fire type and an OET fire code', () => {
    expect(kindOfCap(parseCapAlert(SYNTHETIC_CAP_HEAT)!)).toBe('high-temperature');
    expect(kindOfCap(parseCapAlert(SYNTHETIC_CAP_DUST)!)).toBeNull();
    const oet = parseCapAlert(SYNTHETIC_CAP_OET_GRASS_FIRE)!;
    expect(oet.awarenessType).toBeNull();
    expect(oet.fireEventCode).toBe('OET-095');
    expect(kindOfCap(oet)).toBe('forest-fire');
  });

  it('drops a non-https issuer page', () => {
    const cap = parseCapAlert(SYNTHETIC_CAP_FIRE.replaceAll('https://www.meteo.bg', 'http://x'));
    expect(cap?.issuerUrl).toBeNull();
  });

  it('is null for anything that is not a CAP alert', () => {
    expect(parseCapAlert(GREECE_FEED)).toBeNull();
    expect(parseCapAlert('<alert></alert>')).toBeNull();
  });
});

describe('warningLevel', () => {
  it('keeps 2–4 only', () => {
    expect([1, 2, 3, 4, 5, null].map(warningLevel)).toEqual([null, 2, 3, 4, null, null]);
  });
});
