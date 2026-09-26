/**
 * `pnpm run status <command>` — the J5 tools (see `infra/status/README.md`).
 *
 * Exit codes: 0 done / all checks pass, 1 a check failed (or `--fail-on-outage` and the
 * headline is an outage), 2 usage or input error.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { wallClockMs } from './adapters/clock.js';
import { resolveAnswers } from './adapters/dns-lookup.js';
import { probeAll, readPrevious } from './adapters/http-probe.js';
import {
  parseCommand,
  UsageError,
  USAGE,
  type DefensiveDomainsCommand,
  type EmailAuthCommand,
  type ProbeCommand,
} from './cli-options.js';
import { generateCandidates, PRIORITIES } from './core/defensive-domains.js';
import { evaluateEmailAuth, requiredLookups } from './core/email-auth.js';
import { parseFreshnessBody } from './core/freshness-body.js';
import { parseNotices, visibleNotices } from './core/notices.js';
import { renderPage } from './core/render-html.js';
import { evaluateStatus, parsePreviousModel } from './core/status-model.js';

/** File names of the published site. `index.html` is Bulgarian, the product's default. */
export const SITE_FILES = { bg: 'index.html', en: 'en.html', model: 'status.json' } as const;

async function runProbe(command: ProbeCommand): Promise<number> {
  const noticesResult = parseNotices(
    JSON.parse(await readFile(command.notices, 'utf8')) as unknown,
  );
  if (!noticesResult.ok) {
    process.stderr.write(
      `notices: ${command.notices} is invalid:\n  ${noticesResult.errors.join('\n  ')}\n`,
    );
    return 2;
  }
  const outcome = await probeAll(command, fetch, command.timeoutMs);
  let previous = null;
  if (command.previous !== null) {
    const read = await readPrevious(
      command.previous,
      (p) => readFile(p, 'utf8'),
      fetch,
      command.timeoutMs,
    );
    if (read.diagnostic !== null)
      process.stderr.write(`${read.diagnostic} (treated as a first run)\n`);
    previous = parsePreviousModel(read.value);
  }
  const nowMs = command.nowMs ?? wallClockMs();
  const freshness = outcome.results.freshness;
  const model = evaluateStatus({
    results: outcome.results,
    parsedFreshness: freshness.kind === 'response' ? parseFreshnessBody(freshness.body) : null,
    nowMs,
    previous,
  });
  const notices = visibleNotices(noticesResult.notices, nowMs);
  const common = {
    model,
    notices,
    staleAfterMinutes: command.staleAfterMinutes,
    refreshSeconds: command.refreshSeconds,
    announceChannel: command.announce,
  };
  await mkdir(command.out, { recursive: true });
  await Promise.all([
    writeFile(
      join(command.out, SITE_FILES.bg),
      renderPage({ ...common, locale: 'bg', otherLocaleHref: SITE_FILES.en }),
    ),
    writeFile(
      join(command.out, SITE_FILES.en),
      renderPage({ ...common, locale: 'en', otherLocaleHref: SITE_FILES.bg }),
    ),
    writeFile(join(command.out, SITE_FILES.model), `${JSON.stringify(model, null, 2)}\n`),
    // Pages would otherwise run the directory through Jekyll.
    writeFile(join(command.out, '.nojekyll'), ''),
  ]);
  for (const line of outcome.diagnostics) process.stderr.write(`probe: ${line}\n`);
  process.stdout.write(`status: overall ${model.overall} at ${model.generatedAt}\n`);
  for (const c of model.components) {
    process.stdout.write(
      `  ${c.id.padEnd(15)} ${c.level.padEnd(11)} ${c.reason}${c.unconfirmed ? ' (unconfirmed)' : ''}\n`,
    );
  }
  process.stdout.write(`  wrote ${command.out}/{${Object.values(SITE_FILES).join(',')}}\n`);
  return command.failOnOutage && model.overall === 'outage' ? 1 : 0;
}

async function runEmailAuth(command: EmailAuthCommand): Promise<number> {
  const options = {
    domain: command.domain,
    role: command.role,
    dkim: command.dkim,
    mailFromDomain: command.mailFromDomain,
    orgDomain: command.orgDomain,
    strictAlignment: command.strictAlignment,
  };
  const answers = await resolveAnswers(requiredLookups(options), {
    servers: command.resolvers,
    timeoutMs: 5000,
  });
  const report = evaluateEmailAuth(options, answers);
  if (command.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `email-auth ${report.domain} (${report.role}): ${report.pass ? 'PASS' : 'FAIL'}\n`,
    );
    process.stdout.write(
      `  SPF   ${report.records.spf.name}: ${report.records.spf.record ?? '-'}\n`,
    );
    process.stdout.write(
      `  DMARC ${report.records.dmarc.name}: ${report.records.dmarc.record ?? '-'}\n`,
    );
    for (const d of report.records.dkim)
      process.stdout.write(`  DKIM  ${d.name}: ${d.record === null ? '-' : 'present'}\n`);
    for (const f of report.findings)
      process.stdout.write(`  [${f.severity}] ${f.code}: ${f.message}\n`);
  }
  return report.pass ? 0 : 1;
}

function runDefensive(command: DefensiveDomainsCommand): number {
  const cutoff = PRIORITIES.indexOf(command.priority);
  const candidates = generateCandidates({ name: command.name, tlds: command.tlds }).filter(
    (c) => PRIORITIES.indexOf(c.priority) <= cutoff,
  );
  if (command.json) {
    process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
    return 0;
  }
  for (const c of candidates) {
    const shown = c.display === c.domain ? c.domain : `${c.domain}  (${c.display})`;
    process.stdout.write(`${c.priority.padEnd(9)} ${c.kind.padEnd(16)} ${shown}\n`);
  }
  process.stdout.write(
    `${String(candidates.length)} candidates (nothing registered or resolved)\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  let command;
  try {
    command = parseCommand(process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`status: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  switch (command.command) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case 'probe':
      return runProbe(command);
    case 'email-auth':
      return runEmailAuth(command);
    case 'defensive-domains':
      try {
        return runDefensive(command);
      } catch (error) {
        if (error instanceof RangeError) {
          process.stderr.write(`status: ${error.message}\n`);
          return 2;
        }
        throw error;
      }
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`status: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
