- **Auto-joined bots now honor the deployment's `TRANSCRIBE_ENABLED` / `RECORDING_ENABLED` (#988).**
  The shared spawn flow resolves both flags when the caller has no opinion, so a scheduled meeting's
  bot gets the same capture configuration a dashboard bot gets. On a capture-only deployment
  (`TRANSCRIBE_ENABLED=false`, `RECORDING_ENABLED=true`) every auto-join spawn previously failed with
  a transcription-not-configured refusal, and once that was worked around the bot joined with
  recording off and captured nothing. See [Configuration](/configuration).
