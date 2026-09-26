import { describe, expect, it } from 'vitest';

import { parseExplanations } from './explanations.js';

const KEY = 'event_created:["s-1"]';

describe('parseExplanations', () => {
  it('reads both dispositions', () => {
    expect(
      parseExplanations({
        explanations: [
          { key: KEY, disposition: 'fixture', fixtureId: 'S17', reason: 'pins the split' },
          { key: 'event_dropped:["fw-2026-a1b2c"]', disposition: 'accepted', reason: 'noise' },
        ],
      }),
    ).toEqual([
      { key: KEY, disposition: 'fixture', fixtureId: 'S17', reason: 'pins the split' },
      {
        key: 'event_dropped:["fw-2026-a1b2c"]',
        disposition: 'accepted',
        fixtureId: null,
        reason: 'noise',
      },
    ]);
  });

  it('accepts an explicit null fixtureId on an acceptance', () => {
    const [entry] = parseExplanations({
      explanations: [{ key: KEY, disposition: 'accepted', fixtureId: null, reason: 'r' }],
    });
    expect(entry?.fixtureId).toBeNull();
  });

  it('accepts an empty list', () => {
    expect(parseExplanations({ explanations: [] })).toEqual([]);
  });

  it.each([
    ['a non-object document', [], /not an object/],
    ['a missing list', {}, /not an array/],
    ['an unknown top-level field', { explanations: [], extra: 1 }, /unknown field/],
    ['a non-object entry', { explanations: ['x'] }, /\[0\] is not an object/],
    [
      'a misspelt field',
      { explanations: [{ key: KEY, disposition: 'fixture', fixtureID: 'S1', reason: 'r' }] },
      /unknown field "fixtureID"/,
    ],
    [
      'an unknown disposition',
      { explanations: [{ key: KEY, disposition: 'ignored', reason: 'r' }] },
      /disposition/,
    ],
    [
      'a blank reason',
      { explanations: [{ key: KEY, disposition: 'accepted', reason: '  ' }] },
      /reason/,
    ],
    [
      'a fixture without its id',
      { explanations: [{ key: KEY, disposition: 'fixture', reason: 'r' }] },
      /fixtureId/,
    ],
    [
      'an acceptance naming a fixture',
      { explanations: [{ key: KEY, disposition: 'accepted', fixtureId: 'S1', reason: 'r' }] },
      /only meaningful/,
    ],
    [
      'a diff explained twice',
      {
        explanations: [
          { key: KEY, disposition: 'accepted', reason: 'r' },
          { key: KEY, disposition: 'accepted', reason: 'r2' },
        ],
      },
      /\[1\]\.key/,
    ],
  ])('refuses %s', (_label, document, message) => {
    expect(() => parseExplanations(document)).toThrow(message);
  });

  it('never echoes the reason text in an error', () => {
    const secret = 'reviewer note that should stay in the file';
    expect(() =>
      parseExplanations({ explanations: [{ key: KEY, disposition: 'nope', reason: secret }] }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining(secret) as string }));
  });
});
