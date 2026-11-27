/**
 * Teams join with one in-pod retry.
 *
 * A join that fails before the bot reached the lobby is run again in the same browser: step 1 of
 * `joinMicrosoftTeams` navigates to the meeting link, so the second attempt rebuilds the page from
 * the original link and replays Teams' redirect chain. Exiting instead ends the meeting as
 * join_failure, and a fresh pod would arrive minutes late. Prod cases this recovers: a pre-join
 * that never rendered (Attend INATTE-30, Vexa meetings 915 and 988) and a call Teams dropped right
 * after "Join now" (587, 1207).
 *
 * Never retried:
 *  - a host verdict (denial, lobby timeout) and a sign-in redirect - a reload cannot change them;
 *  - anything after the bot reported `awaiting_admission` - the host may already see it waiting,
 *    and a second "Join now" would put a duplicate guest in the lobby.
 *
 * Every attempt writes one `teams_join_attempt` record (attempt, outcome, reason), so prod logs
 * show how often the retry fires and whether it saved the meeting.
 */

import type { Page } from "playwright";
import { getHooks, logJSON, setHooks, type BotConfig } from "../_host";
import { AdmissionError } from "../shared/admission";
import { TeamsJoinRedirectError } from "./auth-redirect";
import { joinMicrosoftTeams } from "./join";
import { waitForTeamsMeetingAdmission } from "./admission";

export const TEAMS_JOIN_MAX_ATTEMPTS = 2;

type AttemptOutcome = "admitted" | "not_admitted" | "retrying" | "failed";

/** A short machine-readable name for why an attempt failed. */
function reasonOf(error: unknown): string {
  if (error instanceof AdmissionError) return error.outcome;
  const code = (error as { reasonCode?: unknown } | null)?.reasonCode;
  if (typeof code === "string") return code;
  return "join_failure";
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TeamsJoinRedirectError) return false;
  if (error instanceof AdmissionError) return error.outcome === "join_failure";
  return true;
}

function logAttempt(attempt: number, outcome: AttemptOutcome, reason?: string, error?: unknown): void {
  logJSON({
    level: outcome === "failed" || outcome === "retrying" ? "warn" : "info",
    msg:
      outcome === "retrying"
        ? `Teams join attempt ${attempt} of ${TEAMS_JOIN_MAX_ATTEMPTS} failed (${reason}); reopening the join link`
        : `Teams join attempt ${attempt} of ${TEAMS_JOIN_MAX_ATTEMPTS}: ${outcome}${reason ? ` (${reason})` : ""}`,
    event: "teams_join_attempt",
    attempt,
    max_attempts: TEAMS_JOIN_MAX_ATTEMPTS,
    outcome,
    ...(reason ? { reason } : {}),
    ...(error instanceof Error ? { error: error.message.slice(0, 300) } : {}),
  });
}

/** Join a Teams meeting and wait for admission, retrying once on a failure before the lobby. */
export async function joinTeamsWithRetry(
  page: Page,
  meetingUrl: string,
  botConfig: BotConfig,
): Promise<boolean> {
  let reachedLobby = false;
  const embedderHooks = getHooks();
  setHooks({
    ...embedderHooks,
    onState: (state, detail) => {
      if (state === "awaiting_admission") reachedLobby = true;
      return embedderHooks.onState(state, detail);
    },
  });

  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await joinMicrosoftTeams(page, meetingUrl, botConfig.botName!, botConfig);
        const admitted = await waitForTeamsMeetingAdmission(
          page, botConfig.automaticLeave!.waitingRoomTimeout, botConfig,
        );
        logAttempt(attempt, admitted ? "admitted" : "not_admitted");
        return admitted;
      } catch (error) {
        const reason = reasonOf(error);
        if (!isRetryable(error) || reachedLobby || attempt >= TEAMS_JOIN_MAX_ATTEMPTS) {
          logAttempt(attempt, "failed", reason, error);
          throw error;
        }
        logAttempt(attempt, "retrying", reason, error);
      }
    }
  } finally {
    setHooks(embedderHooks);
  }
}
