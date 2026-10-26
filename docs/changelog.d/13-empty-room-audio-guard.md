- **A room the bot can still hear is not empty.** Opening the Teams chat pane can make the
  participant scan read nobody, and the empty-room rule then ended live meetings after its window
  (dev meeting 43: `left_alone` 90 s after the notice while someone was talking). The rule now also
  needs the window to have passed without remote audio.
