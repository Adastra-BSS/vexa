/**
 * Who was in the meeting, carried out of it on the terminal lifecycle event.
 *
 * The speaker timeline knows only who spoke. A consumer building an attendance list - Attend's
 * summary header - also has to tell a participant who listened silently from an invitee who never
 * came, and only the bot saw the room. This keeps, per display name, the first and the last roster
 * scan that showed the person (`roster-names` observations from the page's participant scan, which
 * leaves out the bot itself, other notetakers and the chat pane), in ms from the recording's own
 * t=0 like the speaker timeline. A dropped connection and a rejoin stay one person.
 *
 * Only names the page could read are here: a participant Teams renders without a name label, or
 * keeps off the visible gallery of a large meeting, is not.
 */

export interface ParticipantPresenceEntry { name: string; first_seen_ms: number; last_seen_ms: number }

/** What the terminal lifecycle event carries. Empty when there is no recording to place it in. */
export interface ParticipantPresenceReport { participants?: ParticipantPresenceEntry[] }

export interface ParticipantPresence {
  observe(names: readonly string[], tMs: number): void;
  markRecordingStart(tMs: number): void;
  snapshot(): ParticipantPresenceReport;
}

/** Far above any meeting the bot records; bounds the payload whatever the page sends. */
export const MAX_PARTICIPANTS = 500;
const MAX_NAME_CHARS = 200;

export function createParticipantPresence(): ParticipantPresence {
  const seen = new Map<string, { first: number; last: number }>();
  let t0: number | undefined;

  return {
    observe(names, tMs) {
      try {
        if (!Array.isArray(names) || !Number.isFinite(tMs)) return;
        for (const raw of names) {
          if (typeof raw !== 'string') continue;
          const name = raw.trim().slice(0, MAX_NAME_CHARS);
          if (!name) continue;
          const entry = seen.get(name);
          if (entry) {
            entry.first = Math.min(entry.first, tMs);
            entry.last = Math.max(entry.last, tMs);
          } else if (seen.size < MAX_PARTICIPANTS) {
            seen.set(name, { first: tMs, last: tMs });
          }
        }
      } catch { /* a diagnostic collector must never disturb capture */ }
    },
    markRecordingStart(tMs) {
      if (t0 === undefined && Number.isFinite(tMs)) t0 = tMs;
    },
    snapshot() {
      if (t0 === undefined) return {};
      const origin = t0;
      const participants = [...seen]
        .map(([name, entry]) => ({
          name,
          first_seen_ms: Math.max(0, entry.first - origin),
          last_seen_ms: Math.max(0, entry.last - origin),
        }))
        .sort((a, b) => a.first_seen_ms - b.first_seen_ms);
      return { participants };
    },
  };
}
