- **The join notice reaches a Teams build that renamed the chat editor (#20).** Since 2026-11-13
  some Teams sessions open the meeting chat with no Chat button and an editor none of the known
  selectors names, so the notice failed as `chat_disabled` in 5 of 31 Attend prod meetings that day.
  While the pane's Send button shows, the bot now takes any editable in the page as the compose
  box. When it still finds none, `bot.join_notice_failed` names what the compose area holds, as tags
  and attributes only and never what anyone wrote, so the next change says where the editor went.
