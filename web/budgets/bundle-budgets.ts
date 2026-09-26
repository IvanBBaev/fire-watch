/**
 * CI-12 — the byte half of the bundle budgets (ADR-005 D3, review 08 §5.5.1).
 *
 * Pure: everything here works on a description of a finished Vite build (its manifest,
 * the list of files it wrote, their gzip sizes and the text of its CSS and HTML) and
 * never touches the disk. `read-build.ts` produces that description from `web/dist`.
 *
 * What is measured is derived from the build's own chunk graph, not from file names:
 *
 * - **entry** — the HTML entry chunk plus everything it imports statically, plus the
 *   largest locale catalog. Review 08 §5.5.1 puts "i18n (active locale)" inside the
 *   entry budget, and boot awaits the catalog before the first render, so one catalog is
 *   on the first-render path; which one depends on the visitor, so the worst is charged.
 * - **map** — what loading the lazy map root adds on top of the entry: its static
 *   closure minus the chunks the entry already fetched.
 * - **criticalPath** — review 08 §5.5.1: "entry + map", JavaScript only ("≤ 350 KB gz
 *   JS on the critical path", 08 §1.5). The union of the three closures above, each
 *   file counted once.
 * - **css** — every stylesheet the build emitted, summed. Review 08 plans one file.
 *
 * Web workers are the one kind of script Vite writes without a manifest record: a
 * `?worker&url` import emits the worker bundle as an asset and inlines only its URL.
 * Such a file is charged to the chunk whose code names it — the chunk that will start
 * it — and so to every budget that chunk is in (MapLibre's worker, named by the lazy
 * map chunk, is map bytes: no tile or GeoJSON is parsed until it has loaded). A script
 * no chunk names is still unclassified, and still an error.
 *
 * The only thing written down by hand is which *lazy roots* exist and what role each
 * plays (`LAZY_ROLES`). That cannot be read off the graph — nothing in a manifest says
 * a dynamic import is awaited before first paint — so it is a rule table, and it fails
 * closed: a dynamic entry no rule claims, a second HTML entry, a chunk reachable from
 * nothing, or a file in `dist` that none of the above accounts for is an error, never
 * an unbudgeted byte.
 *
 * Units: 1 KB = 1024 bytes, gzip level 9. Lighthouse CI `budgets.json` (the tool
 * ADR-005 names) counts KiB, and review 08's MapLibre figure is Bundlephobia's,
 * which is gzip -9.
 */

export const KIB = 1024;

/** ADR-005 D3. Spec numbers: an overage is a finding, never a reason to edit these. */
export const BUDGETS = {
  entry: 85 * KIB,
  map: 290 * KIB,
  criticalPath: 350 * KIB,
  css: 20 * KIB,
} as const;

export type BudgetName = keyof typeof BUDGETS;

/** The subset of Vite's `build.manifest` record this gate reads. */
export interface ManifestChunk {
  readonly file: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}

export type Manifest = Readonly<Record<string, ManifestChunk>>;

export type LazyRole = 'map' | 'locale' | 'page';

/**
 * Every dynamic-import root in the web app, by role, keyed on the source module the
 * root is built from (the manifest's `src`). A new `import()` in the app produces a new
 * root; until a rule here says what it is, CI-12 is red.
 */
export const LAZY_ROLES: readonly { readonly role: LazyRole; readonly src: RegExp }[] = [
  // Review 08 §5.5.1 `map`: maplibre-gl, controller, layers. Exactly one.
  { role: 'map', src: /^src\/map\/index\.ts$/ },
  // Review 08 §5.2.7: one code-split catalog per locale, loaded before first render.
  { role: 'locale', src: /^src\/core\/i18n\/[a-z]{2}\.ts$/ },
  // TASKS I1: a page few readers open, loaded only when its route is visited — never on
  // the first-render or map path, so it is charged to no budget (a new budget for on-demand
  // pages is a founder/ADR-005 decision). Listed by name: a page does not become lazy, and
  // leave the entry budget, just by being written as an `import()`.
  { role: 'page', src: /^src\/ui\/pages\/sign-in\.tsx$/ },
];

/** Where the HTML entry lives in the manifest, and where the manifest lives in dist. */
export const HTML_ENTRY_KEY = 'index.html';
export const MANIFEST_PATH = '.vite/manifest.json';

/** Webfont formats. ADR-005 D3: UI fonts are the system stack, 0 bytes. */
const FONT_FILE = /\.(woff2?|ttf|otf|eot)$/i;

export interface BuildDescription {
  readonly manifest: Manifest;
  /** Every file under `dist`, POSIX-relative to it (e.g. `assets/index-abc.js`). */
  readonly distFiles: readonly string[];
  /** Every file under `web/public`, which Vite copies into `dist` verbatim. */
  readonly publicFiles: readonly string[];
  /** Gzip -9 size in bytes of a file under `dist`. */
  readonly gzipSize: (distPath: string) => number;
  /** UTF-8 text of a file under `dist` (read for CSS, `index.html` and JS chunks). */
  readonly text: (distPath: string) => string;
}

export interface Measurement {
  readonly budget: BudgetName;
  readonly bytes: number;
  readonly limit: number;
  /** The dist files charged to this budget, sorted. */
  readonly files: readonly string[];
}

export interface BudgetReport {
  /** Classification or font-rule violations. Any entry here fails the gate outright. */
  readonly errors: readonly string[];
  readonly measurements: readonly Measurement[];
  /** Budgets whose measured bytes exceed the limit. */
  readonly overBudget: readonly BudgetName[];
}

function staticClosure(manifest: Manifest, root: string, errors: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const key = stack.pop();
    if (key === undefined || seen.has(key)) continue;
    const chunk = manifest[key];
    if (chunk === undefined) {
      errors.push(`manifest: "${key}" is imported but has no record`);
      continue;
    }
    seen.add(key);
    stack.push(...(chunk.imports ?? []));
  }
  return seen;
}

function sum(files: Iterable<string>, gzipSize: (f: string) => number): number {
  let total = 0;
  for (const file of files) total += gzipSize(file);
  return total;
}

function jsFiles(manifest: Manifest, keys: Iterable<string>): Set<string> {
  const files = new Set<string>();
  for (const key of keys) {
    const chunk = manifest[key];
    if (chunk !== undefined) files.add(chunk.file);
  }
  return files;
}

const SCRIPT_FILE = /\.m?js$/;

function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/**
 * `files` plus every worker script they name, transitively (a worker may start another).
 * A worker is a script in dist with no manifest record; it is found by its emitted file
 * name appearing in the text of a script that is already charged.
 */
function withWorkers(
  files: ReadonlySet<string>,
  workers: readonly string[],
  text: (f: string) => string,
): Set<string> {
  const out = new Set(files);
  const pending = [...files];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined) continue;
    const body = text(file);
    for (const worker of workers) {
      if (!out.has(worker) && body.includes(baseName(worker))) {
        out.add(worker);
        pending.push(worker);
      }
    }
  }
  return out;
}

function union<T>(...sets: readonly Iterable<T>[]): Set<T> {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

function measure(
  budget: BudgetName,
  files: ReadonlySet<string>,
  gzipSize: (f: string) => number,
): Measurement {
  return {
    budget,
    bytes: sum(files, gzipSize),
    limit: BUDGETS[budget],
    files: [...files].sort(),
  };
}

/** The set among `candidates` (each unioned with `base`) that weighs the most. */
function heaviest(
  base: ReadonlySet<string>,
  candidates: readonly ReadonlySet<string>[],
  gzipSize: (f: string) => number,
): Set<string> {
  let best = new Set(base);
  let bestBytes = sum(best, gzipSize);
  for (const candidate of candidates) {
    const withCandidate = union(base, candidate);
    const bytes = sum(withCandidate, gzipSize);
    if (bytes > bestBytes) {
      best = withCandidate;
      bestBytes = bytes;
    }
  }
  return best;
}

/**
 * Local references (`src`/`href`) in the built `index.html`. Anything the document
 * itself makes the browser fetch is on the first-render path by definition.
 */
function htmlReferences(html: string): string[] {
  const refs: string[] = [];
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = match[1];
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

export function checkBuild(build: BuildDescription): BudgetReport {
  const { manifest, gzipSize } = build;
  const errors: string[] = [];
  const keys = Object.keys(manifest).sort();

  // --- The one HTML entry --------------------------------------------------------
  const entries = keys.filter((key) => manifest[key]?.isEntry === true);
  for (const key of entries) {
    if (key !== HTML_ENTRY_KEY) {
      errors.push(
        `entry "${key}" is not the HTML entry; CI-12 has no budget for a second entry point`,
      );
    }
  }
  if (!entries.includes(HTML_ENTRY_KEY)) {
    errors.push(`manifest has no "${HTML_ENTRY_KEY}" entry`);
  }
  const entryKeys = entries.includes(HTML_ENTRY_KEY)
    ? staticClosure(manifest, HTML_ENTRY_KEY, errors)
    : new Set<string>();

  // --- Lazy roots, each claimed by exactly one role -------------------------------
  const rootsByRole: Record<LazyRole, string[]> = { map: [], locale: [], page: [] };
  // Unclassified roots are already an error; keeping them out of the reachability check
  // below stops the same chunk being reported twice.
  const unclassifiedRoots: string[] = [];
  for (const key of keys) {
    const chunk = manifest[key];
    if (chunk?.isDynamicEntry !== true) continue;
    const src = chunk.src ?? key;
    const roles = LAZY_ROLES.filter((rule) => rule.src.test(src)).map((rule) => rule.role);
    const [role] = roles;
    if (roles.length !== 1 || role === undefined) {
      errors.push(
        roles.length === 0
          ? `lazy chunk "${chunk.file}" (from ${src}) has no role in LAZY_ROLES; ` +
              'decide which budget it belongs to before it can ship'
          : `lazy chunk "${chunk.file}" (from ${src}) matches several roles: ${roles.join(', ')}`,
      );
      unclassifiedRoots.push(key);
      continue;
    }
    rootsByRole[role].push(key);
  }
  if (rootsByRole.map.length !== 1) {
    errors.push(
      `expected exactly one lazy map root, found ${rootsByRole.map.length}` +
        (rootsByRole.map.length > 0 ? `: ${rootsByRole.map.join(', ')}` : ''),
    );
  }
  if (rootsByRole.locale.length === 0) {
    errors.push('no lazy locale catalog found; the entry budget includes the active locale');
  }

  const mapKeys = union(...rootsByRole.map.map((root) => staticClosure(manifest, root, errors)));
  const localeKeySets = rootsByRole.locale.map((root) => staticClosure(manifest, root, errors));
  const pageKeys = union(...rootsByRole.page.map((root) => staticClosure(manifest, root, errors)));

  // --- Every chunk must be reachable from something budgeted ---------------------
  const reachable = union(
    entryKeys,
    mapKeys,
    ...localeKeySets,
    pageKeys,
    ...unclassifiedRoots.map((root) => staticClosure(manifest, root, [])),
  );
  for (const key of keys) {
    if (!reachable.has(key)) {
      errors.push(`chunk "${manifest[key]?.file ?? key}" (${key}) is reachable from no budget`);
    }
  }

  // --- Measurements --------------------------------------------------------------
  // Scripts in dist without a manifest record: worker bundles, if a chunk names them.
  const allChunkFiles = jsFiles(manifest, keys);
  const publicFileSet = new Set(build.publicFiles);
  const workerCandidates = build.distFiles.filter(
    (file) => SCRIPT_FILE.test(file) && !allChunkFiles.has(file) && !publicFileSet.has(file),
  );
  const charged = (files: ReadonlySet<string>): Set<string> =>
    withWorkers(files, workerCandidates, build.text);

  const entryJs = charged(jsFiles(manifest, entryKeys));
  const mapJs = charged(jsFiles(manifest, mapKeys));
  const localeJs = localeKeySets.map((set) => charged(jsFiles(manifest, set)));

  const entryWithLocale = heaviest(entryJs, localeJs, gzipSize);
  const mapOnly = new Set([...mapJs].filter((file) => !entryJs.has(file)));
  const critical = heaviest(union(entryJs, mapJs), localeJs, gzipSize);

  const cssFromManifest = new Set<string>();
  const assetsFromManifest = new Set<string>();
  for (const key of keys) {
    for (const css of manifest[key]?.css ?? []) cssFromManifest.add(css);
    for (const asset of manifest[key]?.assets ?? []) assetsFromManifest.add(asset);
  }
  const emittedCss = build.distFiles.filter((file) => file.endsWith('.css'));
  for (const css of emittedCss) {
    if (!cssFromManifest.has(css)) {
      errors.push(`stylesheet "${css}" is in dist but attached to no chunk in the manifest`);
    }
  }

  const measurements: Measurement[] = [
    measure('entry', entryWithLocale, gzipSize),
    measure('map', mapOnly, gzipSize),
    measure('criticalPath', critical, gzipSize),
    measure('css', new Set(emittedCss), gzipSize),
  ];

  // --- Every file in dist is accounted for ---------------------------------------
  const chunkFiles = allChunkFiles;
  const publicFiles = publicFileSet;
  const distFiles = new Set(build.distFiles);
  const explained = union(
    [HTML_ENTRY_KEY, MANIFEST_PATH],
    chunkFiles,
    entryJs,
    mapJs,
    ...localeJs,
    cssFromManifest,
    assetsFromManifest,
    publicFiles,
  );
  for (const file of build.distFiles) {
    if (explained.has(file)) continue;
    // A source map is explained by the file it maps, and never fetched by a visitor.
    if (file.endsWith('.map') && explained.has(file.slice(0, -'.map'.length))) continue;
    errors.push(`"${file}" is in dist but no rule classifies it`);
  }
  for (const file of union(chunkFiles, cssFromManifest)) {
    if (!distFiles.has(file)) errors.push(`manifest names "${file}" but it is not in dist`);
  }

  // --- The document fetches only the entry's own files ---------------------------
  if (distFiles.has(HTML_ENTRY_KEY)) {
    const entryFetchable = union(entryJs, cssFromEntry(manifest, entryKeys), publicFiles);
    for (const ref of htmlReferences(build.text(HTML_ENTRY_KEY))) {
      const local = ref.startsWith('/') ? ref.slice(1) : ref;
      if (!entryFetchable.has(local)) {
        errors.push(`index.html references "${ref}", which is not a file of the entry chunk`);
      }
    }
  } else {
    errors.push(`dist has no ${HTML_ENTRY_KEY}`);
  }

  // --- UI fonts: the system stack, 0 bytes ---------------------------------------
  for (const file of build.distFiles) {
    if (FONT_FILE.test(file)) errors.push(`"${file}" is a webfont; UI fonts are the system stack`);
  }
  for (const file of [...emittedCss, HTML_ENTRY_KEY]) {
    if (!distFiles.has(file)) continue;
    const text = build.text(file);
    if (/@font-face\b/i.test(text)) {
      errors.push(`"${file}" declares @font-face; UI fonts are the system stack`);
    }
    // Vite inlines every local @import, so one that survives the build is a fetch from
    // somewhere else (a font service, typically) that no budget here can see.
    if (/@import\b/i.test(text)) {
      errors.push(`"${file}" keeps an @import the build did not inline`);
    }
  }

  const overBudget = measurements.filter((m) => m.bytes > m.limit).map((m) => m.budget);
  return { errors, measurements, overBudget };
}

function cssFromEntry(manifest: Manifest, entryKeys: ReadonlySet<string>): Set<string> {
  const css = new Set<string>();
  for (const key of entryKeys) for (const file of manifest[key]?.css ?? []) css.add(file);
  return css;
}

/** A fixed-width table for the log: what each budget weighs and what it is made of. */
export function formatReport(report: BudgetReport): string {
  const kib = (bytes: number): string => `${(bytes / KIB).toFixed(2)} KiB`;
  const lines = report.measurements.map(
    (m) =>
      `${m.budget.padEnd(12)} ${String(m.bytes).padStart(8)} B (${kib(m.bytes)})` +
      ` / ${String(m.limit).padStart(6)} B (${kib(m.limit)})` +
      `  ${m.bytes > m.limit ? 'OVER' : 'ok'}  [${m.files.join(', ')}]`,
  );
  return ['CI-12 bundle budgets (gzip -9, 1 KB = 1024 B):', ...lines].join('\n');
}
