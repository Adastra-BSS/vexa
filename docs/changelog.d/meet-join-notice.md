- **The join notice reaches Google Meet chat.** With `runtime.joinNotice` set, a Meet bot posts the
  notice into the in-call chat once it is admitted, as a Teams bot does: plain text, line breaks
  kept, links as `text: url`. The same `bot.join_notice_posted` / `bot.join_notice_failed` events
  report it. The chat commands are still Teams only.
