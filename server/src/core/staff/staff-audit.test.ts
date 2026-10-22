import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { buildStaffAuditRecord, hashEntityState } from './staff-audit.js';

/** A stand-in that exposes what was hashed; the real SHA-256 lives behind the port. */
const sha256Hex = (text: string): string => `sha256(${text})`;
const AT = epochMsFromIso('2026-10-22T09:30:00Z');

describe('buildStaffAuditRecord (05 §5.4.3)', () => {
  it('records actor, action, entity, before/after hash, IP and time', () => {
    const record = buildStaffAuditRecord(
      {
        actorId: 'ana',
        action: 'incident.publish',
        entity: { kind: 'incident_log_entry', id: 'e1' },
        before: { status: 'in_review', version: 2 },
        after: { status: 'published', version: 2 },
        ip: '203.0.113.7',
        at: AT,
      },
      sha256Hex,
    );
    expect(record).toEqual({
      actorId: 'ana',
      action: 'incident.publish',
      entityKind: 'incident_log_entry',
      entityId: 'e1',
      beforeHash: sha256Hex('{"status":"in_review","version":2}'),
      afterHash: sha256Hex('{"status":"published","version":2}'),
      ip: '203.0.113.7',
      atIso: '2026-10-22T09:30:00Z',
    });
  });

  it('hashes state canonically, so key order does not change the hash', () => {
    expect(hashEntityState({ a: 1, b: [2, { d: 3, c: 4 }] }, sha256Hex)).toBe(
      hashEntityState({ b: [2, { c: 4, d: 3 }], a: 1 }, sha256Hex),
    );
  });

  it('leaves the before hash null for a creation and the IP null for a CLI action', () => {
    const record = buildStaffAuditRecord(
      {
        actorId: 'ana',
        action: 'incident.draft',
        entity: { kind: 'incident_log_entry', id: 'e1' },
        after: {},
        at: AT,
      },
      sha256Hex,
    );
    expect(record.beforeHash).toBeNull();
    expect(record.afterHash).toBe(sha256Hex('{}'));
    expect(record.ip).toBeNull();
  });

  it('refuses a record with no actor or no entity', () => {
    expect(() =>
      buildStaffAuditRecord(
        { actorId: '', action: 'staff.sign_in', entity: { kind: 'staff', id: 'a' }, at: AT },
        sha256Hex,
      ),
    ).toThrow(/actor/);
    expect(() =>
      buildStaffAuditRecord(
        { actorId: 'a', action: 'staff.sign_in', entity: { kind: 'staff', id: '' }, at: AT },
        sha256Hex,
      ),
    ).toThrow(/entity/);
  });
});
