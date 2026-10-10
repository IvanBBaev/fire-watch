// B9: the user_data that infra/provision.sh hands to Hetzner, checked end to end.
//
// The render gzips the comment-stripped cloud-init document and base64-encodes it onto
// one line, because the raw contract (~58 KiB) cannot fit the API's 32,768-byte cap. This
// test runs the real script in --dry-run (no token, no network, no cloud resources), then
// does what the box will do: base64-decode the way cloud-init's Hetzner datasource does
// (strict alphabet, no newlines — `b64decode(validate=True)`), gunzip, and parse. The
// decoded document must equal the repo file once the deploy key is substituted, and every
// write_files payload must be byte-identical to its source.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const INFRA = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(INFRA, 'provision.sh');
const SOURCE = join(INFRA, 'cloud-init.yaml');

// Hetzner's documented cap, and the headroom below which provision.sh starts warning.
const CAP = 32_768;
const MARGIN_WARN = 4_096;

const PLACEHOLDER = 'REPLACE_ME_WITH_THE_DEPLOY_PUBLIC_KEY';
// A syntactically valid, never-used public key: only its shape matters to the render.
const KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMTGEqIG7zYMTUfwWAcGEOv6sEgDek/MDepKy2+kOlcL test@render';

interface WriteFile {
  path: string;
  content?: string;
  encoding?: string;
}
interface CloudConfig {
  write_files?: WriteFile[];
  users?: { ssh_authorized_keys?: string[] }[];
}

let dir: string;
let encoded: string;
let stdout: string;
let decoded: Buffer;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fw-user-data-'));
  const keyFile = join(dir, 'deploy.pub');
  const out = join(dir, 'user-data.b64');
  writeFileSync(keyFile, `${KEY}\n`);

  const env = { ...process.env };
  delete env['HCLOUD_TOKEN']; // a dry run must not need — or see — a real token
  const run = spawnSync(SCRIPT, ['--dry-run', '--deploy-key', keyFile, '--emit-user-data', out], {
    encoding: 'utf8',
    env,
  });
  if (run.status !== 0) {
    throw new Error(
      `provision.sh --dry-run exited ${String(run.status)}:\n${run.stdout}\n${run.stderr}`,
    );
  }
  stdout = run.stdout;
  encoded = readFileSync(out, 'latin1');
  decoded = gunzipSync(Buffer.from(encoded, 'base64'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('provision.sh user_data render', () => {
  it('fits under the Hetzner cap with more than the warning margin to spare', () => {
    const size = statSync(join(dir, 'user-data.b64')).size;
    expect(size).toBeLessThanOrEqual(CAP - MARGIN_WARN);
    // The preflight reports the same number it enforces.
    expect(stdout).toContain(
      `user_data: ${String(size)} bytes of ${String(CAP)} (margin ${String(CAP - size)} bytes`,
    );
  });

  it('is one strict base64 line, as the Hetzner datasource requires', () => {
    // cloud-init's maybe_b64decode uses validate=True: one stray newline and the
    // datasource would hand the base64 text itself to cloud-init as user data.
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encoded.length % 4).toBe(0);
    expect(Buffer.from(encoded, 'base64').toString('base64')).toBe(encoded);
  });

  it('decodes to a #cloud-config document with the deploy key and no placeholder', () => {
    const text = decoded.toString('utf8');
    expect(text.startsWith('#cloud-config\n')).toBe(true);
    expect(text).not.toContain(PLACEHOLDER);
    const doc = parse(text) as CloudConfig;
    const keys = (doc.users ?? []).flatMap((u) => u.ssh_authorized_keys ?? []);
    expect(keys).toContain(KEY);
  });

  it('decodes to exactly the repo document once the key is substituted', () => {
    const source = readFileSync(SOURCE, 'utf8');
    expect(source.split(PLACEHOLDER)).toHaveLength(2);
    const expected = parse(
      source.replace(`ssh-ed25519 ${PLACEHOLDER} deploy@fire-watch-ci`, KEY),
    ) as unknown;
    expect(parse(decoded.toString('utf8'))).toStrictEqual(expected);
  });

  it('delivers every write_files payload byte for byte, and the repo file stays plain text', () => {
    const source = parse(readFileSync(SOURCE, 'utf8')) as CloudConfig;
    const shipped = parse(decoded.toString('utf8')) as CloudConfig;
    const want = source.write_files ?? [];
    const got = shipped.write_files ?? [];
    expect(want.length).toBeGreaterThan(0);
    expect(got.map((f) => f.path)).toStrictEqual(want.map((f) => f.path));
    for (const [i, file] of want.entries()) {
      // Readable sources: the encoding is a render-time transport detail, never committed.
      expect(file.encoding, file.path).toBeUndefined();
      expect(got[i]?.encoding, file.path).toBeUndefined();
      expect(typeof file.content, file.path).toBe('string');
      expect(
        Buffer.from(got[i]?.content ?? '', 'utf8').equals(Buffer.from(file.content ?? '', 'utf8')),
        file.path,
      ).toBe(true);
    }
  });
});
