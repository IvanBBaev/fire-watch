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
      name: 'contracts-is-platform-neutral',
      severity: 'error',
      comment:
        'ADR-005 D3: the contracts package is imported verbatim by the server and by the ' +
        'browser bundle, so a node builtin here is a module the web cannot load. ' +
        '`node.ts` is the one deliberate exception, reached through the ' +
        '`@fire-watch/contracts/node` subpath and never from the barrel. This is also ' +
        'what keeps the never-send lint under the same platform ban it was under while ' +
        'it lived in server/src/core.',
      from: {
        path: '^packages/contracts/src/',
        pathNot: '^packages/contracts/src/node\\.ts$',
      },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'only-the-gateway-sends',
      severity: 'error',
      comment:
        'ADR-004 D1: every outbound notification leaves through the gateway, which is ' +
        'the single place suppression, budgets, the kill switch and the never-send lint ' +
        'are applied. A second sender is an unaudited send path.',
      from: {
        pathNot: [
          // The gateway, and the provider adapters themselves.
          '^server/src/adapters/alerts/(gateway|channels)/',
          // Exactly one composition root, and not the whole of `app/`. Wiring a channel
          // into the gateway is legitimate; wiring is all that is. An exemption for the
          // directory would let any future worker, route or CLI reach a provider and
          // still pass — which is the direct send this rule exists to fail.
          '^server/src/app/alert-wiring\\.ts$',
          // The sign-in mailer (I1) borrows the SES transport — signing and the bounded
          // request — for one transactional mail that is not an alert. What it may take
          // from the channels directory is pinned by the next rule.
          '^server/src/adapters/mail/ses-auth-mailer\\.ts$',
          // A test may exercise an adapter directly; it ships nothing.
          '\\.test\\.ts$',
        ],
      },
      to: { path: '^server/src/adapters/alerts/channels/' },
    },
    {
      name: 'auth-mailer-reuses-transport-only',
      severity: 'error',
      comment:
        'I1: the sign-in mailer may reuse the SES transport (sigv4.ts, provider-http.ts) ' +
        'and nothing else from the alert channels. Importing a channel adapter would make ' +
        'it a second alert sender outside the gateway.',
      from: { path: '^server/src/adapters/mail/ses-auth-mailer\\.ts$' },
      to: {
        path: '^server/src/adapters/alerts/',
        pathNot: [
          '^server/src/adapters/alerts/channels/email/sigv4\\.ts$',
          '^server/src/adapters/alerts/channels/provider-http\\.ts$',
        ],
      },
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
      comment:
        'A dev dependency in shipped code is a module that exists on a developer machine ' +
        'and not in production. The workspace packages are matched one level deep ' +
        '(`packages/<name>/src/`) rather than as `packages/src/`, which nothing is: ' +
        'without that, package sources are outside this rule entirely.',
      from: { path: '^(server|web|packages/[^/]+)/src/', pathNot: '\\.test\\.tsx?$' },
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
