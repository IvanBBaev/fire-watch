/**
 * The `only-the-gateway-sends` rule, tested by violating it.
 *
 * ADR-004 D2 says one module is the only code path that can reach a provider adapter, and
 * that a dependency-cruiser rule is what makes that hold — "quick fix sends email
 * directly" has to fail CI. A rule nobody has watched fail is a rule that might already be
 * mis-scoped: a stray character in the exemption pattern would let the whole of `app/`
 * through and nothing would ever say so, because the tree currently contains no violation
 * to catch.
 *
 * So this test writes one. It seeds a direct send into `app/`, cruises it with the
 * project's real config, and asserts the error; then it seeds the same import inside the
 * gateway and asserts silence. The pair is what matters — the first alone would pass just
 * as well against a rule that forbade everything.
 *
 * The seeded files are named `__boundary-fixture.*.ts` and are excluded from the build,
 * the linter and the formatter, so an interrupted run leaves nothing that can break an
 * unrelated command.
 */

import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const depcruiseBin = fileURLToPath(
  new URL('../../../../../node_modules/.bin/depcruise', import.meta.url),
);

/** A direct send: the import the rule exists to forbid. */
function directSendSource(relativeImport: string): string {
  return [
    `import { createSinkChannel } from '${relativeImport}';`,
    '',
    `export const channel = createSinkChannel({ channel: 'push', now: () => 0 });`,
    '',
  ].join('\n');
}

const seeded: string[] = [];

function seed(relativePath: string, source: string): string {
  writeFileSync(join(repoRoot, relativePath), source, 'utf8');
  seeded.push(relativePath);
  return relativePath;
}

afterEach(() => {
  while (seeded.length > 0) {
    const relativePath = seeded.pop();
    if (relativePath !== undefined) {
      rmSync(join(repoRoot, relativePath), { force: true });
    }
  }
});

/** Cruise one file with the project's own config. Returns the reporter's output. */
function cruise(relativePath: string): { ok: boolean; output: string } {
  try {
    execFileSync(
      depcruiseBin,
      ['--config', '.dependency-cruiser.cjs', '--output-type', 'err', relativePath],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, output: '' };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: (failure.stdout ?? '') + (failure.stderr ?? '') };
  }
}

describe('only-the-gateway-sends', () => {
  it('fails a direct send seeded in app code', () => {
    const path = seed(
      'server/src/app/__boundary-fixture.direct-send.ts',
      directSendSource('../adapters/alerts/channels/sink-channel.js'),
    );

    const result = cruise(path);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('only-the-gateway-sends');
    expect(result.output).toContain('sink-channel');
  });

  it('allows the same import inside the gateway', () => {
    const path = seed(
      'server/src/adapters/alerts/gateway/__boundary-fixture.allowed.ts',
      directSendSource('../channels/sink-channel.js'),
    );

    expect(cruise(path)).toEqual({ ok: true, output: '' });
  });
});
