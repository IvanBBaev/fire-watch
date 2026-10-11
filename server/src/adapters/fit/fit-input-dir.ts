/**
 * File-system side of the parameter fit (TASKS D7): read the input directory with each
 * file's sha256, read and write the test-season ledger. What the bytes mean is decided in
 * `core/fit/fit-input.ts`; this only finds them.
 *
 * Layout (relative to the input root):
 * `firms/<product>/<year>/*.csv` (DS-1), `effis/modis.ba.poly.<year>.geojson` (DS-3),
 * `geo/detections.json` (DS-4, optional). Anything else is ignored, and every listing is
 * sorted so two runs over the same directory read in the same order.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FitInputFile {
  /** Relative to the input root, `/`-separated. */
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
}

export interface FitInputDir {
  /** DS-1 chunks with the product directory they sit in. */
  readonly firms: readonly (FitInputFile & { readonly product: string })[];
  /** DS-3 layers with their file name. */
  readonly effis: readonly (FitInputFile & { readonly fileName: string })[];
  readonly geo: FitInputFile | null;
}

async function listDir(path: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readInput(root: string, rel: string): Promise<FitInputFile> {
  const bytes = await readFile(join(root, rel));
  return {
    path: rel,
    text: bytes.toString('utf8'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function readFitInputDir(root: string): Promise<FitInputDir> {
  const firms: (FitInputFile & { product: string })[] = [];
  for (const product of await listDir(join(root, 'firms'))) {
    if (!product.dir) continue;
    for (const year of await listDir(join(root, 'firms', product.name))) {
      if (!year.dir) continue;
      for (const file of await listDir(join(root, 'firms', product.name, year.name))) {
        if (file.dir || !file.name.endsWith('.csv')) continue;
        const rel = `firms/${product.name}/${year.name}/${file.name}`;
        firms.push({ ...(await readInput(root, rel)), product: product.name });
      }
    }
  }
  const effis: (FitInputFile & { fileName: string })[] = [];
  for (const file of await listDir(join(root, 'effis'))) {
    if (file.dir || !file.name.endsWith('.geojson')) continue;
    effis.push({ ...(await readInput(root, `effis/${file.name}`)), fileName: file.name });
  }
  const geoEntry = (await listDir(join(root, 'geo'))).find(
    (f) => !f.dir && f.name === 'detections.json',
  );
  const geo = geoEntry === undefined ? null : await readInput(root, 'geo/detections.json');
  return { firms, effis, geo };
}

/** The ledger's JSON, or `null` when there is no ledger yet. */
export async function readJsonIfPresent(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Write-then-rename, so a crash never leaves a half-written ledger or report. */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, text, 'utf8');
  await rename(partial, path);
}
