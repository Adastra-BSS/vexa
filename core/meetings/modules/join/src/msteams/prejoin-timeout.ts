/**
 * The Teams pre-join that never rendered.
 *
 * The meetup-join lands on the Teams host (typically `light-meetings/launch`) and the anonymous
 * pre-join controls never appear. Measured across 1,336 prod bots (Attend, 2026-11-12..27): a
 * healthy pre-join is ready in 9-11 s at the median, 18 s at p99 and 39 s at worst, so a page that
 * is still empty at TEAMS_PREJOIN_READY_TIMEOUT_MS is stalled rather than slow. Driving the
 * remaining pre-join steps against it only burns ~50 s before an unnamed failure, so the join
 * stops here with a typed error and `joinTeamsWithRetry` (index.ts) opens the link again.
 *
 * Not an `AdmissionError`, for the same reason as `TeamsJoinRedirectError`: a plain throw reaches
 * the orchestrator's join catch, which stamps `reason: String(e)` onto the terminal event, so the
 * reason code survives to `last_error` under the existing transient `join_failure`.
 */

import { redactUrl } from "./auth-redirect";

/** Machine-readable discriminator: the Teams pre-join controls never rendered. */
export const TEAMS_PREJOIN_TIMEOUT = "teams_prejoin_timeout";

/** How long the pre-join may take to show its controls before the page counts as stalled. */
export const TEAMS_PREJOIN_READY_TIMEOUT_MS = 25_000;

export class TeamsPreJoinTimeoutError extends Error {
  readonly reasonCode = TEAMS_PREJOIN_TIMEOUT;
  /** The redacted page URL the join was standing on when it gave up. */
  readonly observedUrl: string;
  readonly waitedMs: number;
  constructor(currentUrl: string, waitedMs: number) {
    const observedUrl = redactUrl(currentUrl);
    super(
      `${TEAMS_PREJOIN_TIMEOUT}: the Teams pre-join controls did not render within ${waitedMs}ms ` +
        `(url=${observedUrl})`,
    );
    this.name = "TeamsPreJoinTimeoutError";
    this.observedUrl = observedUrl;
    this.waitedMs = waitedMs;
  }
}
