/**
 * The human half of the deploy gate: a Markdown task list, one line per attested box.
 *
 *   - [x] `L12-3` Migration is expand-contract: no destructive step in the same deploy
 *
 * The backticked id is what counts; the prose after it is for the reader and may drift.
 * Parsing is strict because a lenient parser is how a box gets ticked "by interpretation"
 * (review 21 §5.6): an unknown id, a duplicated id or a tick on a machine-decided box is
 * an error that fails the gate, and a box with no line at all is unticked.
 */

import { CHECKS, findCheck } from './register.js';

export interface ParsedChecklist {
  /** Ids of the attested boxes that carry an `[x]`. */
  readonly ticked: ReadonlySet<string>;
  readonly errors: readonly string[];
}

const TASK_LINE = /^\s*[-*+]\s+\[([^\]]*)\]\s+`([^`]+)`/;

export function parseChecklist(markdown: string): ParsedChecklist {
  const ticked = new Set<string>();
  const seen = new Set<string>();
  const errors: string[] = [];

  markdown.split(/\r?\n/).forEach((line, index) => {
    const match = TASK_LINE.exec(line);
    if (match === null) return;
    const mark = match[1] ?? '';
    const id = (match[2] ?? '').trim();
    const where = `line ${index + 1}`;

    if (mark !== ' ' && mark !== 'x' && mark !== 'X') {
      errors.push(`${where}: "[${mark}]" is neither "[ ]" nor "[x]"`);
      return;
    }
    const check = findCheck(id);
    if (check === undefined) {
      errors.push(`${where}: unknown box \`${id}\` — a typo here would read as a tick`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`${where}: \`${id}\` appears more than once`);
      return;
    }
    seen.add(id);
    if (check.source === 'machine') {
      errors.push(`${where}: \`${id}\` is decided from CI evidence and cannot be ticked by hand`);
      return;
    }
    if (mark !== ' ') ticked.add(check.id);
  });

  return { ticked, errors };
}

/** Builds a checklist from explicit ticks (the `deploy.yml` dispatch inputs). */
export function checklistFromTicks(ids: readonly string[]): ParsedChecklist {
  const lines = ids.map((id) => `- [x] \`${id}\``);
  return parseChecklist(lines.join('\n'));
}

/** The blank request a human fills in; every attested box, unticked. */
export function renderChecklistTemplate(): string {
  return CHECKS.filter((c) => c.source === 'attested')
    .map((c) => `- [ ] \`${c.id}\` ${c.label} (${c.spec})`)
    .join('\n');
}
