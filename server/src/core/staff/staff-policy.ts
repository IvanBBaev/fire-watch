/**
 * The staff plane's authorization rules, as pure functions (TASKS I1; 05 §5.4.3, C3, A3).
 *
 * 05 names four roles and says what each may and may not do. This module turns that list
 * into one table ({@link STAFF_PERMISSIONS}) and two decisions:
 *
 *   * {@link staffMay}: may this staff principal take this action at all? A principal whose
 *     session has not passed a second factor may do nothing — 2FA is mandatory (C3), so
 *     "signed in, 2FA pending" is a state with no powers, not a weaker role.
 *   * {@link decideBroadcastApproval}: the two-person rule (A3). The approver must hold
 *     `alert-operator`, be 2FA'd, and be a different human from the creator. 05 allows one
 *     person to hold both `editor` and `alert-operator`; the rule still binds, because it
 *     compares people, not roles.
 *
 * The separation 05 asks for is visible in the table rather than in branches: `editor`
 * holds no `notification.*` action, `alert-operator` holds no `incident.*` action, and
 * `admin` inherits nothing — "does not inherit send rights" is the absence of a row.
 *
 * What is not here: the second-factor mechanisms themselves (WebAuthn, TOTP — the TOTP
 * arithmetic is `adapters/crypto/totp.ts`), the staff session store, and the HTTP plane on
 * its own subdomain.
 */

export const STAFF_ROLES = ['editor', 'alert-operator', 'moderator', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_ACTIONS = [
  'incident.draft',
  'incident.review',
  'incident.publish',
  'notification.approve',
  'report.moderate',
  'staff.manage',
  'config.edit',
  'audit.read',
] as const;
export type StaffAction = (typeof STAFF_ACTIONS)[number];

/**
 * 05 §5.4.3, role by role. `incident.review` sits with `editor`: the C4 second review is a
 * second *editor*, and the incident workflow (`incident-log-workflow.ts`) refuses anyone
 * who wrote the version as its reviewer. `audit.read` is `admin` only — the trail is
 * evidence about staff, so the people it records do not curate their own view of it.
 */
export const STAFF_PERMISSIONS: Readonly<Record<StaffRole, readonly StaffAction[]>> = {
  editor: ['incident.draft', 'incident.review', 'incident.publish'],
  'alert-operator': ['notification.approve'],
  moderator: ['report.moderate'],
  admin: ['staff.manage', 'config.edit', 'audit.read'],
};

export interface StaffPrincipal {
  readonly staffId: string;
  readonly roles: readonly StaffRole[];
  /** True only once this session has passed WebAuthn, TOTP or a recovery code. */
  readonly secondFactorVerified: boolean;
}

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}

export function staffMay(principal: StaffPrincipal, action: StaffAction): boolean {
  if (!principal.secondFactorVerified) return false;
  return principal.roles.some((role) => STAFF_PERMISSIONS[role].includes(action));
}

export type BroadcastApprovalDecision =
  | { readonly kind: 'approved' }
  | {
      readonly kind: 'refused';
      readonly reason: 'second_factor_missing' | 'not_alert_operator' | 'same_person';
    };

/** A3: creator ≠ approver, both 2FA'd; the approver holds `alert-operator`. */
export function decideBroadcastApproval(
  creator: StaffPrincipal,
  approver: StaffPrincipal,
): BroadcastApprovalDecision {
  if (!creator.secondFactorVerified || !approver.secondFactorVerified) {
    return { kind: 'refused', reason: 'second_factor_missing' };
  }
  if (!staffMay(approver, 'notification.approve')) {
    return { kind: 'refused', reason: 'not_alert_operator' };
  }
  if (creator.staffId === approver.staffId) return { kind: 'refused', reason: 'same_person' };
  return { kind: 'approved' };
}
