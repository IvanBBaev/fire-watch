/**
 * The probe's clock port. `infra/status/adapters/` is outside the `**\/src/adapters/**`
 * glob the lint exempts, so the one wall-clock read is waived here, on one line, rather
 * than by widening the lint. Everything else takes `nowMs` as a parameter, and the CLI's
 * `--now` overrides this for reproducible runs.
 */
export function wallClockMs(): number {
  // eslint-disable-next-line no-restricted-syntax -- the single clock port of the status probe
  return Date.now();
}
