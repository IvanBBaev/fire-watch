/**
 * The staff curation routes over the in-memory incident-log store, with a fake staff
 * authenticator (TASKS L15). The cookie names the staff member directly: the real cookie
 * and its session lookup are the staff session store's, wired once the staff host exists.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import { REHEARSAL_CORRECTION, REHEARSAL_STATEMENT } from '../../core/staff/curation-rehearsal.js';
import type { StaffPrincipal } from '../../core/staff/staff-policy.js';
import { createMemoryIncidentLogStore } from '../staff/memory-incident-log-store.js';
import { registerStaffCurationRoutes, STAFF_CURATION_PATH } from './staff-curation-route.js';

const ORIGIN = 'https://fire-watch.example';

const PRINCIPALS: Readonly<Record<string, StaffPrincipal>> = {
  a: { staffId: 'staff-a', roles: ['editor'], secondFactorVerified: true },
  b: { staffId: 'staff-b', roles: ['editor'], secondFactorVerified: true },
  pending: { staffId: 'staff-p', roles: ['editor'], secondFactorVerified: false },
};

/** The fields of a version these tests read back. */
interface Wire {
  readonly entry_id: string;
  readonly version: number;
  readonly edit_seq: number;
}
const wire = (response: { json(): unknown }): Wire => response.json() as Wire;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build() {
  const log = createMemoryIncidentLogStore();
  let n = 0;
  const app = Fastify({ logger: false });
  apps.push(app);
  registerStaffCurationRoutes(app, {
    authenticate: (cookie) => {
      const who = /^staff=(\w+)$/.exec(cookie ?? '')?.[1];
      return Promise.resolve(who === undefined ? null : (PRINCIPALS[who] ?? null));
    },
    log,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    allowedOrigins: [ORIGIN],
    clock: new VirtualClock('2026-10-22T08:00:00Z'),
  });
  const call = (
    who: string | null,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `${STAFF_CURATION_PATH}${path}`,
      headers: { origin: ORIGIN, ...(who === null ? {} : { cookie: `staff=${who}` }) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { app, log, call };
}

describe('staff curation routes', () => {
  it('walks draft → review → publish → correction with two people', async () => {
    const { call, log } = build();
    const created = await call('a', 'POST', '', REHEARSAL_STATEMENT);
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const id = wire(created).entry_id;
    expect(created.json()).toMatchObject({ version: 1, status: 'draft', you_contributed: true });

    const submitted = await call('a', 'POST', `/${id}/submit`);
    expect(submitted.json()).toMatchObject({ status: 'in_review' });
    const { version, edit_seq } = wire(submitted);

    const self = await call('a', 'POST', `/${id}/review`, {
      verdict: 'approve',
      version,
      edit_seq,
    });
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ code: 'statement_self_review' });

    const read = await call('b', 'GET', `/${id}`);
    expect(read.json()).toMatchObject({ you_contributed: false, status: 'in_review' });

    const published = await call('b', 'POST', `/${id}/review`, {
      verdict: 'approve',
      version,
      edit_seq,
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ status: 'published', version: 1 });
    const frozen = wire(published);

    const silent = await call('b', 'PUT', `/${id}`, {
      statement: REHEARSAL_STATEMENT,
      version: frozen.version,
      edit_seq: frozen.edit_seq,
    });
    expect(silent.statusCode).toBe(409);
    expect(silent.json()).toMatchObject({ code: 'statement_wrong_status' });

    const correction = await call('a', 'POST', `/${id}/corrections`, REHEARSAL_CORRECTION);
    expect(correction.statusCode).toBe(201);
    expect(correction.json()).toMatchObject({ version: 2, status: 'draft', corrects: 1 });
    const inReview = wire(await call('a', 'POST', `/${id}/submit`));
    const fixed = await call('b', 'POST', `/${id}/review`, {
      verdict: 'approve',
      version: inReview.version,
      edit_seq: inReview.edit_seq,
    });
    expect(fixed.json()).toMatchObject({ status: 'published', version: 2, corrects: 1 });

    expect(log.audit().map((row) => [row.actorId, row.action, row.version])).toEqual([
      ['staff-a', 'incident.draft', 1],
      ['staff-a', 'incident.submit', 1],
      ['staff-b', 'incident.publish', 1],
      ['staff-a', 'incident.edit', 2],
      ['staff-a', 'incident.submit', 2],
      ['staff-b', 'incident.publish', 2],
    ]);
  });

  it('401 without a staff session, 403 before the second factor', async () => {
    const { call, log } = build();
    const anonymous = await call(null, 'POST', '', REHEARSAL_STATEMENT);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'not_signed_in' });
    const pending = await call('pending', 'POST', '', REHEARSAL_STATEMENT);
    expect(pending.statusCode).toBe(403);
    expect(pending.json()).toMatchObject({ code: 'staff_forbidden' });
    expect(log.audit()).toEqual([]);
  });

  it('403 on a foreign Origin, before authenticating', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'POST',
      url: STAFF_CURATION_PATH,
      headers: { origin: 'https://evil.example', cookie: 'staff=a' },
      payload: REHEARSAL_STATEMENT,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_refused' });
  });

  it('names the §5.10 refusals by code; never echoes the issues', async () => {
    const { call } = build();
    const t4 = await call('a', 'POST', '', {
      ...REHEARSAL_STATEMENT,
      source: { ...REHEARSAL_STATEMENT.source, tier: 'T4' },
    });
    expect(t4.statusCode).toBe(422);
    expect(t4.json()).toMatchObject({ code: 'statement_source_unverified' });
    const noCapture = await call('a', 'POST', '', {
      ...REHEARSAL_STATEMENT,
      source: { ...REHEARSAL_STATEMENT.source, capture: '' },
    });
    expect(noCapture.json()).toMatchObject({ code: 'statement_capture_missing' });
    const invalid = await call('a', 'POST', '', { ...REHEARSAL_STATEMENT, justification: '' });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'statement_invalid' });
    expect(Object.keys(invalid.json())).not.toContain('issues');
  });

  it('400 on a malformed body or verdict; 404 on an unknown or malformed id', async () => {
    const { call } = build();
    expect((await call('a', 'POST', '', { eventId: 1 })).statusCode).toBe(400);
    const created = wire(await call('a', 'POST', '', REHEARSAL_STATEMENT));
    const verdict = await call('b', 'POST', `/${created.entry_id}/review`, {
      verdict: 'maybe',
      version: 1,
      edit_seq: 0,
    });
    expect(verdict.statusCode).toBe(400);
    const missing = await call('a', 'GET', '/00000000-0000-4000-8000-999999999999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'statement_not_found' });
    expect((await call('a', 'GET', '/not-a-uuid')).statusCode).toBe(404);
  });

  it('409 statement_conflict on a stale version', async () => {
    const { call } = build();
    const created = wire(await call('a', 'POST', '', REHEARSAL_STATEMENT));
    await call('a', 'POST', `/${created.entry_id}/submit`);
    const stale = await call('b', 'POST', `/${created.entry_id}/review`, {
      verdict: 'approve',
      version: 1,
      edit_seq: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'statement_conflict' });
  });
});
