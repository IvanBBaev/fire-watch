/**
 * The SES bounce and complaint hook (04-sre §5 "deliverability hygiene"; the gap TASKS H5
 * left open): `POST /api/v1/hooks/ses-feedback`, where Amazon SNS delivers what SES
 * publishes to the feedback topic.
 *
 * **Registered only with a topic.** `app/ses-feedback-wiring.ts` mounts this when
 * `FIRE_WATCH_SES_FEEDBACK_TOPIC_ARN` is set; without it the path is a plain `404`, like
 * any route that does not exist. The topic is what makes a validly signed message *ours*
 * (`sns-verifier.ts`), so there is no armed state without one.
 *
 * **What SNS sends.** A JSON envelope with `Content-Type: text/plain; charset=UTF-8`, so
 * Fastify's built-in text parser hands the route a string; a client that sends
 * `application/json` gets the same treatment from the JSON parser. Both go to the verifier,
 * which parses and checks the envelope itself. The body can be up to SNS's 256 KB message
 * plus its envelope, so this route carries its own `bodyLimit` — the probe server's global
 * one is a kilobyte.
 *
 * **Status codes are SNS's retry policy.** SNS retries an HTTP delivery that fails with a
 * 5xx (or does not answer) and gives up on the rest, so:
 *
 *   * a message that fails verification is `401 webhook_unauthenticated` — never retried,
 *     and nothing about *why* is in the body (the reason is a log line); an envelope that
 *     is not SNS's shape at all is `400 request_refused`;
 *   * a certificate we could not fetch is `500`: the message may be genuine, and a retry
 *     costs SNS nothing;
 *   * `SubscriptionConfirmation` is confirmed (a GET of its `SubscribeURL`) and answered
 *     `200`; a confirmation GET that fails is `500`, so SNS sends the confirmation again;
 *   * `UnsubscribeConfirmation` is acknowledged `200` and nothing else;
 *   * a `Notification` is parsed (`core/alerts/email-feedback.ts`) and its suppressions
 *     applied, then `200`. A feedback document we cannot read is still `200` — retrying
 *     an unreadable document produces the same document — and a log line. A database
 *     failure is `500`, which SNS retries; the suppression is idempotent, so a retry after
 *     a partial first attempt is harmless.
 *
 * **Rate limiting.** The probe server's per-IP limiter does not apply here (see
 * `health-server.ts`): every SNS delivery for a region comes from a small set of AWS
 * addresses, a 429 is a dropped bounce, and the cost of a forged request is bounded by the
 * signature check, which is a local RSA verify once the certificate is cached.
 *
 * **Logging.** One structured event per request through `observe` — the SNS message id,
 * the SES message id, the type and the counts — and never an address: the outcome type
 * carries none ({@link FeedbackOutcome}).
 */

import type { FastifyInstance } from 'fastify';

import type {
  SnsRejection,
  SnsVerifier,
  SubscriptionConfirmationResult,
} from '../mail/sns-verifier.js';
import {
  applyEmailFeedback,
  parseSesFeedback,
  type FeedbackOutcome,
} from '../../core/alerts/email-feedback.js';
import type { Clock } from '../../core/ports/clock.js';
import type { EmailSuppressor } from '../../core/ports/email-suppressor.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';

export const SES_FEEDBACK_PATH = '/api/v1/hooks/ses-feedback';

/** SNS caps a message at 256 KB; the envelope (signature, URLs, ids) adds a few more. */
export const SES_FEEDBACK_BODY_LIMIT = 512 * 1024;

/** One per request, safe to log whole: ids, types and counts, never an address. */
export type SesFeedbackEvent =
  | { readonly outcome: 'refused'; readonly reason: SnsRejection }
  | {
      readonly outcome: 'subscription_confirmation';
      readonly snsMessageId: string;
      readonly result: SubscriptionConfirmationResult;
    }
  | { readonly outcome: 'unsubscribe_confirmation'; readonly snsMessageId: string }
  | {
      readonly outcome: 'unreadable_feedback';
      readonly snsMessageId: string;
      readonly reason: string;
    }
  | ({ readonly outcome: 'applied'; readonly snsMessageId: string } & FeedbackOutcome);

export interface SesFeedbackRouteDeps {
  readonly verifier: SnsVerifier;
  readonly suppressor: EmailSuppressor;
  readonly clock: Clock;
  readonly observe?: ((event: SesFeedbackEvent) => void) | undefined;
  readonly onProblem?: ProblemObserver | undefined;
}

const NOT_FROM_SNS: CodedProblemSpec = {
  status: 401,
  title: 'Not authenticated',
  detail: 'This route only accepts signed Amazon SNS messages for its topic.',
  code: 'webhook_unauthenticated',
};

const NOT_AN_SNS_MESSAGE: CodedProblemSpec = {
  status: 400,
  title: 'Request refused',
  detail: 'The request could not be processed as sent.',
  code: 'request_refused',
};

const TRY_AGAIN: CodedProblemSpec = {
  status: 500,
  title: 'Internal error',
  detail: 'The request could not be completed.',
  code: 'internal_error',
};

/** Every refusal this module writes itself, for the code-coverage test. */
export const SES_FEEDBACK_PROBLEMS: readonly CodedProblemSpec[] = [
  NOT_FROM_SNS,
  NOT_AN_SNS_MESSAGE,
  TRY_AGAIN,
];

/** Not SNS's shape at all: a client fault, not an authentication one. */
const SHAPE_REJECTIONS: ReadonlySet<SnsRejection> = new Set([
  'malformed',
  'unsupported_type',
  'unsupported_signature_version',
]);

export function registerSesFeedbackRoute(app: FastifyInstance, deps: SesFeedbackRouteDeps): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.post(
      SES_FEEDBACK_PATH,
      { bodyLimit: SES_FEEDBACK_BODY_LIMIT },
      async (request, reply) => {
        const now = deps.clock.now();
        const verified = await deps.verifier.verify(request.body, now);
        if (!verified.ok) {
          deps.observe?.({ outcome: 'refused', reason: verified.reason });
          if (verified.reason === 'cert_unavailable') throw new ProblemError(TRY_AGAIN);
          throw new ProblemError(
            SHAPE_REJECTIONS.has(verified.reason) ? NOT_AN_SNS_MESSAGE : NOT_FROM_SNS,
          );
        }
        const envelope = verified.envelope;
        const snsMessageId = envelope.messageId.slice(0, 80);

        if (envelope.type === 'SubscriptionConfirmation') {
          const result = await deps.verifier.confirmSubscription(envelope);
          deps.observe?.({ outcome: 'subscription_confirmation', snsMessageId, result });
          if (result === 'failed') throw new ProblemError(TRY_AGAIN);
          if (result === 'bad_subscribe_url') throw new ProblemError(NOT_FROM_SNS);
          return reply.code(200).send({});
        }

        if (envelope.type === 'UnsubscribeConfirmation') {
          deps.observe?.({ outcome: 'unsubscribe_confirmation', snsMessageId });
          return reply.code(200).send({});
        }

        const feedback = parseSesFeedback(envelope.message);
        if (feedback.status === 'malformed') {
          deps.observe?.({ outcome: 'unreadable_feedback', snsMessageId, reason: feedback.reason });
          return reply.code(200).send({});
        }
        const outcome = await applyEmailFeedback(feedback, deps.suppressor, now);
        deps.observe?.({ outcome: 'applied', snsMessageId, ...outcome });
        return reply.code(200).send({});
      },
    );
    done();
  });
}
