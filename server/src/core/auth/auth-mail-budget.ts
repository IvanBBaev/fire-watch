/**
 * The sign-in mail budget on its two request-side axes (TASKS R5-SEC-3; review 28 E-3, R-3).
 *
 * `AUTH_POLICY` already caps links per **address** (3/hour, C2). That protects one inbox
 * from repeated mail, not the sender: one client rotating through addresses, or many
 * clients at once, could still spend the SES account that also carries fire alerts. So two
 * more caps sit in front of the address check:
 *
 *   * **per client**: {@link AUTH_MAIL_BUDGET}.perClientPerWindow links per hour per source
 *     address, with an IPv6 client keyed by its /64 ({@link budgetClientKey}), because a
 *     single host is routinely handed a whole /64 and can rotate inside it for free;
 *   * **global**: {@link AUTH_MAIL_BUDGET}.globalPerWindow links per hour across everyone.
 *
 * Over either cap the route answers exactly what it answers for a sent link (`202`) and
 * sends nothing: an answer that differed would tell a caller which addresses were spent,
 * or that the service is being flooded. A request refused per client is not counted
 * globally, so one client over its own cap cannot use up everyone else's budget.
 *
 * The numbers are review 28 Q3's recommendation, ratified as provisional on 2026-11-07
 * (`docs/decisions/founder-2026-10-30/thresholds-ops.md`, SEC-3 row). They are rules, not
 * tuning knobs: changing one is a decision-record line first.
 *
 * The state is in-process. One API process serves the product (OPERATIONS §9), and a
 * restart forgets at most one window — an over-admission bounded by one hour's budget,
 * which the per-address cap in the database still limits per inbox.
 */

import { createRateLimiter, type RateLimiter } from '../http/rate-limiter.js';

const HOUR_MS = 3_600_000;

export const AUTH_MAIL_BUDGET = {
  /** Review 28 E-3 / Q3: "10/h per IP". */
  perClientPerWindow: 10,
  /** Review 28 Q3: "200/h at launch". */
  globalPerWindow: 200,
  windowMs: HOUR_MS,
  /** Review 28 E-3: "a meta-alert when 50% is reached"; the AuthMailBudgetHalf rule. */
  warnFraction: 0.5,
} as const;

/** Why a link request was answered without mail. */
export const AUTH_MAIL_SUPPRESS_REASONS = ['over_client', 'over_global'] as const;
export type AuthMailSuppressReason = (typeof AUTH_MAIL_SUPPRESS_REASONS)[number];

export type AuthMailAdmission = 'send' | AuthMailSuppressReason;

/** The budget as the metrics collector reads it, at scrape time. */
export interface AuthMailBudgetReading {
  /** Links admitted in the current global window. 0 once the window has passed. */
  readonly globalUsed: number;
  readonly globalLimit: number;
  /** Requests answered without mail since process start, by reason. */
  readonly suppressed: Readonly<Record<AuthMailSuppressReason, number>>;
}

export interface AuthMailBudget {
  /** Counts one link request from `clientKey` and says whether it may send. */
  admit(clientKey: string, now: number): AuthMailAdmission;
  reading(now: number): AuthMailBudgetReading;
}

export interface AuthMailBudgetOptions {
  readonly perClientPerWindow?: number;
  readonly globalPerWindow?: number;
  readonly windowMs?: number;
}

export function createAuthMailBudget(options: AuthMailBudgetOptions = {}): AuthMailBudget {
  const windowMs = options.windowMs ?? AUTH_MAIL_BUDGET.windowMs;
  const globalLimit = options.globalPerWindow ?? AUTH_MAIL_BUDGET.globalPerWindow;
  if (!Number.isInteger(globalLimit) || globalLimit < 1) {
    throw new RangeError(
      `global mail budget must be a positive integer, got ${String(globalLimit)}`,
    );
  }
  const perClient: RateLimiter = createRateLimiter({
    limit: options.perClientPerWindow ?? AUTH_MAIL_BUDGET.perClientPerWindow,
    windowMs,
  });
  // One fixed window, the same shape as the per-client limiter's, kept here rather than as
  // a single-key limiter because the collector needs the count, not only a decision.
  let global = { startedAt: Number.NEGATIVE_INFINITY, used: 0 };
  const suppressed: Record<AuthMailSuppressReason, number> = { over_client: 0, over_global: 0 };

  const current = (now: number): { startedAt: number; used: number } =>
    now - global.startedAt >= windowMs ? { startedAt: now, used: 0 } : global;

  return {
    admit(clientKey, now) {
      if (!perClient.check(budgetClientKey(clientKey), now).allowed) {
        suppressed.over_client += 1;
        return 'over_client';
      }
      global = current(now);
      if (global.used >= globalLimit) {
        suppressed.over_global += 1;
        return 'over_global';
      }
      global.used += 1;
      return 'send';
    },
    reading(now) {
      return { globalUsed: current(now).used, globalLimit, suppressed: { ...suppressed } };
    },
  };
}

/**
 * The key a client is budgeted under: an IPv4 address as itself, an IPv6 address as its
 * /64 prefix (an IPv4-mapped IPv6 address as the IPv4 inside it), and anything that is
 * not an address — a malformed edge header — as itself, so it still has a budget.
 */
export function budgetClientKey(key: string): string {
  const address = key.trim().toLowerCase();
  if (!address.includes(':')) return address;
  const groups = expandIpv6(address.split('%')[0] ?? '');
  if (groups === null) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Eight 16-bit groups without leading zeros, or null when the text is not IPv6. */
function expandIpv6(text: string): string[] | null {
  // A trailing dotted quad (`::ffff:1.2.3.4`) is two groups; only its count matters here.
  const body = text.replace(/\d{1,3}(?:\.\d{1,3}){3}$/, '0:0');
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): string[] =>
    part === undefined || part === '' ? [] : part.split(':');
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 1 ? 0 : fill).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
}
