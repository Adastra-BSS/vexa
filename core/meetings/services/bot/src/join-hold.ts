/**
 * Spawn-early, join-late (jana #40). The control plane spawns the bot pod minutes before the
 * meeting so the infrastructure cold start (node scale-up + a 1.6GB image pull, ~150s measured
 * 2026-08-25) happens while the bot is invisible — and the bot then holds HERE, browser idle on
 * about:blank, until VEXA_JOIN_NOT_BEFORE before it navigates to the meeting. The lobby only ever
 * sees it for the short lobby lead, not for the whole spawn lead.
 *
 * The hold sits INSIDE JoinDriver.join() on purpose: the orchestrator races join() against the
 * pre-active abort, so a user Stop during the hold resolves the race and withdraws — a holding
 * bot is stoppable exactly like a lobby-waiting one.
 *
 * Degenerate inputs are all "join now": unset (manual sends), unparseable, or already past (a
 * late dispatch inside the grace window). A far-future target is clamped to MAX_HOLD_MS — a bot
 * that would sleep past its own lobby budget is misconfigured, and joining early is the safer
 * failure than never joining at all.
 */

export const JOIN_NOT_BEFORE_ENV = 'VEXA_JOIN_NOT_BEFORE';

/** Ceiling on any hold. Above this the target is treated as misconfiguration (clock skew, a wrong
 *  row) and the bot holds only this long — chosen under the control plane's pre-active reap floor
 *  (lobby budget 900s + 60s) so a clamped bot still joins before anyone declares it stuck. */
export const MAX_HOLD_MS = 10 * 60_000;

export function computeHoldMs(joinNotBefore: string | undefined, nowMs: number): number {
  if (!joinNotBefore) return 0;
  const target = Date.parse(joinNotBefore);
  if (Number.isNaN(target)) return 0;
  return Math.min(Math.max(target - nowMs, 0), MAX_HOLD_MS);
}

export interface HoldDeps {
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/** Wait until the join window opens; resolves immediately when there is nothing to wait for.
 *  Returns the milliseconds actually held (0 = joined immediately). */
export async function holdUntilJoinTime(
  joinNotBefore: string | undefined,
  deps: HoldDeps = {},
): Promise<number> {
  const nowMs = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const holdMs = computeHoldMs(joinNotBefore, nowMs());
  if (holdMs <= 0) return 0;
  log(`[join-hold] holding ${Math.round(holdMs / 1000)}s until ${joinNotBefore} before starting the join flow`);
  await sleep(holdMs);
  return holdMs;
}
