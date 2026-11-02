- **A participant removing the bot ends the call; only `attend discard` erases it (#15).** The bot
  used to read a removal as an objection: it aborted the recording and meeting-api erased the
  meeting. A removal now ends the call the same way the meeting ending does, the recording is kept,
  and the transcript and summary are produced as usual. The terminal event's `discarded.trigger`
  is now always `command`. Meetings discarded before this change keep their `removed` trigger.
