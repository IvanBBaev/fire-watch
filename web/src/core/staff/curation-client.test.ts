import type { CuratedStatementDraft } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { createCurationClient, curationOutcomeOf, STAFF_CURATION_URL } from './curation-client.js';

const STATEMENT: CuratedStatementDraft = {
  eventId: 'event-1',
  statementType: 'officially_contained',
  source: { tier: 'T1', url: 'https://authority.example.invalid/b/1', capture: 'captures/1.pdf' },
  statedAt: '2026-08-01T09:30:00Z',
  secondSource: null,
  exception: 't1_de_escalation',
  justification: 'The bulletin says so.',
  correctionText: null,
};

const WIRE = {
  entry_id: '00000000-0000-4000-8000-000000000001',
  version: 1,
  status: 'in_review',
  edit_seq: 2,
  corrects: null,
  statement: STATEMENT,
  contributor_ids: ['staff-a'],
  you_contributed: true,
  updated_at: '2026-10-22T08:00:00.000Z',
  published_at: null,
};

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status: number, code: string) =>
  json(status, { status, title: 'x', code }, 'application/problem+json');

describe('curationOutcomeOf', () => {
  it('reads a version', async () => {
    expect(await curationOutcomeOf(json(200, WIRE))).toEqual({
      kind: 'ok',
      value: {
        entryId: WIRE.entry_id,
        version: 1,
        status: 'in_review',
        editSeq: 2,
        corrects: null,
        statement: STATEMENT,
        contributorIds: ['staff-a'],
        youContributed: true,
        updatedAt: WIRE.updated_at,
        publishedAt: null,
      },
    });
    expect(await curationOutcomeOf(json(200, { entry_id: 1 }))).toEqual({ kind: 'failed' });
  });

  it('reads each refusal by its code', async () => {
    const cases: [number, string, string][] = [
      [401, 'not_signed_in', 'not-signed-in'],
      [403, 'staff_forbidden', 'forbidden'],
      [422, 'statement_invalid', 'invalid'],
      [422, 'statement_source_unverified', 'source-unverified'],
      [422, 'statement_capture_missing', 'capture-missing'],
      [404, 'statement_not_found', 'not-found'],
      [409, 'statement_wrong_status', 'wrong-status'],
      [403, 'statement_self_review', 'self-review'],
      [409, 'statement_conflict', 'conflict'],
    ];
    for (const [status, code, reason] of cases) {
      expect(await curationOutcomeOf(problem(status, code))).toEqual({ kind: 'refused', reason });
    }
  });

  it('a bare 404/405 means the staff routes are not served here; other failures are failures', async () => {
    expect(await curationOutcomeOf(new Response('nope', { status: 404 }))).toEqual({
      kind: 'unavailable',
    });
    expect(await curationOutcomeOf(new Response('', { status: 405 }))).toEqual({
      kind: 'unavailable',
    });
    expect(await curationOutcomeOf(new Response('', { status: 401 }))).toEqual({
      kind: 'refused',
      reason: 'not-signed-in',
    });
    expect(await curationOutcomeOf(problem(400, 'invalid_body'))).toEqual({ kind: 'failed' });
    expect(await curationOutcomeOf(new Response('', { status: 503 }))).toEqual({ kind: 'failed' });
  });
});

describe('createCurationClient', () => {
  it('sends same-origin requests with the optimistic version on review', async () => {
    const calls: [string, RequestInit][] = [];
    const client = createCurationClient({
      fetchFn: (input, init) => {
        calls.push([
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          init ?? {},
        ]);
        return Promise.resolve(json(200, WIRE));
      },
    });
    const read = await client.read(WIRE.entry_id);
    if (read.kind !== 'ok') throw new Error('not read');
    await client.review(read.value, 'reject');
    await client.correct(WIRE.entry_id, STATEMENT);
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      [`${STAFF_CURATION_URL}/${WIRE.entry_id}`, 'GET'],
      [`${STAFF_CURATION_URL}/${WIRE.entry_id}/review`, 'POST'],
      [`${STAFF_CURATION_URL}/${WIRE.entry_id}/corrections`, 'POST'],
    ]);
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual({
      verdict: 'reject',
      version: 1,
      edit_seq: 2,
    });
    for (const [, init] of calls) {
      expect(init).toMatchObject({
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'strict-origin',
      });
    }
  });

  it('a network error is a failure, never a throw', async () => {
    const client = createCurationClient({ fetchFn: () => Promise.reject(new Error('offline')) });
    expect(await client.create(STATEMENT)).toEqual({ kind: 'failed' });
  });
});
