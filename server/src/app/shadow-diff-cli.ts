#!/usr/bin/env node
/**
 * The nightly shadow diff — live vs one candidate, one day (TASKS H8; 06 §5.7; GATES L-1).
 *
 *   node server/dist/app/shadow-diff-cli.js --candidate=clustering_v2 --day=2026-08-20
 *   node server/dist/app/shadow-diff-cli.js --candidate=clustering_v2 --day=2026-08-20 \
 *     --explanations=/srv/fire-watch/shadow/clustering_v2.json
 *
 * Reads both sides of the window (`fire_events`/`alert_outbox` and
 * `events_shadow`/`alerts_shadow`), classifies every difference, attaches the reviewer's
 * explanations, and prints the canonical report as one line on stdout — the bytes a
 * reviewer signs, identical on a re-run over the same rows. Read-only: it writes nothing,
 * so running it twice, or against production, is safe.
 *
 * Exit codes: 0 — every diff is explained (`all_explained`, which is what L-1 promotes
 * on); 1 — at least one diff is unexplained, or the run failed on data; 2 —
 * misconfiguration. The starting line goes to stderr so piped output stays
 * machine-readable.
 */

import { readFile } from 'node:fs/promises';

import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgShadowDiffReader } from '../adapters/db/pg-shadow-diff-reader.js';
import { isoFromEpochMs } from '../core/ports/clock.js';
import { parseExplanations, type DiffExplanation } from '../core/shadow/explanations.js';
import { renderShadowDiffReport, shadowDiff } from '../core/shadow/shadow-diff.js';
import { SHADOW_DIFF } from '../core/shadow/shadow-diff-params.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';
import {
  describeShadowDiffConfig,
  loadShadowDiffConfig,
  parseShadowDiffArgs,
} from './shadow-diff-config.js';

const EXIT_MISCONFIGURED = 2;

const log = processLog();

async function main(): Promise<number> {
  const options = parseShadowDiffArgs(process.argv.slice(2));
  const config = loadShadowDiffConfig(process.env);
  // Before the pool: an unreadable or malformed explanations file is the operator's to
  // fix, and it should not cost a database round trip to find out.
  const explanations = await loadExplanations(options.explanationsPath);

  log.note({
    starting: {
      ...describeShadowDiffConfig(config),
      candidate: options.candidateVersion,
      window_from: isoFromEpochMs(options.window.fromMs),
      window_to: isoFromEpochMs(options.window.toMs),
      explanations: String(explanations.length),
      diff_config: SHADOW_DIFF.version,
      diff_config_digest: SHADOW_DIFF.digest,
    },
  });

  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: 'fire-watch-shadow-diff',
  });

  try {
    const sides = await createPgShadowDiffReader(pool).loadWindow({
      candidateVersion: options.candidateVersion,
      window: options.window,
    });
    const report = shadowDiff({
      candidateVersion: options.candidateVersion,
      window: options.window,
      live: sides.live,
      shadow: sides.shadow,
      explanations,
    });
    log.line(renderShadowDiffReport(report));
    return report.verdict === 'all_explained' ? 0 : 1;
  } finally {
    await pool.end();
  }
}

async function loadExplanations(path: string | null): Promise<readonly DiffExplanation[]> {
  if (path === null) return [];
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `--explanations could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseExplanations(document);
  } catch (error) {
    throw new ConfigError(
      `--explanations is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
