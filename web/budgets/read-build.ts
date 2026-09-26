/**
 * Reads a finished Vite build from disk into the description `checkBuild` works on.
 * The only I/O in CI-12.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { MANIFEST_PATH } from './bundle-budgets.js';
import type { BuildDescription, Manifest } from './bundle-budgets.js';

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

export function readBuild(distDir: string, publicDir: string): BuildDescription {
  const manifestPath = join(distDir, MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `CI-12: no Vite manifest at ${manifestPath}. Build first ` +
        '(`pnpm --filter @fire-watch/web build`) and keep `build.manifest: true` in ' +
        'web/vite.config.ts — without it the chunk graph cannot be read.',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const gzipCache = new Map<string, number>();
  return {
    manifest,
    distFiles: listFiles(distDir),
    publicFiles: listFiles(publicDir),
    gzipSize: (file) => {
      let size = gzipCache.get(file);
      if (size === undefined) {
        size = gzipSync(readFileSync(join(distDir, file)), { level: 9 }).byteLength;
        gzipCache.set(file, size);
      }
      return size;
    },
    text: (file) => readFileSync(join(distDir, file), 'utf8'),
  };
}
