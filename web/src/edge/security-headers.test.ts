/**
 * TASKS R5-SEC-2 — the one web security policy: `web/public/_headers` and this module hold
 * the same headers, the policy admits every third-party host the shipped config names, and
 * the helpers that apply or extend it change nothing else.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import {
  admitOrigins,
  admitOriginsInHeadersFile,
  deployAdmittedOrigins,
  parseHeadersFile,
  WEB_CONTENT_SECURITY_POLICY,
  WEB_SECURITY_HEADERS,
  withSecurityHeaders,
} from './security-headers.js';

const HEADERS_FILE = readFileSync(
  fileURLToPath(new URL('../../public/_headers', import.meta.url)),
  'utf8',
);

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `) || part === name);
  if (found === undefined) throw new Error(`no ${name} directive in: ${policy}`);
  return found.split(/\s+/u).slice(1);
}

describe('web/public/_headers', () => {
  it('is one rule for every path, equal to WEB_SECURITY_HEADERS', () => {
    // Pages reads the file; the Functions and the e2e origin read the constant. A header
    // changed in one place and not the other would ship two policies from one origin.
    expect(parseHeadersFile(HEADERS_FILE)).toEqual([{ path: '/*', headers: WEB_SECURITY_HEADERS }]);
  });

  it('parses comments, blank lines and indentation the way Pages does', () => {
    const rules = parseHeadersFile(
      ['# a comment', '', '/*', '  X-A: 1', '\tX-B: a: b', '/assets/*', '  Cache-Control: x'].join(
        '\n',
      ),
    );
    expect(rules).toEqual([
      { path: '/*', headers: { 'x-a': '1', 'x-b': 'a: b' } },
      { path: '/assets/*', headers: { 'cache-control': 'x' } },
    ]);
    expect(() => parseHeadersFile('  X-A: 1')).toThrow(/before any path/u);
  });
});

describe('WEB_CONTENT_SECURITY_POLICY', () => {
  it('admits every third-party host the shipped config fetches from, and nothing inline', () => {
    const connect = directive(WEB_CONTENT_SECURITY_POLICY, 'connect-src');
    const img = directive(WEB_CONTENT_SECURITY_POLICY, 'img-src');
    for (const url of Object.values(DEFAULT_CONFIG.basemapStyleUrl)) {
      expect(connect).toContain(new URL(url).origin);
      expect(img).toContain(new URL(url).origin);
    }
    expect(img).toContain('blob:');
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|\*/u);
    expect(directive(WEB_CONTENT_SECURITY_POLICY, 'default-src')).toEqual(["'self'"]);
    expect(directive(WEB_CONTENT_SECURITY_POLICY, 'worker-src')).toEqual(["'self'"]);
    expect(directive(WEB_CONTENT_SECURITY_POLICY, 'frame-ancestors')).toEqual(["'self'"]);
    expect(directive(WEB_CONTENT_SECURITY_POLICY, 'object-src')).toEqual(["'none'"]);
  });

  it('carries the rest of the review 28 E-2 set', () => {
    expect(WEB_SECURITY_HEADERS['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(WEB_SECURITY_HEADERS['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(WEB_SECURITY_HEADERS['permissions-policy']).toBe('geolocation=(self)');
    expect(WEB_SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
  });
});

describe('admitOrigins', () => {
  it('appends the origins to connect-src and img-src and leaves every other directive alone', () => {
    const admitted = admitOrigins(WEB_SECURITY_HEADERS, ['https://t2.fire-watch.example']);
    const policy = admitted['content-security-policy'] ?? '';
    expect(directive(policy, 'connect-src').at(-1)).toBe('https://t2.fire-watch.example');
    expect(directive(policy, 'img-src').at(-1)).toBe('https://t2.fire-watch.example');
    expect(directive(policy, 'default-src')).toEqual(["'self'"]);
    expect(directive(policy, 'worker-src')).toEqual(["'self'"]);
    expect(policy.split(';')).toHaveLength(WEB_CONTENT_SECURITY_POLICY.split(';').length);
    const { 'content-security-policy': _csp, ...rest } = admitted;
    const { 'content-security-policy': _base, ...baseRest } = WEB_SECURITY_HEADERS;
    expect(rest).toEqual(baseRest);
    expect(admitOrigins(WEB_SECURITY_HEADERS, [])).toBe(WEB_SECURITY_HEADERS);
  });
});

describe('deployAdmittedOrigins (R5-SRE-5)', () => {
  it('admits nothing when the T2 mirror is not configured', () => {
    expect(deployAdmittedOrigins(undefined)).toEqual([]);
    expect(deployAdmittedOrigins('  ')).toEqual([]);
  });

  it('admits the origin of the mirror URL, not its path', () => {
    expect(deployAdmittedOrigins(' https://static.example:8443/fw/snapshot.json ')).toEqual([
      'https://static.example:8443',
    ]);
  });

  it('refuses a relative or non-https URL rather than ship a policy that blocks the failover', () => {
    expect(() => deployAdmittedOrigins('/snapshot.json')).toThrow(/not an absolute URL/);
    expect(() => deployAdmittedOrigins('http://static.example/snapshot.json')).toThrow(
      /must be https/,
    );
  });
});

describe('admitOriginsInHeadersFile (R5-SRE-5)', () => {
  it('admits the origins in the shipped file exactly as admitOrigins does, nothing else changed', () => {
    const origin = 'https://static.example';
    const rewritten = admitOriginsInHeadersFile(HEADERS_FILE, [origin]);
    const [rule] = parseHeadersFile(rewritten);
    expect(rule?.headers).toEqual(admitOrigins(WEB_SECURITY_HEADERS, [origin]));
    const changed = rewritten.split('\n').filter((line, i) => line !== HEADERS_FILE.split('\n')[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatch(/^\s+Content-Security-Policy: /iu);
  });

  it('returns the file untouched when there is nothing to admit', () => {
    expect(admitOriginsInHeadersFile(HEADERS_FILE, [])).toBe(HEADERS_FILE);
  });
});

describe('withSecurityHeaders', () => {
  it('keeps status, body and other headers and writes the policy over whatever was there', async () => {
    const upstream = new Response('<html></html>', {
      status: 404,
      statusText: 'Not Found',
      headers: {
        'content-type': 'text/html',
        'cache-control': 'public, max-age=60',
        'x-content-type-options': 'sniff-away',
      },
    });
    const response = withSecurityHeaders(upstream);
    expect(response.status).toBe(404);
    expect(response.statusText).toBe('Not Found');
    expect(await response.text()).toBe('<html></html>');
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    for (const [name, value] of Object.entries(WEB_SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});
