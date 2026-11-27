# join/src/msteams — Microsoft Teams join flow

Enter a Teams meeting (teams.microsoft.com / teams.live.com) and resolve admission.
`join.ts`, `admission.ts` (roster/lobby oracle), `leave.ts`, `removal.ts`, `selectors.ts`,
`auth-redirect.ts` (origin guard: a meetup-join bounced to the Microsoft sign-in host is a typed
terminal, never an admission timeout), `prejoin-timeout.ts` (a pre-join whose controls never
render within 25 s is the typed `teams_prejoin_timeout`), `join-retry.ts` (`joinMeeting` runs the
join once more in the same page when it fails before the lobby; never after a host verdict, a
sign-in redirect or the lobby; one `teams_join_attempt` log record per attempt), `chat.ts` (post one message into the meeting chat once
seated: opens the pane, types, checks the message reached the list, closes the pane; a typed
result, never a throw).
Imports host symbols from `../_host`, `playwright`, and Node builtins only.
