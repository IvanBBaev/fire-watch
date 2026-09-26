import { describe, expect, it } from 'vitest';

import {
  ADJACENT_KEYS,
  CANDIDATE_KINDS,
  PRIORITIES,
  generateCandidates,
  type Candidate,
} from './defensive-domains.js';
import { isValidLabel, normalizeDomain } from './domain-name.js';

const list = generateCandidates({ name: 'firewatch', tlds: ['bg', 'com', 'eu'] });
const find = (domain: string): Candidate | undefined => list.find((c) => c.domain === domain);

describe('generateCandidates', () => {
  it('is deterministic and sorted by priority, kind, domain', () => {
    expect(generateCandidates({ name: 'firewatch', tlds: ['bg', 'com', 'eu'] })).toEqual(list);
    const key = (c: Candidate): [number, number, string] => [
      PRIORITIES.indexOf(c.priority),
      CANDIDATE_KINDS.indexOf(c.kind),
      c.domain,
    ];
    for (let i = 1; i < list.length; i += 1) {
      const [a, b] = [key(list[i - 1] as Candidate), key(list[i] as Candidate)];
      expect(
        a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2]))),
      ).toBe(true);
    }
  });

  it('never lists the primary domain, and lists every domain once', () => {
    expect(find('firewatch.bg')).toBeUndefined();
    expect(new Set(list.map((c) => c.domain)).size).toBe(list.length);
  });

  it('puts the name on the other TLDs first, as register', () => {
    expect(list.filter((c) => c.priority === 'register').map((c) => c.domain)).toEqual([
      'firewatch.com',
      'firewatch.eu',
    ]);
  });

  it('considers hyphenation, affixes and Latin look-alikes on the primary TLD', () => {
    expect(find('fire-watch.bg')).toMatchObject({ kind: 'hyphenation', priority: 'consider' });
    expect(find('firewatch-bg.bg')).toMatchObject({ kind: 'affix', priority: 'consider' });
    expect(find('firevvatch.bg')).toMatchObject({ kind: 'ascii-homoglyph', priority: 'consider' });
    expect(find('f1rewatch.bg')).toMatchObject({ kind: 'ascii-homoglyph', priority: 'consider' });
    expect(find('fire-watch.com')).toMatchObject({ priority: 'monitor' });
  });

  it('only monitors plain typos', () => {
    for (const domain of ['firwatch.bg', 'fierwatch.bg', 'fiirewatch.bg', 'firewatcj.bg']) {
      expect(find(domain)?.priority, domain).toBe('monitor');
    }
  });

  it('keeps the strongest priority when two kinds yield the same name', () => {
    // "firewatcg" is not interesting; "flrewatch" is both a homoglyph and an adjacent-key typo.
    expect(find('flrewatch.bg')).toMatchObject({ kind: 'ascii-homoglyph', priority: 'consider' });
  });

  it('produces only valid A-labels', () => {
    for (const c of list) expect(normalizeDomain(c.domain), c.domain).toBe(c.domain);
  });

  it('encodes Cyrillic look-alikes as punycode and shows them in Unicode', () => {
    const idn = list.filter((c) => c.kind === 'idn-homoglyph');
    expect(idn.length).toBeGreaterThan(0);
    for (const c of idn) {
      expect(c.domain.startsWith('xn--')).toBe(true);
      expect(c.display).not.toBe(c.domain);
    }
    // "firewatch" has Latin-only letters (f, i, r, w, t, h): only mixed-script variants.
    expect(idn.every((c) => c.priority === 'monitor')).toBe(true);
    const whole = generateCandidates({ name: 'pexa', tlds: ['bg'] }).find(
      (c) => c.display === 'реха.bg',
    );
    expect(whole).toMatchObject({ kind: 'idn-homoglyph', priority: 'consider' });
    expect(whole?.domain).toMatch(/^xn--[a-z0-9-]+\.bg$/);
  });

  it('removes hyphens from a hyphenated name', () => {
    const hyphenated = generateCandidates({ name: 'fire-watch', tlds: ['bg'] });
    expect(hyphenated.find((c) => c.domain === 'firewatch.bg')).toMatchObject({
      kind: 'hyphenation',
      priority: 'consider',
    });
    expect(hyphenated.every((c) => isValidLabel(c.domain.split('.')[0] ?? ''))).toBe(true);
  });

  it('normalizes input case and a leading dot on TLDs', () => {
    expect(generateCandidates({ name: ' FireWatch ', tlds: ['.BG', 'com'] })).toEqual(
      generateCandidates({ name: 'firewatch', tlds: ['bg', 'com'] }),
    );
  });

  it.each([
    ['an empty name', { name: '', tlds: ['bg'] }],
    ['a dotted name', { name: 'fire.watch', tlds: ['bg'] }],
    ['a leading hyphen', { name: '-fire', tlds: ['bg'] }],
    ['no TLD', { name: 'firewatch', tlds: [] }],
    ['an invalid TLD', { name: 'firewatch', tlds: ['b g'] }],
  ])('throws on %s', (_label, options) => {
    expect(() => generateCandidates(options)).toThrow(RangeError);
  });
});

describe('ADJACENT_KEYS', () => {
  it('is symmetric', () => {
    for (const [key, near] of ADJACENT_KEYS) {
      for (const n of near) expect(ADJACENT_KEYS.get(n), `${key}->${n}`).toContain(key);
    }
  });
});

describe('domain-name', () => {
  it('normalizes and validates host names', () => {
    expect(normalizeDomain('Alerts.Example.BG.')).toBe('alerts.example.bg');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('a..b')).toBeNull();
    expect(isValidLabel('ab--c')).toBe(false);
    expect(isValidLabel('xn--80ak6aa92e')).toBe(true);
  });
});
