/**
 * The SES feedback hook's adapters (`adapters/http/ses-feedback-route.ts`), mounted on
 * the API server when `FIRE_WATCH_SES_FEEDBACK_TOPIC_ARN` is set and not at all
 * otherwise — no pool, no verifier, no route, so an unconfigured deployment answers the
 * path `404` and holds no connection for it.
 *
 * Independent of `FIRE_WATCH_AUTH_ENABLED` and of the alert channels: both the sign-in
 * mailer and the email channel send through SES, and feedback for either reaches the same
 * topic. Feedback for an address with no subscription (sign-in mail, typically) revokes
 * nothing and is still acknowledged.
 *
 * Its own pool of one connection: a suppression is a single short `UPDATE`, SNS delivers
 * at human rates, and sharing the probe or snapshot pool would let a feedback burst sit in
 * front of a `/readyz`. The statement timeout is short for the same reason the probes'
 * is — a stuck `UPDATE` should become a `500` that SNS retries, not a held connection.
 *
 * The log events go to stderr through `ProcessLog.note` under `ses_feedback`; they carry
 * ids, types and counts only (`SesFeedbackEvent`).
 */

import type { FastifyInstance } from 'fastify';

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgEmailSuppression } from '../adapters/db/pg-email-suppression.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import type { ProblemObserver } from '../adapters/http/problem.js';
import { registerSesFeedbackRoute } from '../adapters/http/ses-feedback-route.js';
import {
  createSnsVerifier,
  type FetchLike,
  type SnsVerifier,
} from '../adapters/mail/sns-verifier.js';
import type { Clock } from '../core/ports/clock.js';
import type { EmailSuppressor } from '../core/ports/email-suppressor.js';
import type { ServerConfig } from './config.js';
import type { ProcessLog } from './logging.js';

export const SES_FEEDBACK_POOL_MAX = 1;
export const SES_FEEDBACK_STATEMENT_TIMEOUT_MS = 5_000;
export const SES_FEEDBACK_CONNECTION_TIMEOUT_MS = 2_000;

export interface SesFeedbackWiring {
  /** Whether the route was registered (a topic was configured). */
  readonly enabled: boolean;
  readonly close: () => Promise<void>;
}

export interface SesFeedbackWiringDeps {
  readonly log: Pick<ProcessLog, 'note'>;
  readonly onProblem?: ProblemObserver | undefined;
  /** Tests only: the certificate and confirmation fetches. */
  readonly fetch?: FetchLike;
  /** Tests only. */
  readonly clock?: Clock;
  /** Tests only: replaces the pool and the pg suppression together. */
  readonly suppressor?: EmailSuppressor;
  /** Tests only: replaces the signature check. */
  readonly verifier?: SnsVerifier;
}

export function wireSesFeedbackRoute(
  app: FastifyInstance,
  config: Pick<
    ServerConfig,
    'sesFeedbackTopicArn' | 'databaseUrl' | 'databaseRole' | 'applicationName'
  >,
  deps: SesFeedbackWiringDeps,
): SesFeedbackWiring {
  const topicArn = config.sesFeedbackTopicArn;
  if (topicArn === null) return { enabled: false, close: () => Promise.resolve() };

  let close = (): Promise<void> => Promise.resolve();
  let suppressor = deps.suppressor;
  if (suppressor === undefined) {
    const pool = createPgPool({
      databaseUrl: config.databaseUrl,
      role: config.databaseRole,
      applicationName: `${config.applicationName}-ses-feedback`,
      max: SES_FEEDBACK_POOL_MAX,
      statementTimeoutMs: SES_FEEDBACK_STATEMENT_TIMEOUT_MS,
      connectionTimeoutMs: SES_FEEDBACK_CONNECTION_TIMEOUT_MS,
    });
    suppressor = createPgEmailSuppression(pool);
    close = () => pool.end();
  }

  registerSesFeedbackRoute(app, {
    verifier:
      deps.verifier ?? createSnsVerifier({ topicArn, fetch: deps.fetch ?? globalThis.fetch }),
    suppressor,
    clock: deps.clock ?? systemClock,
    onProblem: deps.onProblem,
    observe: (event) => {
      deps.log.note({ ses_feedback: event });
    },
  });
  return { enabled: true, close };
}
