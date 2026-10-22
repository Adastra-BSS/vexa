# join/src/msteams — Microsoft Teams join flow

Enter a Teams meeting (teams.microsoft.com / teams.live.com) and resolve admission.
`join.ts`, `admission.ts` (roster/lobby oracle), `leave.ts`, `removal.ts`, `selectors.ts`,
`auth-redirect.ts` (origin guard: a meetup-join bounced to the Microsoft sign-in host is a typed
terminal, never an admission timeout), `chat.ts` (post one message into the meeting chat once
seated: opens the pane, types, checks the message reached the list, closes the pane; a typed
result, never a throw).
Imports host symbols from `../_host`, `playwright`, and Node builtins only.
