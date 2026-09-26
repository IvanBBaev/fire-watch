/**
 * The measurement D5's global budget G and the anomaly breaker are enforced against.
 *
 * `dispatchAllowance` takes `sendsInWindow` as a number or `null` and halts on `null`,
 * because "an unenforceable ceiling is not a ceiling". Where the number comes from is this
 * port: the outbox already records every provider hand-off in `dispatched_at` (D9 measures
 * latency from it), so counting that column is the only reading that cannot drift from
 * what actually went out.
 */

export interface SendRateReader {
  /**
   * Provider hand-offs at or after `from` (epoch ms). A parameter and never a clock read,
   * so a replayed cycle measures the same window.
   */
  sendsSince(from: number): Promise<number>;
}
