#!/usr/bin/env node
/**
 * `pnpm curation-rehearsal` — the scripted curated_correction rehearsal (TASKS L15;
 * GATES.md §3 L-15) over the in-memory incident-log store. It prints each step and exits 0
 * when every step behaved as the editorial standard says, 1 otherwise. The same script runs
 * against Postgres in the staff-plane integration test. Nothing here touches a database,
 * the network or any public surface.
 */

import { randomUUID } from 'node:crypto';

import { systemClock } from '../adapters/clock/system-clock.js';
import { createMemoryIncidentLogStore } from '../adapters/staff/memory-incident-log-store.js';
import { rehearsalLines, runCurationRehearsal } from '../core/staff/curation-rehearsal.js';

const log = createMemoryIncidentLogStore();
const report = await runCurationRehearsal(
  { log, newId: randomUUID },
  {
    curator: { staffId: 'rehearsal-curator', roles: ['editor'], secondFactorVerified: true },
    reviewer: { staffId: 'rehearsal-reviewer', roles: ['editor'], secondFactorVerified: true },
    startAt: systemClock.now(),
  },
);
for (const line of rehearsalLines(report)) process.stdout.write(`${line}\n`);
process.stdout.write('\nAudit trail:\n');
for (const row of log.audit()) {
  process.stdout.write(
    `  ${row.atIso}  ${row.actorId}  ${row.action}  v${String(row.version)}  ${row.status}\n`,
  );
}
process.exitCode = report.passed ? 0 : 1;
