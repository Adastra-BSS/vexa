- **Bots can post a join notice into the Teams meeting chat (#6).** Set the chart value
  `runtime.joinNotice` (env `BOT_JOIN_NOTICE`, empty = off) and every Teams bot posts that text
  once, right after it is admitted and recording - line breaks kept - then keeps recording whether
  or not the post worked. Each outcome is one stdout event, `bot.join_notice_posted` (with the time
  spent waiting for Teams' Chat button, the compose box and delivery) or `bot.join_notice_failed`
  with a reason, carrying the meeting id and never the text.
