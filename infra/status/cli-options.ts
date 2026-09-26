/**
 * Argument parsing for `pnpm run status <command>`, kept apart from `cli.ts` so it is
 * testable without a network or a file system. Flags win over environment variables,
 * which is what the GitHub workflow uses (repository variables, never secrets: every
 * value here is a public URL).
 */

import { parseArgs } from 'node:util';

import { normalizeDomain } from './core/domain-name.js';
import { DEFAULT_TLDS, PRIORITIES, type Priority } from './core/defensive-domains.js';
import { DOMAIN_ROLES, type DkimSelector, type DomainRole } from './core/email-auth.js';
import { DEFAULT_REFRESH_SECONDS, DEFAULT_STALE_AFTER_MINUTES } from './core/render-html.js';

export const USAGE = `Usage: pnpm run status <command> [options]

Commands:
  probe               Probe the public endpoints and write the static status page.
    --api-base <url>        API origin (/healthz, /api/health/freshness)  [FIRE_WATCH_STATUS_API_BASE]
    --snapshot-url <url>    Snapshot document the map reads               [FIRE_WATCH_STATUS_SNAPSHOT_URL]
    --mirror-url <url>      T2 mirror object (HEAD)                       [FIRE_WATCH_STATUS_MIRROR_URL]
    --previous <file|url>   Last published status.json (incident start times, 2-failure rule)
    --notices <file>        Founder notices (default infra/status/notices.json)
    --announce <text|url>   Second announcement channel shown on the page [FIRE_WATCH_STATUS_ANNOUNCE]
    --out <dir>             Output directory (default infra/status/dist/site)
    --now <iso>             Evaluate as of this instant (default: the wall clock)
    --stale-after <min>     Page warns about itself after this many minutes (default ${String(DEFAULT_STALE_AFTER_MINUTES)})
    --refresh <sec>         Browser auto-refresh interval (default ${String(DEFAULT_REFRESH_SECONDS)})
    --timeout <ms>          Per-request timeout (default 10000)
    --fail-on-outage        Exit 1 when the headline is an outage (default: always exit 0 once published)

  email-auth          Check SPF / DKIM / DMARC for a domain (exit 1 on any error finding).
    --domain <name>         Domain to check (the From domain)          (required)
    --role <sending|parked> default sending
    --dkim <sel[@domain]>   DKIM selector, repeatable
    --mail-from <name>      Envelope MAIL FROM domain for SPF (default: --domain)
    --org-domain <name>     Organizational domain (default: last two labels)
    --strict-alignment      Require adkim=s / aspf=s and exact alignment
    --resolver <ip>         DNS server to ask, repeatable (default: system)
    --json                  Machine-readable report

  defensive-domains   Print look-alike domain candidates (registers nothing).
    --name <label>          Second-level label, e.g. firewatch          (required)
    --tld <tld>             TLD, repeatable, primary first (default ${DEFAULT_TLDS.join(', ')})
    --priority <p>          Lowest priority to include: register | consider | monitor (default consider)
    --json                  Machine-readable list
`;

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

type Env = Readonly<Record<string, string | undefined>>;

export interface ProbeCommand {
  readonly command: 'probe';
  readonly apiBase: string | null;
  readonly snapshotUrl: string | null;
  readonly mirrorUrl: string | null;
  readonly previous: string | null;
  readonly notices: string;
  readonly announce: string | null;
  readonly out: string;
  readonly nowMs: number | null;
  readonly staleAfterMinutes: number;
  readonly refreshSeconds: number;
  readonly timeoutMs: number;
  readonly failOnOutage: boolean;
}

export interface EmailAuthCommand {
  readonly command: 'email-auth';
  readonly domain: string;
  readonly role: DomainRole;
  readonly dkim: readonly DkimSelector[];
  readonly mailFromDomain: string | null;
  readonly orgDomain: string | null;
  readonly strictAlignment: boolean;
  readonly resolvers: readonly string[];
  readonly json: boolean;
}

export interface DefensiveDomainsCommand {
  readonly command: 'defensive-domains';
  readonly name: string;
  readonly tlds: readonly string[];
  readonly priority: Priority;
  readonly json: boolean;
}

export type Command =
  ProbeCommand | EmailAuthCommand | DefensiveDomainsCommand | { readonly command: 'help' };

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}

function httpUrl(flag: string, value: string | null): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag}: not a URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`${flag}: http(s) URL required`);
  }
  return value;
}

function positiveInt(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag}: positive integer required`);
  return n;
}

function domain(flag: string, value: string | undefined): string {
  const normalized = value === undefined ? null : normalizeDomain(value);
  if (normalized === null) throw new UsageError(`${flag}: a valid domain name is required`);
  return normalized;
}

function parseProbe(args: readonly string[], env: Env): ProbeCommand {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      'api-base': { type: 'string' },
      'snapshot-url': { type: 'string' },
      'mirror-url': { type: 'string' },
      previous: { type: 'string' },
      notices: { type: 'string' },
      announce: { type: 'string' },
      out: { type: 'string' },
      now: { type: 'string' },
      'stale-after': { type: 'string' },
      refresh: { type: 'string' },
      timeout: { type: 'string' },
      'fail-on-outage': { type: 'boolean' },
    },
  });
  let nowMs: number | null = null;
  if (values.now !== undefined) {
    nowMs = Date.parse(values.now);
    if (!Number.isFinite(nowMs)) throw new UsageError('--now: ISO-8601 instant required');
  }
  const command: ProbeCommand = {
    command: 'probe',
    apiBase: httpUrl(
      '--api-base',
      nonEmpty(values['api-base'] ?? env['FIRE_WATCH_STATUS_API_BASE']),
    ),
    snapshotUrl: httpUrl(
      '--snapshot-url',
      nonEmpty(values['snapshot-url'] ?? env['FIRE_WATCH_STATUS_SNAPSHOT_URL']),
    ),
    mirrorUrl: httpUrl(
      '--mirror-url',
      nonEmpty(values['mirror-url'] ?? env['FIRE_WATCH_STATUS_MIRROR_URL']),
    ),
    previous: nonEmpty(values.previous),
    notices: values.notices ?? 'infra/status/notices.json',
    announce: nonEmpty(values.announce ?? env['FIRE_WATCH_STATUS_ANNOUNCE']),
    out: values.out ?? 'infra/status/dist/site',
    nowMs,
    staleAfterMinutes: positiveInt(
      '--stale-after',
      values['stale-after'],
      DEFAULT_STALE_AFTER_MINUTES,
    ),
    refreshSeconds: positiveInt('--refresh', values.refresh, DEFAULT_REFRESH_SECONDS),
    timeoutMs: positiveInt('--timeout', values.timeout, 10_000),
    failOnOutage: values['fail-on-outage'] === true,
  };
  if (command.apiBase === null && command.snapshotUrl === null && command.mirrorUrl === null) {
    throw new UsageError(
      'probe: configure at least one of --api-base, --snapshot-url, --mirror-url',
    );
  }
  return command;
}

function parseEmailAuth(args: readonly string[]): EmailAuthCommand {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      domain: { type: 'string' },
      role: { type: 'string' },
      dkim: { type: 'string', multiple: true },
      'mail-from': { type: 'string' },
      'org-domain': { type: 'string' },
      'strict-alignment': { type: 'boolean' },
      resolver: { type: 'string', multiple: true },
      json: { type: 'boolean' },
    },
  });
  const checked = domain('--domain', values.domain);
  const role = values.role ?? 'sending';
  if (!(DOMAIN_ROLES as readonly string[]).includes(role)) {
    throw new UsageError(`--role: one of ${DOMAIN_ROLES.join(', ')}`);
  }
  const dkim = (values.dkim ?? []).map((spec): DkimSelector => {
    const [selector = '', at] = spec.split('@');
    if (!/^[a-z0-9]([a-z0-9._-]{0,62})$/i.test(selector)) {
      throw new UsageError(`--dkim: invalid selector "${spec}"`);
    }
    return { selector, domain: at === undefined ? checked : domain('--dkim', at) };
  });
  return {
    command: 'email-auth',
    domain: checked,
    role: role as DomainRole,
    dkim,
    mailFromDomain:
      values['mail-from'] === undefined ? null : domain('--mail-from', values['mail-from']),
    orgDomain:
      values['org-domain'] === undefined ? null : domain('--org-domain', values['org-domain']),
    strictAlignment: values['strict-alignment'] === true,
    resolvers: values.resolver ?? [],
    json: values.json === true,
  };
}

function parseDefensive(args: readonly string[]): DefensiveDomainsCommand {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      name: { type: 'string' },
      tld: { type: 'string', multiple: true },
      priority: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  if (values.name === undefined || values.name.trim().length === 0) {
    throw new UsageError('--name is required');
  }
  const priority = values.priority ?? 'consider';
  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    throw new UsageError(`--priority: one of ${PRIORITIES.join(', ')}`);
  }
  return {
    command: 'defensive-domains',
    name: values.name,
    tlds: values.tld ?? [...DEFAULT_TLDS],
    priority: priority as Priority,
    json: values.json === true,
  };
}

/** Throws {@link UsageError} (exit 2) on anything it does not understand. */
export function parseCommand(argv: readonly string[], env: Env): Command {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'probe':
        return parseProbe(rest, env);
      case 'email-auth':
        return parseEmailAuth(rest);
      case 'defensive-domains':
        return parseDefensive(rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return { command: 'help' };
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // node:util parseArgs throws TypeErrors with ERR_PARSE_ARGS_* codes for bad flags.
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}
