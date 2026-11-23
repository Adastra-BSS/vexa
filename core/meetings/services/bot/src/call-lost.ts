/**
 * The dead-call watch. A call that Teams drops under the bot shows no ending text, so the removal
 * monitor never fires and the meeting idles until the empty-room rule. This watch ends the call when
 * every signal agrees for a sustained window: the hangup button is gone, the roster is empty and no
 * remote audio is heard. It is armed only once the button has been seen, so it cannot fire while
 * Teams is still building the in-call UI. A closed page ends the call at once.
 */

export interface CallLostSample {
  nowMs: number;
  /** The in-call hangup button is visible. */
  hangupVisible: boolean;
  /** The page is closed or crashed. */
  pageClosed: boolean;
  /** The roster reads empty (nobody but the bot). */
  roomEmpty: boolean;
  /** When remote audio was last heard; undefined if never. */
  lastRemoteAudioAt?: number;
}

export interface CallLostWatch {
  /** Feed one sample. Returns true on the sample that ends the call. */
  observe(sample: CallLostSample): boolean;
}

export const CALL_LOST_DEFAULT_WINDOW_MS = 30_000;

export function resolveCallLostWindowMs(env: NodeJS.ProcessEnv): number {
  const raw = (env.BOT_CALL_LOST_WINDOW_MS ?? '').trim();
  if (raw === '') return CALL_LOST_DEFAULT_WINDOW_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) return CALL_LOST_DEFAULT_WINDOW_MS;
  return Math.floor(ms);
}

export function createCallLostWatch(options: { windowMs: number; onLost: () => void }): CallLostWatch {
  const { windowMs, onLost } = options;
  let armed = false;
  let candidateSince: number | undefined;
  let fired = false;

  const lost = (): boolean => {
    fired = true;
    onLost();
    return true;
  };

  return {
    observe(sample: CallLostSample): boolean {
      if (fired || windowMs <= 0) return false;
      if (sample.hangupVisible) armed = true;
      if (!armed) return false;
      if (sample.pageClosed) return lost();

      const silent =
        sample.lastRemoteAudioAt === undefined || sample.nowMs - sample.lastRemoteAudioAt >= windowMs;
      const candidate = !sample.hangupVisible && sample.roomEmpty && silent;
      if (!candidate) {
        candidateSince = undefined;
        return false;
      }
      candidateSince ??= sample.nowMs;
      return sample.nowMs - candidateSince >= windowMs ? lost() : false;
    },
  };
}

export interface CallLostTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Poll the sample on an interval and feed the watch. A null sample (no page to read) feeds nothing. */
export function startCallLostMonitor(options: {
  watch: CallLostWatch;
  intervalMs: number;
  sample: () => Promise<CallLostSample | null>;
  scheduler?: CallLostTimers;
}): () => void {
  const timers: CallLostTimers = options.scheduler ?? {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const handle = timers.setInterval(() => {
    options.sample()
      .then((s) => { if (s) options.watch.observe(s); })
      .catch(() => { /* a failed read is no evidence either way */ });
  }, options.intervalMs);
  return () => timers.clearInterval(handle);
}
