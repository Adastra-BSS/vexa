/** Active-phase aloneness derived from the remote-audio signal. */
import type { AlonenessSource } from './ports.js';

export const DEFAULT_ALONE_SILENCE_WINDOW_MS = 10 * 60 * 1000;
/** Long enough to sit out someone dropping and rejoining, short against the silence window. */
export const DEFAULT_EMPTY_ROOM_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_ALONENESS_POLL_MS = 1_500;
/** Presence floor for a DELIVERED remote frame — deliberately 0 (arrival is the signal).
 *
 *  Capture is the single silence oracle: the page emits a frame only when its PEAK sample exceeds
 *  its own gate (`mixed-audio.ts` / `gmeet-capture.ts`, 0.005), and the activity tap sits on the
 *  Node side of that gate (`capture-bridge.ts:289,298`). So every frame that reaches this seam has
 *  ALREADY proven it carries audio — and was sent to STT and transcribed on that basis.
 *
 *  Re-testing such a frame with RMS (always ≤ peak; for speech 3–5× lower) against the SAME 0.005
 *  could only ever REJECT audio the capture gate accepted — never admit anything it refused. It was
 *  a pure false-negative generator: a participant speaking quietly was transcribed while counting as
 *  silence toward `left_alone`, so the bot could leave a meeting it could hear. #850 measured 23.3%
 *  of frames in one real fixture sitting in exactly that peak-passes/RMS-fails band.
 *
 *  A cost decision ("don't pay Whisper for near-silence") is not a presence decision. Only a frame
 *  carrying no energy at all is silence here; anything the capture gate delivered is someone. */
export const REMOTE_AUDIO_ENERGY_FLOOR = 0;

export interface RemoteAudioActivitySnapshot {
  available: boolean;
  lastRemoteAudioAt?: number;
  /** Whether the page's roster last showed nobody but bots; undefined until a report. */
  roomEmpty?: boolean;
  /** When the room last became empty, so it can be timed from the moment it emptied. */
  roomEmptySince?: number;
  /** Somebody has been in the room at some point. Until then the meeting may just be starting late. */
  roomEverOccupied?: boolean;
}

/** One roster report from the page. All counts exclude the bot itself. */
export interface RosterReport {
  /** Participant surfaces, counting each unnamed one separately. */
  participants: number;
  /** …of which a display name resolved. */
  named: number;
  /** …of which the name reads as another meeting bot. */
  bots: number;
}

/** Nobody left but bots. Alone, Teams renders the bot's own avatar without a name label, which the
 *  scan cannot tell from a person and counts as one unnamed participant; so one unnamed surface with
 *  no named human beside it is still an empty room, and a second unnamed one is somebody. */
export function isEmptyRoom(report: RosterReport): boolean {
  const namedHumans = report.named - report.bots;
  const unnamed = report.participants - report.named;
  return namedHumans <= 0 && unnamed <= 1;
}

export interface RemoteAudioActivitySource {
  snapshot(): RemoteAudioActivitySnapshot;
}

export interface RemoteAudioActivityTap extends RemoteAudioActivitySource {
  /** Capture is attached and can distinguish silence from a missing signal. */
  ready(): void;
  /** Record one REMOTE frame's RMS energy. Local bot speech never enters this seam. */
  observeRemoteEnergy(energy: number): void;
  /** Capture stopped or failed; aloneness must fail closed until it is ready again. */
  unavailable(): void;
  /** Record the page's latest roster report. */
  observeRoster(report: RosterReport): void;
}

export type AlonenessVerdict = 'alone' | 'not-alone' | 'unavailable';
/** Which rule ended the meeting. Both complete it as left_alone, so this is the only record of why. */
export type AloneRule = 'empty-room' | 'silence';

/** One deployment-selectable rule. Future presence checks can veto by returning not-alone. */
export interface AlonenessAdapter {
  readonly name: string;
  evaluate(snapshot: RemoteAudioActivitySnapshot, now: number, windowMs: number): AlonenessVerdict;
}

export interface TimerScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export function createRemoteAudioActivityTap(options: {
  now?: () => number;
  energyFloor?: number;
} = {}): RemoteAudioActivityTap {
  const now = options.now ?? Date.now;
  const energyFloor = options.energyFloor ?? REMOTE_AUDIO_ENERGY_FLOOR;
  let state: { available: boolean; lastRemoteAudioAt?: number } = { available: false };
  // Kept apart from the audio state: the roster comes from the page's participant scan, not from
  // audio capture, so capture readiness changing must not forget who is in the room.
  let roster: { roomEmpty?: boolean; roomEmptySince?: number; roomEverOccupied?: boolean } = {};

  return {
    ready(): void {
      state = { available: true, lastRemoteAudioAt: now() };
    },
    observeRemoteEnergy(energy: number): void {
      // Digital silence (or a nonsense reading) is not presence; every other delivered frame is.
      if (!state.available || !Number.isFinite(energy) || energy <= 0 || energy < energyFloor) return;
      state = { available: true, lastRemoteAudioAt: now() };
    },
    unavailable(): void {
      state = { available: false };
    },
    observeRoster(report: RosterReport): void {
      const counts = [report.participants, report.named, report.bots];
      if (!counts.every((n) => Number.isFinite(n) && n >= 0)) return;
      const empty = isEmptyRoom(report);
      if (!empty) { roster = { roomEmpty: false, roomEverOccupied: true }; return; }
      if (roster.roomEmpty) return;
      roster = { roomEmpty: true, roomEmptySince: now(), roomEverOccupied: roster.roomEverOccupied ?? false };
    },
    snapshot(): RemoteAudioActivitySnapshot {
      return { ...state, ...roster };
    },
  };
}

/** A room empty for the window, after somebody had been in it, means everyone left. No roster
 *  report at all means the platform or page cannot count, which is not evidence of an empty room. */
function emptyRoomFor(snapshot: RemoteAudioActivitySnapshot, now: number, emptyRoomMs: number): boolean {
  return emptyRoomMs > 0
    && snapshot.roomEverOccupied === true
    && snapshot.roomEmpty === true
    && snapshot.roomEmptySince !== undefined
    && now - snapshot.roomEmptySince >= emptyRoomMs;
}

export const silenceAlonenessAdapter: AlonenessAdapter = {
  name: 'silence',
  evaluate(snapshot, now, windowMs): AlonenessVerdict {
    if (!snapshot.available || snapshot.lastRemoteAudioAt === undefined) return 'unavailable';
    return now - snapshot.lastRemoteAudioAt >= windowMs ? 'alone' : 'not-alone';
  },
};

export function resolveAloneSilenceWindowMs(
  explicitEveryoneLeftTimeout: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(`[bot] ${message}`),
): number {
  if (typeof explicitEveryoneLeftTimeout === 'number'
    && Number.isFinite(explicitEveryoneLeftTimeout)
    && explicitEveryoneLeftTimeout > 0) {
    return explicitEveryoneLeftTimeout;
  }
  const raw = env.BOT_ALONE_SILENCE_WINDOW_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
    warn(`BOT_ALONE_SILENCE_WINDOW_MS=${JSON.stringify(raw)} is invalid; using the 10-minute default`);
  }
  return DEFAULT_ALONE_SILENCE_WINDOW_MS;
}

export function resolveEmptyRoomWindowMs(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(`[bot] ${message}`),
): number {
  const raw = env.BOT_EMPTY_ROOM_WINDOW_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
    warn(`BOT_EMPTY_ROOM_WINDOW_MS=${JSON.stringify(raw)} is invalid; using the 5-minute default`);
  }
  return DEFAULT_EMPTY_ROOM_WINDOW_MS;
}

export function createSilenceAlonenessSource(options: {
  activity: RemoteAudioActivitySource;
  windowMs: number;
  /** How long an empty roster is tolerated before leaving; 0 disables the rule. */
  emptyRoomMs?: number;
  adapters?: readonly AlonenessAdapter[];
  now?: () => number;
  pollMs?: number;
  setInterval?: TimerScheduler['setInterval'];
  clearInterval?: TimerScheduler['clearInterval'];
  log?: (message: string) => void;
}): AlonenessSource & { firedRule(): AloneRule | undefined } {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_ALONENESS_POLL_MS;
  const adapters = options.adapters ?? [silenceAlonenessAdapter];
  const emptyRoomMs = options.emptyRoomMs ?? 0;
  const setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const log = options.log ?? ((message) => console.log(`[bot] ${message}`));
  let firedRule: AloneRule | undefined;

  return {
    firedRule: () => firedRule,
    onAlone(callback): () => void {
      let handle: unknown;
      let stopped = false;
      let fired = false;

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        if (handle !== undefined) clearIntervalFn(handle);
      };
      const tick = (): void => {
        if (stopped || fired || adapters.length === 0) return;
        const at = now();
        const snapshot = options.activity.snapshot();
        const verdict = (rule: AloneRule, detail: string): void => {
          fired = true;
          firedRule = rule;
          stop();
          log(`aloneness: ${rule} verdict (${detail})`);
          callback();
        };
        // Either rule ends the meeting on its own: the silence window is for a room that still has
        // people in it, so an emptied room must not have to sit it out.
        if (emptyRoomFor(snapshot, at, emptyRoomMs)) {
          verdict('empty-room', `room_empty_since=${snapshot.roomEmptySince}, empty_room_ms=${emptyRoomMs}`);
          return;
        }
        for (const adapter of adapters) {
          if (adapter.evaluate(snapshot, at, options.windowMs) !== 'alone') return;
        }
        verdict('silence', `last_remote_audio_at=${snapshot.lastRemoteAudioAt}, window_ms=${options.windowMs}`);
      };

      handle = setIntervalFn(tick, pollMs);
      tick();
      return stop;
    },
  };
}
