/**
 * TASKS R5-SEC-2 — the API header set is the review 28 E-2 one and is applied whole. The
 * wiring (hook, not-found, framework-error paths) is asserted in `health-server.test.ts`.
 */

import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';

import { API_SECURITY_HEADERS, applySecurityHeaders } from './security-headers.js';

describe('API_SECURITY_HEADERS', () => {
  it('lets a browser load nothing from an API answer and frame it nowhere', () => {
    expect(API_SECURITY_HEADERS['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(API_SECURITY_HEADERS['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(API_SECURITY_HEADERS['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(API_SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    // Lower-case names: Fastify and Node normalise to them, and the tests read them so.
    for (const name of Object.keys(API_SECURITY_HEADERS)) expect(name).toBe(name.toLowerCase());
  });
});

describe('applySecurityHeaders', () => {
  it('sets every header on the reply', () => {
    const set: [string, string][] = [];
    const reply = {
      header(name: string, value: string) {
        set.push([name, value]);
        return this;
      },
    } as unknown as FastifyReply;
    applySecurityHeaders(reply);
    expect(Object.fromEntries(set)).toEqual(API_SECURITY_HEADERS);
  });
});
