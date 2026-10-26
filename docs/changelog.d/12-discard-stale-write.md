- **A discarded meeting stays erased.** After the erasure, the terminal callback persisted the
  meeting's service provenance from a copy of meeting.data read before it, which wrote the erased
  `recordings` and `speaker_events` back onto the row (the audio objects stayed deleted). The
  provenance write now carries only its own key, and the callback drops the erased keys from the row
  it goes on to project. The test now shares one row between the meeting repo and the transcript
  store, as production does.
