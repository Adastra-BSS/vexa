- **Teams bots answer chat commands: help, leave, discard (#7).** With `runtime.chatHelp` set,
  anyone in the meeting can write `attend help`, `attend leave` or `attend discard` in the chat.
  Help replies with that text; leave replies (`runtime.chatLeaveAck`) and leaves, keeping the
  recording; discard replies (`runtime.chatDiscardAck`), stops the recording and leaves, and
  meeting-api erases everything the meeting left behind. A participant removing the bot from the
  meeting is treated as a discard; the meeting ending or the connection dropping is not. The bot
  reads only messages written after it joined, and Teams chat never enters the transcript.
