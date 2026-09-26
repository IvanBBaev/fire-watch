/**
 * The lazy map chunk boundary: the shell `import('./map/index.js')`s this module, and
 * everything maplibre-gl (≈251 KB gz of the critical path) stays out of the entry
 * chunk (ADR-005 D3 budget table). Export nothing else from here — a wider surface
 * invites the shell to pull map internals into the entry chunk by accident.
 */

export { createMapController } from './map-controller.js';
