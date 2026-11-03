- **Meeting recordings now capture the full audio (#1013).** The mixed-lane (Zoom/Teams) recording follows
  participants who join or speak later, and flushes the final seconds when the meeting closes — so a
  recording no longer drops audio partway through or loses its last lines.
- **A participant who drops and rejoins stays in the recording, and so does everyone who shares an audio
  stream.** The recording mix connects every live audio track on its own - not one per stream, since a
  Web Audio source plays only the first track of a stream - and connects a new track the moment the Audio
  Hook mirrors it (`vexa:remote-audio-track`), with the 2 s rescan as a safety net. Each change to the
  mix is logged as `[record-chunker] mix tracks (N live): <ids>`. Attend meeting 1366 had recorded
  silence for 25 minutes after a participant reconnected.
