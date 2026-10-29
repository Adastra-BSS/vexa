# This fork

A fork of [Vexa-ai/vexa](https://github.com/Vexa-ai/vexa) for Attend, an internal meeting-capture
product, carrying what Attend's deployment cannot express as configuration:

- **Two upstream defects** that made a capture-only auto-join spawn unreachable (Attend spawns bots
  through the auto-join sweep, and needs `RECORDING_ENABLED` honoured there).
- **Capture-only bots for post-call transcription.** Attend runs Vexa with in-call transcription
  off (`TRANSCRIBE_ENABLED=false`): the bot records, keeps a timeline of who was speaking when, and
  Attend transcribes each recording once after the call. The fork adds that speaker timeline, and
  the bot behaviour Attend's meetings need (joining on time, leaving an emptied room).
- **Azure as the platform.** Recordings go to Azure Blob Storage, including without an account
  key over the pod's workload identity; the chart and runtime carry what an AKS deployment needs
  (digest pinning, bot Pod resources, a ServiceAccount for meeting-api). The fork also speaks two
  Azure STT envelopes from the pilot's in-call period, which Attend no longer uses.

Based on upstream `main` at `4647c96` (PR #1293, 2026-08-21). The original fork point was `1f6898c`
(PR #987), where this repository's own `main` still points.

## Why a fork rather than a deployment setting

`bot_spawn/auto_join.py` calls the shared `request_bot(...)` flow without passing
`transcribe_enabled` or `recording_enabled`, so `request_bot`'s signature defaults
(`transcribe_enabled=True`, `recording_enabled=False`) applied instead of the deployment's
`TRANSCRIBE_ENABLED` / `RECORDING_ENABLED`. The manual `POST /bots` route resolved them correctly,
so the bug only bit the path the pilot actually uses. Observed live on 2026-07-31:

1. Every auto-join spawn died with `TranscriptionNotConfigured`, and the `scheduled` row stayed
   `scheduled` with no error stamped anywhere - invisible in the terminal, retried every tick.
2. With (1) patched by hand, auto-joined bots joined with `recording_enabled=false` and captured
   nothing.

During the spike both were **hot-patches inside the running container**, which `make lite` discarded
on every container recreation. A fork is what makes them survive.

## What changed

| Branch | Change |
|---|---|
| `fix/spawn-defaults-honor-deployment-flags` | `request_bot` resolves both capture flags from the deployment when the caller has no opinion (`None`), so every caller - not only the HTTP route - honours `TRANSCRIBE_ENABLED` / `RECORDING_ENABLED`. `POST /bots` keeps its request-body resolvers, so an explicit value still wins and a non-boolean is still a 422. |
| `fix/auto-join-stamps-every-spawn-refusal` | The sweep stamps `data.auto_join_error` for every way a spawn can refuse - the transcription and authenticated-bot config gates, plus a catch-all - instead of letting the exception abort the whole tick. No row is left `scheduled` with nothing written on it, and one row's failure no longer costs the rows behind it their bots. |
| `feat/azure-stt-speaker-attribution` | Three seams, one capability: the shared STT client speaks the **Azure** envelope when its URL names a deployment (`api-key` header, URL verbatim, `response_format=json`, no faster-whisper-only parts) and rebuilds a window-spanning segment from a plain-`json` reply instead of collapsing it to `end: 0`; a **bilingual** room rides the sealed `allowedLanguages` (deployment knob `TRANSCRIPTION_ALLOWED_LANGUAGES=cs,en`) as a language set the model may switch between per window; and the bot boundary stops blanking the **lettered** speaker labels (`Speaker A/B/…`) - a letter is a refusal to *name*, not a refusal to *separate*, and blanking merged every unnamed voice into one anonymous run. `seg_N` and the bare contested `Speaker` still publish empty. |
| `attend-prod` (direct) | Join-lead instrumentation (pilot issue #40): the lifecycle callback stamps `data.lobby_at` on the advance to `awaiting_admission` and logs a `lobby_lead` event with `lead_s = scheduled_at - lobby_at` (warning level when negative, i.e. the bot reached the lobby after the scheduled start). Manual sends log `lead_s: null` but still record `lobby_at`, so their cold-start cost stays visible too. |
| `attend-prod` (direct) | Spawn-early-join-late (pilot issue #40): the auto-join sweep hands every scheduled dispatch `VEXA_JOIN_NOT_BEFORE = scheduled_at - AUTO_JOIN_LOBBY_LEAD_S` (default 60s) on the workload spec env - never on the sealed invocation.v1 - and the bot's join driver holds the join flow (browser idle on about:blank, hold capped at 10 min, a Stop during the hold still withdraws) until then. A generous `AUTO_JOIN_LEAD_S` now absorbs the pod cold start without the bot loitering in the lobby; manual sends carry no window and join immediately. |
| `attend-dev-adam-join-notice` | Join notice (pilot IARD-78, legal's start-of-meeting notice): the bot posts `BOT_JOIN_NOTICE` (chart `runtime.joinNotice`, empty = off, multi-line text forwarded verbatim through the runtime's bot env) once into the Teams meeting chat right after capture starts - `@vexa/join` `sendTeamsChatMessage` opens the pane, types, confirms the message reached the message list (not just the compose box) and closes the pane. Every outcome is one stdout event, `bot.join_notice_posted` or `bot.join_notice_failed` with a reason (`chat_disabled`, `input_not_found`, `not_rendered`, `timeout`, `error`, `unsupported_platform`), carrying the meeting id and never the text; a notice that cannot be posted never costs the recording. |
| `attend-dev-rukhmani` | Join notice on Google Meet: the bot posts `BOT_JOIN_NOTICE` into the Meet in-call chat too - `@vexa/join` `sendGoogleMeetChatMessage` opens the panel ("Chat with everyone"), types the plain rendering of the text (Meet's chat shows no formatting: no bold markers, a link as `text: url`) a line at a time, confirms it reached the message list (`[data-message-id]`) and closes the panel. Same events and reasons as Teams; a host that turned participant messages off is `chat_disabled`. The chat commands stay Teams only. |
| `attend-dev-adam-chat-commands` | Chat commands (Attend, after the join notice): anyone in a Teams meeting can write `attend help`, `attend leave` or `attend discard` (any case, colon optional). The bot keeps the chat pane open and reads only messages written after it started (`createTeamsChat` `skipExisting`, keyed by Teams' message id); Teams chat goes to the commands, never the transcript. `help` posts `BOT_CHAT_HELP` every time it is asked (empty turns the commands off); `leave` posts `BOT_CHAT_LEAVE_ACK` and leaves normally; `discard` posts `BOT_CHAT_DISCARD_ACK`, aborts the recording upload, skips the signal tapes and ends with the additive lifecycle field `discarded {at, trigger}`. A participant **removing** the bot is the same objection (`removed_by_participant`, told apart from "meeting ended" / "connection lost", which keep the recording). meeting-api keeps `discarded` on the meeting and erases what it left behind (recordings, transcripts, the `tc:meeting` feed) instead of finalizing it. Events: `bot.chat_command`, `bot.chat_reply_failed`, `bot.chat_listening` / `bot.chat_listen_failed`, `meeting_discarded`. |
| `attend-dev-adam-chat-format` | Formatted chat messages: the notice and the replies are written in a small markdown subset (`**bold**`, `- ` bullets, `[text](https://...)`, blank-line paragraphs; everything else escaped). `@vexa/join` `renderChatText` turns it into HTML, which `sendTeamsChatMessage` pastes into the compose box (Teams renders pasted HTML, not typed markdown); a refused paste falls back to typing the plain version. The posted events carry `format: html|plain`. |
| `attend-dev-adam` (direct) | Discard and aloneness fixes from the dev test meetings: the erasure drops the `tc:meeting:{id}` stream through the segment bus (`RedisBus.delete_stream`; the bus has no `delete`), and the terminal callback persists `service_provenance` as its own key instead of a copy of meeting.data read before the erasure, which had written `recordings` and `speaker_events` back onto discarded meetings. The empty-room rule also needs the window to pass without remote audio, so a participant scan that reads nobody (the chat pane re-laying out the stage) never ends a meeting someone is still talking in. The participant scan skips the chat pane: Teams renders each chat message as a list item, which the broad tile selectors counted as a participant. |
| `attend-prod` (direct) | admin-api's `/internal/users/{id}/bot-context` no longer invents `bot_name: "Vexa"` when the user never chose a calendar bot name - the key is omitted, so the spawn flow's `DEFAULT_BOT_NAME` (the one place a deployment names its bot) applies to auto-joins exactly as it already did to manual sends. |

| `attend-prod` (direct) | Azure STT, continued: a third envelope for **Azure AI Speech fast transcription** (`/speechtotext/` URLs, `Ocp-Apim-Subscription-Key`, millisecond phrases mapped to the seconds-based segments); the boot preflight probe accepts Azure deployment URLs instead of refusing every spawn; and a throttled window honours the server's `Retry-After` instead of losing its audio. Attend no longer transcribes in-call, so none of this runs in its deployments today. |
| `attend-prod` (direct) | Speaker timeline for post-call transcription: the bot records its active-speaker hints against the recording's own t=0 and sends them on the terminal lifecycle event (`speaker_events`, `recording_t0_ms`); meeting-api stores both in `meeting.data` (capped), and completed-artifact deletion erases them with the transcript. |
| `attend-prod` (direct) | Leaving an emptied meeting (Teams): the participant scan feeds the aloneness check, and a room with no one but the bot for `BOT_EMPTY_ROOM_WINDOW_MS` (default 5 min) completes as `left_alone`. Other notetaker bots and the bot's own unnamed avatar count as an empty room, but only after someone had been in it. |
| `attend-prod` (direct) | Teams navigation budget raised to 120 s: a cold Chromium on a loaded host could miss the 60 s page load and fail before reaching the lobby. |
| `attend-prod` (direct) | Azure Blob recordings (pilot issue #37): `AzureBlobStorage` beside `S3Storage`, chosen by `STORAGE_BACKEND` in one factory; boot refuses a half-configured backend by name. The chart stops rendering MinIO when recordings go to Azure; compose and lite run on Azurite by default. The recordings bucket is now verified at bring-up rather than assumed. |
| `attend-prod`, via PR #4 | Azure Blob without an account key: `AZURE_STORAGE_ACCOUNT_URL` (helm only) reaches the container with `DefaultAzureCredential`, so the account can disable shared-key access. The chart gains an optional meeting-api ServiceAccount and `meetingApi.podLabels` for workload identity, and `TRANSCRIPTION_SERVICE_TOKEN` becomes optional. A deployment that sets the connection string is unchanged: it wins when both are set. |
| `attend-prod` (direct) | Kubernetes runtime: spawned bot Pods get a real `/dev/shm` and the spec's resources (the `--overrides` merge used to wipe the container), and a deployment-default bot size (`BOT_CPU` / `BOT_MEMORY_MB`, chart `runtime.botResources`) so the scheduler spreads bots and the bot pool autoscales. |
| `attend-prod` (direct) | Chart: any component's image can be pinned by `digest`, which wins over every tag; the `helm.sh/chart` label is truncated to 63 characters so longer per-branch chart versions still install. |
| `attend-prod` (direct) | Build and tooling: the registry builds the five images and the chart per push (`acb.yaml`, `deploy/acr/`, `.github/workflows/build-attend-prod.yml`, personal `attend-dev-*` builds beside the prod one); lite's Valkey build survives emulated builders and GitHub rate limits; two gates no longer report drift that was only the local Python version. |

`attend-prod` is the integration branch carrying all of the above, and is what Attend deploys.

The first three changes live on **separate branches off an unmodified upstream `main`**, so each
could be offered upstream as a clean PR. Everything since went to `attend-prod` directly or
through a pull request into it, and would need separating out before any upstream offer. No
upstream PR is open at present - this is a private-use fork for now.

## Branches and what deploys them

| Branch | Who changes it | What runs it |
|---|---|---|
| `attend-prod` | pull requests only | every push builds the `jana-pilot` channel into the shared registry (`.github/workflows/build-attend-prod.yml`); Attend's prod stack deploys it on the next merge to Attend `main`, the shared ci stack on the next Attend PR commit |
| `attend-dev-<id>` (e.g. `attend-dev-adam`) | its owner, created from `attend-prod` | only the owner's Attend dev stack, and only when its `.env` says `VEXA_BRANCH=attend-dev-<id>`; Attend's deploy builds it on demand under its own channel (see `deploy/acr/README.md`) |

A personal branch reaches prod only through a pull request into `attend-prod`. After that PR
merges, re-sync the personal branch onto `attend-prod` before building on it again. The full
workflow, for new and returning developers: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Upstream #866: handled for Teams

[Vexa-ai/vexa#866](https://github.com/Vexa-ai/vexa/issues/866) - the bot never fires `left_alone`
after everyone leaves a Teams meeting. This was first left to Attend's own supervisor, which still
issues the hard stop at meeting end plus grace. The fork now leaves an emptied Teams room itself
(see the empty-room row above); the other platforms keep upstream's silence-only rule.

## Pinning

Attend deploys this fork by **digest**, never by a moving tag. Each push builds the images and the
chart under one commit (`vexa-<svc>:jana-pilot-<sha>`, chart `helm/vexa:<ver>-jana-pilot-<sha>`;
personal branches under `helm-dev/vexa`), and Attend's deploy resolves every image's digest from
that one commit and hands them to the chart's `digest` values. A tag can be re-pointed at new
content; a digest addresses one immutable build, so a deploy cannot mix two commits or be changed
by a later push. The `jana-pilot` name is the build's, kept from before the branch was renamed to
`attend-prod`; see [`deploy/acr/README.md`](deploy/acr/README.md).
