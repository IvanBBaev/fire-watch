/**
 * The security headers every answer of the API origin carries (TASKS R5-SEC-2; review 28 E-2).
 *
 * The API serves JSON, SSE and overlay documents to the app, which lives on its own origin
 * behind the edge, and to nothing else. So its policy is the strictest a response can
 * carry: a document a browser might build from one of its answers may load nothing
 * (`default-src 'none'`) and may be framed by no one (`frame-ancestors 'none'`). HSTS and
 * the referrer policy are the web origin's (`web/src/edge/security-headers.ts`), so a
 * reader's browser sees one posture from both hosts; `nosniff` was already set by hand on
 * the five routes that serve something other than JSON, and now reaches every answer.
 *
 * Wired in `createHealthServer` as an `onSend` hook — every route, the not-found handler
 * and the error handler pass through it — and called by hand from `frameworkErrors`, the
 * one path no hook reaches. The metrics server is a bearer-protected scrape target, not a
 * browser surface, and stays out.
 */

import type { FastifyReply } from 'fastify';

export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
};

/** Sets every API security header on the reply, over whatever a route set before. */
export function applySecurityHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) reply.header(name, value);
}
