/**
 * The staff member routes over a fake staff store and a fake authenticator (TASKS I1). The
 * cookie names the principal directly, as in the curation route tests; the decisions are
 * `staff-session-policy.ts`'s, so these tests pin the wire: paths, bodies and codes.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { StaffStore } from '../../core/ports/staff-stores.js';
import type { StaffPrincipal } from '../../core/staff/staff-policy.js';
import { registerStaffMembersRoutes, STAFF_MEMBERS_PATH } from './staff-members-route.js';

const ORIGIN = 'https://staff.fire-watch.example';
const ADMIN = '00000000-0000-4000-8000-00000000000a';
const EDITOR = '00000000-0000-4000-8000-00000000000e';
const GONE = '00000000-0000-4000-8000-000000000000';
const LIVE = '00000000-0000-4000-8000-0000000000aa';
const HOLDING = '00000000-0000-4000-8000-0000000000bb';
const SOLE = '00000000-0000-4000-8000-0000000000cc';

const PRINCIPALS: Readonly<Record<string, StaffPrincipal>> = {
  admin: { staffId: ADMIN, roles: ['admin'], secondFactorVerified: true },
  pending: { staffId: ADMIN, roles: ['admin'], secondFactorVerified: false },
  editor: { staffId: EDITOR, roles: ['editor'], secondFactorVerified: true },
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build() {
  const calls: string[] = [];
  const removal = (staffId: string) =>
    Promise.resolve(
      staffId === GONE
        ? { kind: 'not_found' as const }
        : staffId === SOLE
          ? { kind: 'last_second_factor' as const }
          : { kind: 'removed' as const, sessionsRevoked: 1 },
    );
  const staff = {
    removeWebAuthnCredential: (staffId: string, id: Uint8Array) => {
      calls.push(`removeWebAuthn:${staffId}:${[...id].join(',')}`);
      return removal(staffId);
    },
    removeTotpFactor: (staffId: string) => {
      calls.push(`removeTotp:${staffId}`);
      return removal(staffId);
    },
    disableMember: (staffId: string) =>
      Promise.resolve(
        staffId === GONE
          ? { kind: 'not_found' as const }
          : { kind: 'disabled' as const, sessionsRevoked: 2 },
      ),
    offboardMember: (staffId: string) =>
      Promise.resolve(
        staffId === GONE
          ? { kind: 'not_found' as const }
          : staffId === HOLDING
            ? { kind: 'already_offboarded' as const }
            : {
                kind: 'offboarded' as const,
                wasLive: true,
                sessionsRevoked: 1,
                webauthnRemoved: 1,
                totpRemoved: 0,
                recoveryCodesRemoved: 10,
                rolesRemoved: ['editor'],
              },
      ),
    readmitMember: (staffId: string, roles: readonly string[]) => {
      calls.push(`readmit:${roles.join(',')}`);
      const kind: Record<string, string> = {
        [GONE]: 'not_found',
        [LIVE]: 'already_live',
        [HOLDING]: 'not_offboarded',
      };
      return Promise.resolve({ kind: kind[staffId] ?? 'readmitted' });
    },
    setRoles: (staffId: string, roles: readonly string[]) => {
      calls.push(`setRoles:${roles.join(',')}`);
      return Promise.resolve({ kind: staffId === GONE ? 'not_found' : 'changed' });
    },
  } as unknown as StaffStore;
  const app = Fastify({ logger: false });
  apps.push(app);
  registerStaffMembersRoutes(app, {
    authenticate: (cookie) => {
      const who = /^staff=(\w+)$/.exec(cookie ?? '')?.[1];
      return Promise.resolve(who === undefined ? null : (PRINCIPALS[who] ?? null));
    },
    staff,
    allowedOrigins: [ORIGIN],
    clock: new VirtualClock('2026-10-27T08:00:00Z'),
  });
  const call = (
    who: string | null,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: object,
    origin: string = ORIGIN,
  ) =>
    app.inject({
      method,
      url: `${STAFF_MEMBERS_PATH}${path}`,
      headers: { origin, ...(who === null ? {} : { cookie: `staff=${who}` }) },
      ...(payload === undefined ? {} : { payload }),
    });
  return { call, calls };
}

describe('staff member routes', () => {
  it('lets a member remove their own passkey, and maps the store refusals', async () => {
    const { call, calls } = build();
    const own = await call('editor', 'DELETE', `/${EDITOR}/webauthn/Bwc`);
    expect(own.statusCode).toBe(200);
    expect(own.headers['cache-control']).toBe('no-store');
    expect(own.json()).toEqual({ sessions_revoked: 1 });
    expect(calls).toEqual([`removeWebAuthn:${EDITOR}:7,7`]);

    const other = await call('editor', 'DELETE', `/${ADMIN}/webauthn/Bwc`);
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ code: 'staff_forbidden' });

    const sole = await call('admin', 'DELETE', `/${SOLE}/totp`);
    expect(sole.statusCode).toBe(409);
    expect(sole.json()).toMatchObject({ code: 'staff_last_second_factor' });

    const missing = await call('admin', 'DELETE', `/${GONE}/totp`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'staff_factor_not_found' });

    for (const path of ['/not-a-uuid/totp', `/${EDITOR}/webauthn/not=base64`]) {
      const malformed = await call('admin', 'DELETE', path);
      expect(malformed.statusCode).toBe(404);
      expect(malformed.json()).toMatchObject({ code: 'staff_factor_not_found' });
    }
  });

  it('disables and off-boards a member, never oneself', async () => {
    const { call } = build();
    const disabled = await call('admin', 'POST', `/${EDITOR}/disable`);
    expect(disabled.json()).toEqual({ sessions_revoked: 2 });

    const offboarded = await call('admin', 'POST', `/${EDITOR}/offboard`);
    expect(offboarded.json()).toEqual({
      offboarded: true,
      was_live: true,
      sessions_revoked: 1,
      webauthn_removed: 1,
      totp_removed: 0,
      recovery_codes_removed: 10,
      roles_removed: ['editor'],
    });
    const again = await call('admin', 'POST', `/${HOLDING}/offboard`);
    expect(again.json()).toEqual({ offboarded: false });

    const self = await call('admin', 'POST', `/${ADMIN}/offboard`);
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ code: 'staff_self_change' });

    const missing = await call('admin', 'POST', `/${GONE}/disable`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'staff_member_not_found' });

    for (const who of ['editor', 'pending']) {
      const refused = await call(who, 'POST', `/${EDITOR}/disable`);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'staff_forbidden' });
    }
  });

  it('re-admits only an off-boarded member, with a valid role set', async () => {
    const { call, calls } = build();
    const readmitted = await call('admin', 'POST', `/${EDITOR}/readmit`, { roles: ['editor'] });
    expect(readmitted.json()).toEqual({ readmitted: true });
    expect(calls).toEqual(['readmit:editor']);

    const live = await call('admin', 'POST', `/${LIVE}/readmit`, { roles: [] });
    expect(live.statusCode).toBe(409);
    expect(live.json()).toMatchObject({ code: 'staff_member_live' });

    const holding = await call('admin', 'POST', `/${HOLDING}/readmit`, { roles: [] });
    expect(holding.statusCode).toBe(409);
    expect(holding.json()).toMatchObject({ code: 'staff_member_not_offboarded' });

    for (const roles of [['root'], ['editor', 'editor'], 'editor']) {
      const bad = await call('admin', 'POST', `/${EDITOR}/readmit`, { roles });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ code: 'invalid_body' });
    }
  });

  it('replaces a role set', async () => {
    const { call, calls } = build();
    const changed = await call('admin', 'PUT', `/${EDITOR}/roles`, {
      roles: ['editor', 'moderator'],
    });
    expect(changed.json()).toEqual({ changed: true });
    expect(calls).toEqual(['setRoles:editor,moderator']);
    const missing = await call('admin', 'PUT', `/${GONE}/roles`, { roles: [] });
    expect(missing.json()).toMatchObject({ code: 'staff_member_not_found' });
  });

  it('refuses a request with no staff session or from a foreign Origin', async () => {
    const { call, calls } = build();
    const anonymous = await call(null, 'POST', `/${EDITOR}/disable`);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'not_signed_in' });
    const foreign = await call(
      'admin',
      'POST',
      `/${EDITOR}/disable`,
      undefined,
      'https://x.example',
    );
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'origin_refused' });
    expect(calls).toEqual([]);
  });
});
