/**
 * The alert rules in `infra/metrics/rules/` against the code they mirror (TASKS C5).
 *
 * A rule that names a series nobody exports never fires, and nothing says so: the
 * dashboard shows "no data" and the page that should have come never does. So every
 * `fw_*` name a rule mentions must be in the metric catalogue, and every threshold a
 * rule restates must equal the constant it was copied from.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALERT_BUDGETS } from '../core/config/alert-budgets.js';
import { FRESHNESS_BUDGETS } from '../core/config/freshness-budgets.js';
import { OUTBOX_QUEUE_PAGE_SECONDS } from '../core/monitoring/meta-alert-params.js';
import { alertDeferralPages } from '../core/observability/alert-metrics.js';
import { METRIC_CATALOG } from '../core/observability/metric-catalog.js';

const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/metrics/rules');

interface Rule {
  readonly file: string;
  readonly alert: string;
  readonly expr: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** A deliberately small reader for the rule files' own shape: one-line `expr`s. */
function readRules(): Rule[] {
  const rules: Rule[] = [];
  for (const file of readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    const lines = readFileSync(join(RULES_DIR, file), 'utf8').split('\n');
    let current: { alert: string; expr: string; labels: Record<string, string> } | null = null;
    let inLabels = false;
    for (const line of lines) {
      const alert = /^\s*- alert:\s*(\S+)\s*$/.exec(line);
      if (alert?.[1] !== undefined) {
        if (current !== null) rules.push({ file, ...current });
        current = { alert: alert[1], expr: '', labels: {} };
        inLabels = false;
        continue;
      }
      if (current === null) continue;
      const expr = /^\s*expr:\s*(.+)$/.exec(line);
      if (expr?.[1] !== undefined) {
        current.expr = expr[1].trim();
        inLabels = false;
        continue;
      }
      if (/^\s*labels:\s*$/.test(line)) {
        inLabels = true;
        continue;
      }
      if (/^\s*(annotations|for):/.test(line)) {
        inLabels = false;
        continue;
      }
      const label = /^\s{10}(\w+):\s*["']?([^"']*)["']?\s*$/.exec(line);
      if (inLabels && label?.[1] !== undefined && label[2] !== undefined) {
        current.labels[label[1]] = label[2];
      }
    }
    if (current !== null) rules.push({ file, ...current });
  }
  return rules;
}

const RULES = readRules();

function rule(alert: string): Rule {
  const found = RULES.find((r) => r.alert === alert);
  if (found === undefined) throw new Error(`no rule named ${alert}`);
  return found;
}

function threshold(alert: string): number {
  const match = /[<>]=?\s*(\d+(?:\.\d+)?)\s*$/.exec(rule(alert).expr);
  if (match?.[1] === undefined) throw new Error(`${alert} has no trailing threshold`);
  return Number(match[1]);
}

function budget(row: string): { warnSeconds: number; criticalSeconds: number } {
  const found = FRESHNESS_BUDGETS.values.rows.find((b) => b.row === row);
  if (found === undefined) throw new Error(`no budget for ${row}`);
  return found;
}

describe('infra/metrics/rules', () => {
  it('parses a rule set from every file, each with an expression and routing labels', () => {
    expect(new Set(RULES.map((r) => r.file))).toEqual(
      new Set(['backup.yaml', 'freshness.yaml', 'queue.yaml', 'shrinkage.yaml', 'targets.yaml']),
    );
    for (const r of RULES) {
      expect(r.expr, r.alert).not.toBe('');
      expect(['critical', 'warning', 'info'], r.alert).toContain(r.labels['severity']);
      expect(['true', 'false'], r.alert).toContain(r.labels['page']);
    }
    expect(new Set(RULES.map((r) => r.alert)).size).toBe(RULES.length);
  });

  it('references only series the metric catalogue declares', () => {
    const declared = new Set(METRIC_CATALOG.map((d) => d.name));
    const referenced = new Set(RULES.flatMap((r) => r.expr.match(/\bfw_[a-z0-9_]+/g) ?? []));
    expect(referenced.size).toBeGreaterThan(5);
    for (const name of referenced) expect(declared, name).toContain(name);
  });

  it('uses only label names the referenced series carry', () => {
    const byName = new Map(METRIC_CATALOG.map((d) => [d.name, d]));
    for (const r of RULES) {
      for (const [, name, selector] of r.expr.matchAll(/\b(fw_[a-z0-9_]+)\{([^}]*)\}/g)) {
        const descriptor = byName.get(name ?? '');
        for (const [, label] of (selector ?? '').matchAll(/(\w+)\s*[=!]~?/g)) {
          expect(descriptor?.labels, `${r.alert}: ${name ?? ''}{${label ?? ''}}`).toContain(label);
        }
      }
    }
  });

  it('pages on the L-8 queue age at OUTBOX_QUEUE_PAGE_SECONDS', () => {
    expect(threshold('NotificationQueueStuck')).toBe(OUTBOX_QUEUE_PAGE_SECONDS);
    expect(rule('NotificationQueueStuck').labels['page']).toBe('true');
  });

  it('pages on the approval deadline at alert_budgets_v1', () => {
    expect(threshold('AlertApprovalPending')).toBe(
      ALERT_BUDGETS.values.approvalPendingPageMs / 1000,
    );
  });

  it('pages on any dropped alert send, as alertDeferralPages does (A1.12)', () => {
    const sample = (ttl: number) =>
      alertDeferralPages({
        now: 0,
        oldestAwaitingDecidedAt: null,
        droppedSinceLastSample: { expired_unapproved: 0, ttl_expired: ttl },
      }).map((p) => p.rule);
    // The code's threshold is "delta > 0": one drop pages, none does not.
    expect(sample(1)).toEqual(['sends_dropped']);
    expect(sample(0)).toEqual([]);
    expect(threshold('AlertSendsDropped')).toBe(0);
    expect(rule('AlertSendsDropped').expr).toMatch(/increase\(fw_alert_sends_dropped_total\[/);
    expect(rule('AlertSendsDropped').expr).toMatch(/> 0$/);
    expect(rule('AlertSendsDropped').labels).toEqual({ severity: 'critical', page: 'true' });
  });

  it('times the backup heartbeat by the nightly-backup budget row', () => {
    expect(threshold('BackupLate')).toBe(budget('nightly-backup').warnSeconds);
    expect(threshold('BackupMissedCritical')).toBe(budget('nightly-backup').criticalSeconds);
  });

  it('times the snapshot push by the snapshot-push budget row', () => {
    expect(threshold('SnapshotPushSlow')).toBe(budget('snapshot-push').warnSeconds);
    expect(threshold('SnapshotPushLate')).toBe(budget('snapshot-push').criticalSeconds);
  });

  it('never pages on shrinkage', () => {
    const shrinkage = RULES.filter((r) => r.file === 'shrinkage.yaml');
    expect(shrinkage.length).toBeGreaterThan(0);
    for (const r of shrinkage) {
      expect(r.labels).toEqual({ severity: 'info', page: 'false' });
    }
  });
});
