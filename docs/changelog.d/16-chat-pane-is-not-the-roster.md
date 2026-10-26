- **Chat messages are not participants.** Teams renders every meeting-chat message as a list item,
  which the broad participant selectors matched: once the bot opened the chat pane (join notice,
  chat commands), each message counted as one more person, so after everyone left the room never
  read empty and the bot left on the silence window instead (Attend's dev-ci e2e, meeting 67). The
  participant scan and its mutation observer now skip everything inside the chat pane.
