import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { lintAlertText } from '../../../packages/contracts/src/never-send.js';

import { NOTICE_TEXT_MAX_LENGTH, parseNotices, visibleNotices, type Notice } from './notices.js';

const notice = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '2026-09-20-map-delay',
  kind: 'incident',
  startedAt: '2026-09-20T10:00:00Z',
  resolvedAt: '2026-09-20T14:30:00+03:00',
  en: 'Map updates were delayed for about an hour.',
  bg: 'Обновяването на картата закъсня с около час.',
  postmortemUrl: null,
  ...overrides,
});

const errorsOf = (value: unknown): readonly string[] => {
  const result = parseNotices(value);
  return result.ok ? [] : result.errors;
};

describe('parseNotices', () => {
  it('accepts an empty list and a valid notice', () => {
    expect(parseNotices({ notices: [] })).toEqual({ ok: true, notices: [] });
    const result = parseNotices({ notices: [notice()] });
    expect(result.ok).toBe(true);
  });

  it('defaults omitted resolvedAt and postmortemUrl to null', () => {
    const raw = notice();
    delete raw['resolvedAt'];
    delete raw['postmortemUrl'];
    const result = parseNotices({ notices: [raw] });
    expect(result.ok && result.notices[0]).toMatchObject({ resolvedAt: null, postmortemUrl: null });
  });

  it('rejects a root that is not { notices: [] }', () => {
    expect(errorsOf([])).toEqual(['root: expected { "notices": [ ... ] }']);
  });

  it.each([
    ['an upper-case id', { id: 'Bad Id' }, '.id'],
    ['an unknown kind', { kind: 'outage' }, '.kind'],
    ['a start without an offset', { startedAt: '2026-09-20T10:00:00' }, '.startedAt'],
    ['a resolution before the start', { resolvedAt: '2026-09-19T10:00:00Z' }, '.resolvedAt'],
    ['empty text', { en: '  ' }, '.en'],
    ['markup', { bg: 'Виж <b>тук</b>' }, '.bg'],
    ['over-long text', { en: 'a'.repeat(NOTICE_TEXT_MAX_LENGTH + 1) }, '.en'],
    ['a plain-http postmortem', { postmortemUrl: 'http://example.org/pm' }, '.postmortemUrl'],
    ['an unknown field', { severity: 'high' }, 'unknown field "severity"'],
  ])('rejects %s', (_label, overrides, fragment) => {
    const errors = errorsOf({ notices: [notice(overrides)] });
    expect(
      errors.some((e) => e.includes(fragment)),
      errors.join('; '),
    ).toBe(true);
  });

  it('rejects duplicate ids and collects every error', () => {
    const errors = errorsOf({ notices: [notice(), notice({ kind: 'x' })] });
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toMatch(/duplicate/);
    expect(errors.join('\n')).toMatch(/kind/);
  });
});

describe('visibleNotices', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const make = (id: string, startedAt: string, resolvedAt: string | null): Notice => ({
    id,
    kind: 'incident',
    startedAt,
    resolvedAt,
    en: 'x',
    bg: 'x',
    postmortemUrl: null,
  });

  it('shows ongoing first, then resolved newest first, within the window', () => {
    const shown = visibleNotices(
      [
        make('old-resolved', '2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z'),
        make('recent-resolved', '2026-09-20T00:00:00Z', '2026-09-20T02:00:00Z'),
        make('newer-resolved', '2026-09-22T00:00:00Z', '2026-09-22T02:00:00Z'),
        make('ongoing', '2026-09-10T00:00:00Z', null),
      ],
      now,
    );
    expect(shown.map((n) => n.id)).toEqual(['ongoing', 'newer-resolved', 'recent-resolved']);
  });
});

describe('infra/status/notices.json', () => {
  const file = new URL('../notices.json', import.meta.url);
  const result = parseNotices(JSON.parse(readFileSync(file, 'utf8')) as unknown);

  it('is valid', () => {
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  // OPERATIONS §10.4: the founder's own words are held to the same never-send list.
  it('passes the never-send lint in own voice, both languages', () => {
    const notices = result.ok ? result.notices : [];
    for (const n of notices) {
      expect(lintAlertText(n.en, { voice: 'own' }), `${n.id}.en`).toEqual([]);
      expect(lintAlertText(n.bg, { voice: 'own' }), `${n.id}.bg`).toEqual([]);
    }
  });
});
