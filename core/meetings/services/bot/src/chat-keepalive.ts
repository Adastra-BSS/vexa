/**
 * Keep a long-seated Teams bot receiving the meeting chat.
 *
 * A guest page with no input stops being sent new chat messages after about half an hour, so the
 * chat commands go unanswered for the rest of a long meeting (Attend prod, ASBIS standup
 * 2026-11-05; reproduced on Attend dev meeting 69 the same day). Two remedies run while the bot
 * listens: a small pointer move every minute, so the page is not idle, and a close-and-reopen of
 * the chat pane every five minutes, so Teams loads the conversation afresh. The reopen goes
 * through the chat's one writer, so it never interleaves with a post.
 *
 * BOT_CHAT_KEEPALIVE picks them: unset or `on` runs both, `nudge` or `refresh` one, `off` none.
 */

export type ChatKeepaliveMode = { nudge: boolean; refresh: boolean };

export const CHAT_NUDGE_INTERVAL_MS = 60_000;
export const CHAT_REFRESH_INTERVAL_MS = 5 * 60_000;

export function resolveChatKeepalive(env: NodeJS.ProcessEnv): ChatKeepaliveMode {
  const value = (env.BOT_CHAT_KEEPALIVE ?? '').trim().toLowerCase();
  if (value === 'off') return { nudge: false, refresh: false };
  if (value === 'nudge') return { nudge: true, refresh: false };
  if (value === 'refresh') return { nudge: false, refresh: true };
  return { nudge: true, refresh: true };
}

export type ChatRefreshResult = { ok: true } | { ok: false; reason: string; detail?: string };

export interface ChatKeepaliveOptions {
  mode: ChatKeepaliveMode;
  /** Move the pointer; `step` counts the nudges so far. */
  nudge: (step: number) => Promise<unknown>;
  /** Close and reopen the chat pane, through the chat's one writer. */
  refresh: () => Promise<ChatRefreshResult>;
  /** Reports each refresh (the bot emits `chat_refreshed` / `chat_refresh_failed`). */
  onRefresh?: (result: ChatRefreshResult, durationMs: number) => void;
  nudgeIntervalMs?: number;
  refreshIntervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
}

/** Start the remedies the mode asks for. Returns the stop; stopping twice is harmless. */
export function startChatKeepalive(opts: ChatKeepaliveOptions): () => void {
  const {
    mode, nudge, refresh, onRefresh,
    nudgeIntervalMs = CHAT_NUDGE_INTERVAL_MS,
    refreshIntervalMs = CHAT_REFRESH_INTERVAL_MS,
    now = Date.now,
  } = opts;
  const every = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const cancel = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const handles: unknown[] = [];
  let stopped = false;
  let step = 0;
  let refreshing = false;

  if (mode.nudge) {
    handles.push(every(() => {
      if (stopped) return;
      void nudge(step++).catch(() => { /* a nudge is best-effort */ });
    }, nudgeIntervalMs));
  }
  if (mode.refresh) {
    handles.push(every(() => {
      if (stopped || refreshing) return;
      refreshing = true;
      const startedAt = now();
      void refresh()
        .catch((e: unknown): ChatRefreshResult => ({ ok: false, reason: 'error', detail: String(e).slice(0, 200) }))
        .then((result) => { if (!stopped) onRefresh?.(result, now() - startedAt); })
        .finally(() => { refreshing = false; });
    }, refreshIntervalMs));
  }
  return () => {
    if (stopped) return;
    stopped = true;
    for (const handle of handles) cancel(handle);
  };
}
