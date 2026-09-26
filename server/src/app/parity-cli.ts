#!/usr/bin/env node
/**
 * The ingestion-parity check — our NRT detections vs a FIRMS map export (TASKS C9; A23;
 * 06 §5.5).
 *
 *   node server/dist/app/parity-cli.js --day=2026-10-01 \
 *     --reference=firms:viirs:noaa20=/srv/fire-watch/parity/noaa20-2026-10-01.csv
 *   node server/dist/app/parity-cli.js --from=2026-10-01 --to=2026-10-07 \
 *     --reference=firms:viirs:snpp=/srv/.../snpp.csv \
 *     --reference=firms:viirs:noaa20=/srv/.../noaa20.csv
 *
 * Parses every reference with the same CSV parser the ingest uses (so a column FIRMS
 * renamed fails here the way it would fail there), derives each row's `detection_uid`,
 * reads our NRT rows over the same window, and prints the canonical report as one line on
 * stdout — matched / missing / extra per source, identical on a re-run over the same rows
 * and files. Read-only: it writes nothing.
 *
 * Exit codes: 0 — `parity` (no reference row is missing from ours); 1 — `deficit`, or the
 * run failed on data; 2 — misconfiguration, including an unreadable or malformed
 * reference file. The starting line goes to stderr so piped output stays
 * machine-readable.
 */

import { readFile } from 'node:fs/promises';

import { detectionUid } from '@fire-watch/contracts/node';

import { createPgParityReader } from '../adapters/db/pg-parity-reader.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { POLLING_BBOX } from '../core/config/polling-bbox.js';
import { FirmsCsvFormatError, parseFirmsCsv } from '../core/ingest/firms-csv.js';
import {
  parityCheck,
  referenceFromCsv,
  renderParityReport,
  type ParityReference,
} from '../core/ingest/parity-check.js';
import { PARITY_CHECK } from '../core/ingest/parity-params.js';
import { isoFromEpochMs } from '../core/ports/clock.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';
import {
  describeParityConfig,
  loadParityConfig,
  parseParityArgs,
  type ParityReferenceFile,
} from './parity-config.js';

const EXIT_MISCONFIGURED = 2;

const log = processLog();

async function main(): Promise<number> {
  const options = parseParityArgs(process.argv.slice(2));
  const config = loadParityConfig(process.env);
  // Before the pool: a reference file that cannot be read or parsed is the operator's to
  // fix, and it should not cost a database round trip to find out.
  const references = await Promise.all(options.references.map(loadReference));

  log.note({
    starting: {
      ...describeParityConfig(config),
      window_from: isoFromEpochMs(options.window.fromMs),
      window_to: isoFromEpochMs(options.window.toMs),
      references: references.map((r) => `${r.source}:${String(r.rows.length)}`).join(','),
      parity_config: PARITY_CHECK.version,
      parity_config_digest: PARITY_CHECK.digest,
      bbox: POLLING_BBOX.version,
    },
  });

  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: 'fire-watch-parity',
  });

  try {
    const ours = await createPgParityReader(pool).loadNrtDetections({
      sources: references.map((reference) => reference.source),
      window: options.window,
    });
    const report = parityCheck({
      window: options.window,
      references,
      ours,
      bbox: POLLING_BBOX,
      config: PARITY_CHECK,
    });
    log.line(renderParityReport(report));
    return report.verdict === 'parity' ? 0 : 1;
  } finally {
    await pool.end();
  }
}

async function loadReference(file: ParityReferenceFile): Promise<ParityReference> {
  let text: string;
  try {
    text = await readFile(file.path, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `--reference for ${file.source} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return referenceFromCsv(parseFirmsCsv(text, { source: file.source }), detectionUid);
  } catch (error) {
    if (error instanceof FirmsCsvFormatError) {
      throw new ConfigError(`--reference for ${file.source} is not a FIRMS CSV: ${error.message}`);
    }
    throw error;
  }
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
