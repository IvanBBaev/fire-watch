/**
 * What an SES bounce or complaint means for the address it names (04-sre §5
 * "deliverability hygiene"; the gap TASKS H5 left open).
 *
 * The SES channel never learns about a bounce from `SendEmail` — the call succeeds and the
 * mail fails later, somewhere else — so the email adapter can never answer `prune` the way
 * the Telegram and web-push adapters do. The answer arrives asynchronously, as an SNS
 * notification whose `Message` is an SES feedback document, and this module is the pure
 * half of turning it into a suppression: parse the document, decide per recipient, and
 * hand the suppressions to a port. Signature checking (the SNS envelope) and the SQL are
 * adapters; nothing here knows either exists.
 *
 * **Two formats, one decision.** SES publishes feedback two ways and both reach the same
 * kind of topic: the classic identity notifications carry `notificationType`, the
 * configuration-set event publishing carries `eventType`. The payloads are otherwise the
 * same shape for the two types that matter (`bounce` / `complaint` objects with
 * `bouncedRecipients` / `complainedRecipients`), so the parser reads the type from
 * whichever field is present — `eventType` first, because a document carrying both is an
 * event-publishing one — and the rest once.
 *
 * **The rule** (AWS SES developer guide, "Amazon SES notification contents" and
 * "Event publishing contents"):
 *
 *   * `Bounce` with `bounceType: "Permanent"` → **suppress**, whatever the sub-type:
 *     `General`, `NoEmail`, `Suppressed` and `OnAccountSuppressionList` all mean the next
 *     send to this address will bounce again. Sending into hard bounces is what gets an
 *     SES account put under review.
 *   * `Bounce` with `Transient` → **ignore**. A full mailbox, an auto-reply, a message
 *     too large: the address is real and may work tomorrow. SES has already retried.
 *   * `Bounce` with `Undetermined` → **ignore**. SES says it could not tell; suppressing
 *     on a guess revokes a working channel, and a real hard bounce will come back as one.
 *   * `Complaint` → **suppress**, unless `complaintFeedbackType` is `not-spam`, which is
 *     the mailbox provider saying the person *un*-marked the mail as spam — the opposite
 *     of a complaint, delivered on the same channel. A complaint without a feedback type
 *     (many providers send none) is still a complaint.
 *   * Everything else — `Delivery`, `Send`, `Reject`, `Open`, `Click`, `DeliveryDelay`,
 *     `Rendering Failure`, `Subscription`, SES's own `AmazonSnsSubscriptionSucceeded`
 *     test message — → **ignore**. A topic shared with other event types must not make
 *     this handler fail, so an unknown type is not malformed.
 *
 * **Address normalization.** Endpoints are stored through `normalizeEmail`
 * (`core/auth/auth-policy.ts`): trimmed and lowercased *as a whole*, local part included.
 * RFC 5321 lets a local part be case-sensitive, and the usual hygiene advice is to fold
 * only the domain; folding both here is deliberate, because the comparison has to agree
 * with how the endpoint was written, not with the RFC. A bounce for `Ana@Example.com`
 * therefore suppresses the stored `ana@example.com`, which is the same mailbox at every
 * provider anyone actually uses. SES reports `emailAddress` as a bare address, but a DSN's
 * `Final-Recipient` can arrive as `Name <addr>`, so one `<…>` wrapper is unwrapped first.
 * A recipient that does not normalize is reported, never suppressed: there is no stored
 * endpoint it could match.
 *
 * **Logging.** The decisions carry the normalized address because the port needs it; the
 * {@link summarizeFeedback} counts are what a log line gets. No caller should log an
 * address — the redactor's free-text leg would catch it, but it should not have to.
 */

import { normalizeEmail } from '../auth/auth-policy.js';
import type { EpochMs } from '../ports/clock.js';
import type { EmailSuppressor } from '../ports/email-suppressor.js';

/** The feedback type, folded across both formats. `other` is every type we ignore. */
export type FeedbackKind = 'bounce' | 'complaint' | 'other';

/** Why a recipient was suppressed or not — a closed vocabulary, safe to log and count. */
export type FeedbackReason =
  | 'permanent_bounce'
  | 'transient_bounce'
  | 'undetermined_bounce'
  | 'complaint'
  | 'complaint_not_spam'
  | 'unparseable_address';

export interface RecipientDecision {
  readonly action: 'suppress' | 'ignore';
  readonly reason: FeedbackReason;
  /** Normalized as stored; `null` only for `unparseable_address`. Never log it. */
  readonly address: string | null;
}

export type ParsedFeedback =
  | {
      readonly status: 'parsed';
      readonly kind: FeedbackKind;
      /** The raw `eventType` / `notificationType`, for the log line. Bounded in length. */
      readonly type: string;
      /** SES's id of the original message, when present — the operator's join key. */
      readonly mailMessageId: string | null;
      /** One per distinct recipient; empty for `other`. */
      readonly decisions: readonly RecipientDecision[];
    }
  | {
      readonly status: 'malformed';
      /** Literal text from this module, never from the payload. */
      readonly reason: string;
    };

/** Long enough for any SES type name, short enough that a hostile one is not a log line. */
const MAX_TYPE_CHARS = 40;
/** SES caps recipients per message at 50; a document claiming far more is not SES. */
const MAX_RECIPIENTS = 100;

/**
 * Parses an SES feedback document — the SNS `Message` string — and decides per recipient.
 * Total: never throws, whatever the input.
 */
export function parseSesFeedback(message: string): ParsedFeedback {
  let document: unknown;
  try {
    document = JSON.parse(message);
  } catch {
    return { status: 'malformed', reason: 'message is not JSON' };
  }
  if (!isRecord(document)) return { status: 'malformed', reason: 'message is not an object' };

  const rawType =
    typeof document['eventType'] === 'string'
      ? document['eventType']
      : typeof document['notificationType'] === 'string'
        ? document['notificationType']
        : null;
  if (rawType === null) {
    return { status: 'malformed', reason: 'neither eventType nor notificationType is a string' };
  }
  const type = rawType.slice(0, MAX_TYPE_CHARS);
  const mail = document['mail'];
  const mailMessageId =
    isRecord(mail) && typeof mail['messageId'] === 'string'
      ? mail['messageId'].slice(0, MAX_TYPE_CHARS * 2)
      : null;

  if (rawType === 'Bounce') {
    const bounce = document['bounce'];
    if (!isRecord(bounce)) return { status: 'malformed', reason: 'bounce object missing' };
    const recipients = recipientAddresses(bounce['bouncedRecipients']);
    if (recipients === null) {
      return { status: 'malformed', reason: 'bouncedRecipients is not a list of recipients' };
    }
    const reason = bounceReason(bounce['bounceType']);
    if (reason === null) return { status: 'malformed', reason: 'bounceType is not a string' };
    return {
      status: 'parsed',
      kind: 'bounce',
      type,
      mailMessageId,
      decisions: decide(recipients, reason === 'permanent_bounce' ? 'suppress' : 'ignore', reason),
    };
  }

  if (rawType === 'Complaint') {
    const complaint = document['complaint'];
    if (!isRecord(complaint)) return { status: 'malformed', reason: 'complaint object missing' };
    const recipients = recipientAddresses(complaint['complainedRecipients']);
    if (recipients === null) {
      return { status: 'malformed', reason: 'complainedRecipients is not a list of recipients' };
    }
    const notSpam = complaint['complaintFeedbackType'] === 'not-spam';
    return {
      status: 'parsed',
      kind: 'complaint',
      type,
      mailMessageId,
      decisions: notSpam
        ? decide(recipients, 'ignore', 'complaint_not_spam')
        : decide(recipients, 'suppress', 'complaint'),
    };
  }

  return { status: 'parsed', kind: 'other', type, mailMessageId, decisions: [] };
}

/** What one feedback document did — counts only, so it can go on a log line whole. */
export interface FeedbackOutcome {
  readonly kind: FeedbackKind;
  readonly type: string;
  readonly mailMessageId: string | null;
  readonly recipients: number;
  readonly suppressedAddresses: number;
  readonly ignoredAddresses: number;
  /** Subscriptions actually revoked — zero for an address we never stored. */
  readonly revokedSubscriptions: number;
  readonly reasons: Readonly<Partial<Record<FeedbackReason, number>>>;
}

/**
 * Applies a parsed document's suppressions, one address at a time. A failing `suppress`
 * propagates: the caller answers SNS with a 5xx, SNS redelivers, and the second delivery
 * finds the addresses already handled stopped (the update is conditional), so a partial
 * first attempt costs nothing.
 */
export async function applyEmailFeedback(
  feedback: Extract<ParsedFeedback, { status: 'parsed' }>,
  suppressor: EmailSuppressor,
  now: EpochMs,
): Promise<FeedbackOutcome> {
  let revokedSubscriptions = 0;
  for (const decision of feedback.decisions) {
    if (decision.action === 'suppress' && decision.address !== null) {
      revokedSubscriptions += await suppressor.suppress(decision.address, now);
    }
  }
  return { ...summarizeFeedback(feedback), revokedSubscriptions };
}

/** The log-safe summary of a parsed document, before anything was applied. */
export function summarizeFeedback(
  feedback: Extract<ParsedFeedback, { status: 'parsed' }>,
): FeedbackOutcome {
  const reasons: Partial<Record<FeedbackReason, number>> = {};
  let suppressedAddresses = 0;
  for (const decision of feedback.decisions) {
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
    if (decision.action === 'suppress') suppressedAddresses += 1;
  }
  return {
    kind: feedback.kind,
    type: feedback.type,
    mailMessageId: feedback.mailMessageId,
    recipients: feedback.decisions.length,
    suppressedAddresses,
    ignoredAddresses: feedback.decisions.length - suppressedAddresses,
    revokedSubscriptions: 0,
    reasons,
  };
}

function bounceReason(bounceType: unknown): FeedbackReason | null {
  if (typeof bounceType !== 'string') return null;
  if (bounceType === 'Permanent') return 'permanent_bounce';
  if (bounceType === 'Transient') return 'transient_bounce';
  // `Undetermined`, and any type AWS adds later: not proof the address is dead.
  return 'undetermined_bounce';
}

/** The recipients' raw addresses, or `null` when the list is not a list of recipients. */
function recipientAddresses(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECIPIENTS) return null;
  const addresses: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['emailAddress'] !== 'string') return null;
    addresses.push(entry['emailAddress']);
  }
  return addresses;
}

/** One decision per distinct normalized address; unparseable ones are kept, as such. */
function decide(
  raw: readonly string[],
  action: RecipientDecision['action'],
  reason: FeedbackReason,
): readonly RecipientDecision[] {
  const seen = new Set<string>();
  const decisions: RecipientDecision[] = [];
  for (const entry of raw) {
    const address = normalizeFeedbackAddress(entry);
    if (address === null) {
      decisions.push({ action: 'ignore', reason: 'unparseable_address', address: null });
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    decisions.push({ action, reason, address });
  }
  return decisions;
}

/**
 * The stored form of a reported address: one `Name <addr>` wrapper removed, then exactly
 * what `normalizeEmail` does to an address at opt-in, so the two can be compared with `=`.
 */
export function normalizeFeedbackAddress(raw: string): string | null {
  const wrapped = /<([^<>]*)>\s*$/u.exec(raw);
  return normalizeEmail(wrapped?.[1] ?? raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
