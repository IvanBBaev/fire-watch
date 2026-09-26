/**
 * Small, strict helpers for DNS names, shared by the email-auth checker and the
 * defensive-domain generator. ASCII (A-label) names only: an IDN is passed in its
 * `xn--` form, which is what DNS actually stores.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lower-cased, trailing dot removed; `null` when it is not a valid host name. */
export function normalizeDomain(value: string): string | null {
  const name = value.trim().toLowerCase().replace(/\.$/, '');
  if (name.length === 0 || name.length > 253) return null;
  const labels = name.split('.');
  if (labels.length < 2) return null;
  return labels.every((label) => isValidLabel(label)) ? name : null;
}

/** One LDH label (RFC 1035 / 5891 A-label): letters, digits, inner hyphens, 1–63 chars. */
export function isValidLabel(label: string): boolean {
  if (!LABEL.test(label)) return false;
  // Positions 3–4 "--" are reserved for A-labels (RFC 5891 §4.2.3.1).
  return !(label.slice(2, 4) === '--' && !label.startsWith('xn--'));
}

/**
 * The organizational domain the way this project uses it: the last two labels, unless the
 * caller knows better (a public-suffix-list lookup is deliberately not bundled — every
 * domain we are considering sits directly under `.bg`, `.com` or `.eu`).
 */
export function organizationalDomain(domain: string, override: string | null = null): string {
  if (override !== null) return override;
  return domain.split('.').slice(-2).join('.');
}

/** `sub` equals `parent` or is inside it. */
export function isSameOrSubdomain(sub: string, parent: string): boolean {
  return sub === parent || sub.endsWith(`.${parent}`);
}
