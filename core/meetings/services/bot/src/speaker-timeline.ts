/**
 * Who was speaking when, carried out of the meeting on the terminal lifecycle event.
 *
 * With in-call STT off, a meeting's transcript is made after the call from the recording alone:
 * one diarized pass tells the voices apart, and this timeline says whose they are. It is built
 * from the same active-speaker hints the live lane names tracks from (the Teams tile outline,
 * epoch-stamped by the page), and expressed in milliseconds from the recording's own t=0, so the
 * harvest never has to guess how the two clocks line up.
 *
 * The page re-sends "start" every ~2 s while a tile stays lit and usually, but not always, sends
 * an end: a start after a long quiet therefore opens a new turn rather than bridging the silence,
 * and a turn still open at teardown closes at its last sighting.
 */

/** One stretch of a lit tile, in ms from the recording's start. */
export interface SpeakerEvent { name: string; start_ms: number; end_ms: number }

/** What the terminal lifecycle event carries. Empty when there is no recording to place it in. */
export interface SpeakerTimelineReport { speaker_events?: SpeakerEvent[]; recording_t0_ms?: number }

export interface SpeakerTimeline {
  record(name: string, tMs: number, isEnd?: boolean): void;
  markRecordingStart(tMs: number): void;
  snapshot(): SpeakerTimelineReport;
}

/** Above the watcher's 2 s re-send cadence plus debounce and jitter; below a real pause. */
export const REOPEN_GAP_MS = 5000;
/** About one turn a second for a 4 h meeting: enough headroom, bounded payload (~1.2 MB). */
export const MAX_SPEAKER_EVENTS = 20_000;
const MAX_NAME_CHARS = 200;

export function createSpeakerTimeline(): SpeakerTimeline {
  const open = new Map<string, { start: number; last: number }>();
  const closed: Array<{ name: string; start: number; end: number }> = [];
  let t0: number | undefined;

  const close = (name: string, end: number): void => {
    const turn = open.get(name);
    open.delete(name);
    if (turn && closed.length < MAX_SPEAKER_EVENTS) closed.push({ name, start: turn.start, end });
  };

  return {
    record(rawName, tMs, isEnd = false) {
      try {
        const name = String(rawName ?? '').trim().slice(0, MAX_NAME_CHARS);
        if (!name || !Number.isFinite(tMs)) return;
        const turn = open.get(name);
        if (isEnd) {
          if (turn) close(name, Math.max(tMs, turn.start));
          return;
        }
        if (turn && tMs - turn.last <= REOPEN_GAP_MS) {
          turn.last = Math.max(turn.last, tMs);
          return;
        }
        if (turn) close(name, turn.last);
        open.set(name, { start: tMs, last: tMs });
      } catch { /* a diagnostic collector must never disturb capture */ }
    },
    markRecordingStart(tMs) {
      if (t0 === undefined && Number.isFinite(tMs)) t0 = tMs;
    },
    snapshot() {
      if (t0 === undefined) return {};
      const origin = t0;
      const turns = [...closed, ...[...open].map(([name, turn]) => ({ name, start: turn.start, end: turn.last }))];
      const speaker_events = turns
        .filter((turn) => turn.end > origin)
        .map((turn) => ({ name: turn.name, start_ms: Math.max(0, turn.start - origin), end_ms: turn.end - origin }))
        .sort((a, b) => a.start_ms - b.start_ms)
        .slice(0, MAX_SPEAKER_EVENTS);
      return { speaker_events, recording_t0_ms: origin };
    },
  };
}
