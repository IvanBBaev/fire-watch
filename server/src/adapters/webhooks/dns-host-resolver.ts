/**
 * The {@link HostResolver} the webhook SSRF guard checks before every send (TASKS V2-G2):
 * every A and AAAA address the operating system's resolver returns for the host, so one
 * private answer among public ones refuses the send.
 *
 * Tests never construct this; they pass a stub resolver, so no test resolves a name.
 */

import { lookup } from 'node:dns/promises';

import type { HostResolver } from '../../core/ports/webhook-store.js';

export function createDnsHostResolver(): HostResolver {
  return {
    async resolve(host) {
      const answers = await lookup(host, { all: true, verbatim: true });
      if (answers.length === 0) throw new Error('the host resolved to no address');
      return answers.map((answer) => answer.address);
    },
  };
}
