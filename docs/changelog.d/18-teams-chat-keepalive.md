- **Chat commands keep working in long Teams meetings (#18).** After about half an hour in a
  meeting, Teams stopped sending new chat messages to the bot, so `attend help`, `leave` and
  `discard` went unanswered for the rest of a long meeting. While the bot listens for commands it
  now moves the pointer slightly every minute and reopens the chat pane every five minutes.
  `runtime.chatKeepalive` picks `nudge`, `refresh` or `off` (empty means both). Each reopen is
  logged as `bot.chat_refreshed` or `bot.chat_refresh_failed`. Every 30 s the bot logs a
  `[TeamsChat] health` line with message counts only, never what people wrote.
