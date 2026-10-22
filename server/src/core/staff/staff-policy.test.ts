import { describe, expect, it } from 'vitest';

import {
  STAFF_ACTIONS,
  STAFF_PERMISSIONS,
  STAFF_ROLES,
  decideBroadcastApproval,
  isStaffRole,
  staffMay,
  type StaffPrincipal,
  type StaffRole,
} from './staff-policy.js';

const member = (
  staffId: string,
  roles: StaffRole[],
  secondFactorVerified = true,
): StaffPrincipal => ({
  staffId,
  roles,
  secondFactorVerified,
});

describe('the role table is 05 §5.4.3', () => {
  it('editors cannot send notifications at all (C3)', () => {
    expect(STAFF_PERMISSIONS.editor.some((action) => action.startsWith('notification.'))).toBe(
      false,
    );
  });

  it('alert-operators cannot edit incidents (content and reach are separate powers)', () => {
    expect(
      STAFF_PERMISSIONS['alert-operator'].some((action) => action.startsWith('incident.')),
    ).toBe(false);
  });

  it('admin does not inherit send rights, nor incident editing', () => {
    expect(staffMay(member('a', ['admin']), 'notification.approve')).toBe(false);
    expect(staffMay(member('a', ['admin']), 'incident.publish')).toBe(false);
  });

  it('moderators hold the report queue and nothing else', () => {
    expect(STAFF_PERMISSIONS.moderator).toEqual(['report.moderate']);
  });

  it('every action is granted to exactly one role', () => {
    for (const action of STAFF_ACTIONS) {
      expect(STAFF_ROLES.filter((role) => STAFF_PERMISSIONS[role].includes(action))).toHaveLength(
        1,
      );
    }
  });

  it('recognises exactly the four roles', () => {
    expect(STAFF_ROLES.every(isStaffRole)).toBe(true);
    for (const value of ['Editor', 'operator', 'root', '', null, 3]) {
      expect(isStaffRole(value)).toBe(false);
    }
  });
});

describe('staffMay', () => {
  it('grants nothing before the second factor (2FA mandatory, C3)', () => {
    const pending = member('e', [...STAFF_ROLES], false);
    for (const action of STAFF_ACTIONS) expect(staffMay(pending, action)).toBe(false);
  });

  it('unions the roles a member holds', () => {
    const both = member('e', ['editor', 'alert-operator']);
    expect(staffMay(both, 'incident.publish')).toBe(true);
    expect(staffMay(both, 'notification.approve')).toBe(true);
    expect(staffMay(both, 'staff.manage')).toBe(false);
  });

  it('a member with no roles may do nothing', () => {
    for (const action of STAFF_ACTIONS) expect(staffMay(member('x', []), action)).toBe(false);
  });
});

describe('decideBroadcastApproval: the two-person rule (A3)', () => {
  const creator = member('c', ['editor', 'alert-operator']);

  it('approves a different, 2FA-d alert-operator', () => {
    expect(decideBroadcastApproval(creator, member('o', ['alert-operator']))).toEqual({
      kind: 'approved',
    });
  });

  it('refuses self-approval even when the creator holds alert-operator', () => {
    expect(decideBroadcastApproval(creator, creator)).toEqual({
      kind: 'refused',
      reason: 'same_person',
    });
  });

  it('refuses an approver without the role — admin included', () => {
    for (const roles of [['editor'], ['admin'], ['moderator']] as StaffRole[][]) {
      expect(decideBroadcastApproval(creator, member('o', roles))).toEqual({
        kind: 'refused',
        reason: 'not_alert_operator',
      });
    }
  });

  it('refuses when either side has not passed 2FA', () => {
    const operator = member('o', ['alert-operator']);
    expect(decideBroadcastApproval(member('c', ['editor'], false), operator).kind).toBe('refused');
    expect(decideBroadcastApproval(creator, member('o', ['alert-operator'], false))).toEqual({
      kind: 'refused',
      reason: 'second_factor_missing',
    });
  });
});
