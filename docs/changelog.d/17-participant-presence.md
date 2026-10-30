- **The terminal event says who was in the room.** The Teams participant scan sends `roster-names`
  (every readable display name except the bot's own and other notetakers) when the set changes, and
  the bot keeps each person's first and last sighting in ms from the recording's t=0
  (`participant-presence.ts`). The terminal lifecycle event carries them as `participants`, an
  additive field like `speaker_events`; meeting-api stores it in `meeting.data` and erases it with
  the meeting's other artifacts. A consumer can now tell a participant who never spoke from an
  invitee who never came.
  `roster_complete` says whether every roster scan named everyone it saw (the bot's own nameless
  tile when alone aside), so a consumer may name a leftover voice by elimination only then.
