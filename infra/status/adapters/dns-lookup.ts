/**
 * Resolves the names `core/email-auth.ts` asks for, via `node:dns/promises`.
 *
 * The one distinction that matters is kept: NXDOMAIN / NODATA is an *answer* ("there is no
 * DMARC record" — a failure of the domain), while SERVFAIL, a timeout or a refused
 * connection is *no answer* ("we could not find out" — a failure of the check). Collapsing
 * the two would turn a flaky resolver into a false "your DMARC is missing", or worse, a
 * missing record into a shrug.
 */

import { Resolver } from 'node:dns/promises';

import type { DnsAnswers, MxLookup, TxtLookup } from '../core/email-auth.js';

const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA']);

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}

export interface DnsLookupOptions {
  /** Resolver IPs to use instead of the system's, e.g. `['1.1.1.1']`. */
  readonly servers: readonly string[];
  readonly timeoutMs: number;
}

export async function resolveAnswers(
  names: { readonly txt: readonly string[]; readonly mx: readonly string[] },
  options: DnsLookupOptions,
): Promise<DnsAnswers> {
  const resolver = new Resolver({ timeout: options.timeoutMs, tries: 2 });
  if (options.servers.length > 0) resolver.setServers([...options.servers]);

  const txt = new Map<string, TxtLookup>();
  const mx = new Map<string, MxLookup>();
  await Promise.all([
    ...names.txt.map(async (name) => {
      try {
        txt.set(name, { kind: 'records', records: await resolver.resolveTxt(name) });
      } catch (error) {
        const code = codeOf(error);
        txt.set(name, ABSENT_CODES.has(code) ? { kind: 'absent' } : { kind: 'error', code });
      }
    }),
    ...names.mx.map(async (name) => {
      try {
        mx.set(name, { kind: 'records', records: await resolver.resolveMx(name) });
      } catch (error) {
        const code = codeOf(error);
        mx.set(name, ABSENT_CODES.has(code) ? { kind: 'absent' } : { kind: 'error', code });
      }
    }),
  ]);
  return { txt, mx };
}
