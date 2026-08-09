/**
 * CI-9 — architectural boundaries as a build failure, not a review comment.
 *
 * Two rules in this project are load-bearing enough that they must not depend on anyone
 * remembering them: the domain core never touches the outside world (so replays are
 * deterministic and fixtures mean something), and the alert gateway is the only code
 * that can send anything to a human (ADR-004 D1 — the whole provenance argument
 * collapses if a second sender exists).
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A cycle makes initialization order load-bearing and replay order fragile.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)(eslint|vitest)\\.config\\.'] },
      to: {},
    },
    {
      name: 'server-core-is-pure',
      severity: 'error',
      comment:
        'server/src/core is the deterministic domain: no adapters, no I/O libraries. ' +
        'Everything it needs from the outside arrives through a port.',
      from: { path: '^server/src/core/' },
      to: { path: '^server/src/(adapters|app)/' },
    },
    {
      name: 'server-core-has-no-platform',
      severity: 'error',
      comment:
        'A node builtin inside the core means the core can do I/O, read the clock, or ' +
        'read the environment — all three break determinism (ADR-002 D7).',
      from: { path: '^server/src/core/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'only-the-gateway-sends',
      severity: 'error',
      comment:
        'ADR-004 D1: every outbound notification leaves through the gateway, which is ' +
        'the single place suppression, budgets, the kill switch and the never-send lint ' +
        'are applied. A second sender is an unaudited send path.',
      from: { pathNot: '^server/src/(adapters/alerts/gateway|app)/' },
      to: { path: '^server/src/adapters/alerts/channels/' },
    },
    {
      name: 'web-core-is-framework-free',
      severity: 'error',
      comment:
        'ADR-005 D1: the web core holds the data model and the reconciler and must be ' +
        'testable without a DOM. It never imports the UI framework or the map library.',
      from: { path: '^web/src/core/' },
      to: { path: 'node_modules/(preact|maplibre-gl)' },
    },
    {
      name: 'map-layer-is-uiless',
      severity: 'error',
      comment: 'ADR-005 D1: the map layer owns MapLibre and never renders UI components.',
      from: { path: '^web/src/map/' },
      to: { path: 'node_modules/preact' },
    },
    {
      name: 'no-preact-compat',
      severity: 'error',
      comment: 'ADR-005 D2: preact/compat drags the React ecosystem into an 85 KB entry budget.',
      from: {},
      to: { path: '^node_modules/preact/compat' },
    },
    {
      name: 'no-dev-deps-in-shipped-code',
      severity: 'error',
      from: { path: '^(server|web|packages)/src/', pathNot: '\\.test\\.tsx?$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|dist-types|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts', '.tsx', '.d.ts'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
