/**
 * Renders a drill record as the Markdown file committed under `docs/drills/records/`
 * (TASKS I7, J2; OPERATIONS §6.3 rule 3). The layout follows
 * `docs/drills/record-template.md`; the sections the tool cannot know (whether secrets
 * came back, which runbook steps were wrong) are left as operator notes to fill in before
 * the record is committed.
 *
 * Pure and deterministic: the same record renders the same bytes.
 */

import { drillVerdict, type DrillRecord, type DrillStep } from './drill-record.js';

const KIND_TITLE: Readonly<Record<DrillRecord['kind'], string>> = {
  erasure: 'Erasure drill (TASKS I7)',
  restore: 'Backup/restore + RTO drill (TASKS J2)',
};

export function renderDrillRecord(record: DrillRecord): string {
  const verdict = drillVerdict(record);
  const lines: string[] = [];
  lines.push(`# ${KIND_TITLE[record.kind]} — ${record.startedAt}`, '');
  lines.push(`**Verdict: ${verdict.toUpperCase()}**`, '');
  lines.push('| | |', '|---|---|');
  lines.push(row(['Environment', record.environment]));
  lines.push(row(['Started', record.startedAt]));
  lines.push(row(['Finished', record.finishedAt]));
  for (const [key, value] of sorted(record.target)) lines.push(row([`Target: ${key}`, value]));
  lines.push('');

  if (Object.keys(record.facts).length > 0) {
    lines.push('## Facts', '', '| Fact | Value |', '|---|---|');
    for (const [key, value] of sorted(record.facts)) lines.push(row([key, value]));
    lines.push('');
  }

  lines.push('## Steps', '', '| Step | Mode | RTO path | Status | Duration | Detail |');
  lines.push('|---|---|---|---|---|---|');
  for (const step of record.steps) {
    lines.push(
      row([
        `${step.id} — ${step.title}`,
        step.mode,
        step.onRtoPath ? 'yes' : 'no',
        step.status,
        duration(step),
        step.detail,
      ]),
    );
  }
  lines.push('');

  if (record.rto !== null) {
    const rto = record.rto;
    lines.push('## Recovery time', '');
    lines.push(
      `- Status: **${rto.status}** (target ${String(rto.targetMinMinutes)}–${String(rto.targetMaxMinutes)} min; ${rto.spec})`,
    );
    lines.push(
      `- Measured: ${String(rto.measuredMinutes)} min${rto.missing.length > 0 ? ' — a lower bound: steps missing' : ''}`,
    );
    if (rto.missing.length > 0) lines.push(`- Not performed: ${rto.missing.join(', ')}`);
    if (rto.failed.length > 0) lines.push(`- Failed: ${rto.failed.join(', ')}`);
    if (rto.status === 'exceeded') {
      lines.push(
        '- Over the target: the gap becomes a freeze-priority work item (OPERATIONS §6.3 rule 4).',
      );
    }
    lines.push('');
  }

  lines.push('## Checks', '', '| Check | Status | Detail | Spec |', '|---|---|---|---|');
  for (const item of record.checks) {
    lines.push(row([`${item.id} — ${item.title}`, item.status, item.detail, item.spec]));
  }
  lines.push('');

  lines.push('## Findings', '');
  if (record.findings.length === 0) lines.push('None recorded by the tool.');
  else for (const finding of record.findings) lines.push(`- ${finding}`);
  lines.push('');

  if (record.openItems.length > 0) {
    lines.push('## Open items', '');
    for (const item of record.openItems) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Operator notes', '');
  lines.push('_Fill in before committing this record._', '');
  if (record.kind === 'restore') {
    lines.push('- Secrets restored (VAPID private key, zone key, age identity): ');
  }
  lines.push('- Runbook defects found: ');
  lines.push('- Follow-up items (TASKS/RISKS): ');
  lines.push('');
  return lines.join('\n');
}

/** `2026-09-25T101500Z-restore-staging.md`: sortable, one per drill. */
export function recordFileName(record: DrillRecord): string {
  const stamp = record.startedAt.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const time = stamp.slice(8);
  const environment = record.environment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${date}${time}-${record.kind}-${environment === '' ? 'unnamed' : environment}.md`;
}

function duration(step: DrillStep): string {
  if (step.durationMs === null) return '—';
  if (step.durationMs < 60_000) return `${(step.durationMs / 1000).toFixed(1)} s`;
  return `${(step.durationMs / 60_000).toFixed(1)} min`;
}

function sorted(values: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(' | ')} |`;
}

/** A table cell: one line, pipes escaped, never empty (an empty cell reads as a gap). */
function cell(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return flat === '' ? '—' : flat;
}
