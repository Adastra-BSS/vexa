# Bot leave policy

This is the single source of truth for when the meeting bot leaves on its own. The bot owns the
decision; Attend only sets the numbers it runs with and keeps a crash backstop.

## When the bot leaves

| # | Situation | Waits | Chat notice | Completion | `alone_rule` |
|---|---|---|---|---|---|
| P1 | Everyone left after someone had been in the room (only bots or the bot's own avatar left) | 5 min | none | `left_alone` | `empty-room` |
| P2 | People still joined, nobody has spoken (remote audio absent) | 40 min | yes | `left_alone` | `silence` |
| P6 | Admitted, and nobody has ever joined the room | 15 min | yes | `left_alone` | `nobody-joined` |
| P8 | Active phase reached its cap | 12 h | yes | `max_bot_time_exceeded` | none |
| P4 | The call ended under the bot (host ended it) | immediate | none | `evicted` | none, `removal_kind: ended` |
| P5 | A participant removed the bot | immediate | none | `evicted` | none, `removal_kind: removed_by_participant` |
| P9 | `attend leave` or `attend discard` in the chat | immediate | the existing reply | `stopped` (discard also sets `discarded`) | none |
| P7 | Never admitted (lobby timeout) | 15 min | none | `awaiting_admission_timeout` | none |

Rules:

- A meeting running past its calendar end is never cut off. There is no end-time rule.
- Each timer starts when its condition becomes true and resets when the condition clears. Remote
  speech resets the quiet window. Local bot speech does not count as speech.
- Room rules (P1, P6) need a roster reading. Without one (Google Meet, Zoom, Jitsi today) only the
  quiet window (P2) and the cap (P8) can fire.
- If several rules hold on the same tick, the room rules win over the quiet rule. External ends (P4,
  P5, P9) and the cap resolve whichever signal arrives first.
- A rule that does not produce a chat notice (P1, P4, P5, P9) leaves silently by design. P1 is the
  common case and would be noise.

## Chat notices

Posted once, before the leave, through the same serialized chat sender the join notice uses. The
notice is bounded to 10 seconds and never delays or fails the leave. Teams is the only platform with
a chat sender today. On other platforms the attempt is logged as `leave_notice_failed` with
`unsupported_platform`.

| Kind | Text |
|---|---|
| quiet | No speech for 40 minutes, so I'm leaving the meeting. |
| nobody-joined | Nobody joined within 15 minutes, so I'm leaving. |
| max-active | I've reached my maximum time in a meeting (12 hours), so I'm leaving. |

The texts are constants in `core/meetings/services/bot/src/index.ts`. They are not configurable yet.

## Settings

Bot-side values come from the runtime or the deployment environment. Attend sets them from its stack
config (`meeting_capture.vexa.*`).

| Variable | Default in the bot | Prod (Attend) | Dev (Attend) | Rule |
|---|---|---|---|---|
| `BOT_ALONE_SILENCE_WINDOW_MS` | 2400000 (40 min) | 2400 s | 90 s | P2 |
| `BOT_EMPTY_ROOM_WINDOW_MS` | 300000 (5 min) | 300 s | 60 s | P1 |
| `BOT_NOBODY_JOINED_WINDOW_MS` | 900000 (15 min) | 900 s | 120 s | P6 |
| `BOT_MAX_ACTIVE_MS` | 43200000 (12 h) | 43200 s | 43200 s | P8 |

An explicit `automatic_leave.max_time_left_alone` on a meeting request overrides the quiet window for
that meeting. A value of `0` disables P1 or P6. Invalid values fall back to the default with a warning.

## Attend backstop

Attend's supervisor stops a bot that is still active after `max_duration_minutes` (780 minutes, 13
hours) from its active start. The value sits above the bot's own cap, so the bot's P8 exit happens
first and posts its notice. The supervisor does not look at the calendar end.

## Terminal event fields

- `completion_reason`: as in the table.
- `alone_rule`: `empty-room`, `nobody-joined` or `silence`. Present only when the bot left alone.
- `removal_kind`: `ended` or `removed_by_participant`. Present only on `evicted`.

Consumers match on `left_alone` for the whole family of rules. The field `alone_rule` says which rule.

## Known gaps

- No chat notice on Google Meet, Zoom or Jitsi, and no roster-based room rules there.
- `invocation.automaticLeave.noOneJoinedTimeout` is carried but unused. P6 reads only
  `BOT_NOBODY_JOINED_WINDOW_MS`.
- P6 starts at the first roster reading that shows the room empty. That is close to admission but not
  the same instant.
- Speech detection is not separate from remote audio. Background noise above the capture gate counts
  as presence.

## Where it is implemented

- Bot: `core/meetings/services/bot/src/aloneness.ts` (room and quiet rules),
  `orchestrator.ts` (leave notice, end reasons), `index.ts` (texts, wiring, defaults).
- Runtime forwarding: `core/runtime/src/runtime_kernel/config.v1.json` and `profiles.py`.
- Attend: `src/capture_service/supervisor.py` (backstop), `src/common/config.py`,
  `config/stacks/{prod,dev}.yaml`, `scripts/deploy_vexa_aks.sh`, `deployments/capture-local/local_up.sh`.
