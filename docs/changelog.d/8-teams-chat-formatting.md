- **Formatted bot messages in the Teams meeting chat (#8).** The join notice and the chat command
  replies may use **bold**, "- " bullet lines, [text](https://...) links and blank-line paragraphs.
  Teams shows typed markdown literally, so the bot pastes the text as HTML and Teams renders it;
  when Teams refuses the paste the bot types the plain version instead (markers dropped, links
  spelled out). `join_notice_posted` and `chat_reply_posted` say which happened (`format`).
