# This fork

A fork of [Vexa-ai/vexa](https://github.com/Vexa-ai/vexa) for an internal meeting-capture pilot,
carrying what that pilot's deployment cannot express as configuration:

- **Two upstream defects** that made a capture-only auto-join spawn unreachable (the pilot still
  spawns bots through the auto-join sweep, and still needs `RECORDING_ENABLED` honoured there).
- **The pilot's STT backend and its speaker contract**: transcription runs *in-call* against an
  Azure OpenAI `gpt-transcribe` deployment, and every turn the bot separated has to reach the
  reader as a distinct speaker. Neither is reachable from env alone — the Azure envelope differs
  from the OpenAI-compatible one the client speaks, and the bot boundary blanked the very labels
  that separate unnamed voices.

Fork point: `1f6898c` (upstream `main`, PR #987).

## Why a fork rather than a deployment setting

`bot_spawn/auto_join.py` calls the shared `request_bot(...)` flow without passing
`transcribe_enabled` or `recording_enabled`, so `request_bot`'s signature defaults
(`transcribe_enabled=True`, `recording_enabled=False`) applied instead of the deployment's
`TRANSCRIBE_ENABLED` / `RECORDING_ENABLED`. The manual `POST /bots` route resolved them correctly,
so the bug only bit the path the pilot actually uses. Observed live on 2026-07-31:

1. Every auto-join spawn died with `TranscriptionNotConfigured`, and the `scheduled` row stayed
   `scheduled` with no error stamped anywhere — invisible in the terminal, retried every tick.
2. With (1) patched by hand, auto-joined bots joined with `recording_enabled=false` and captured
   nothing.

During the spike both were **hot-patches inside the running container**, which `make lite` discarded
on every container recreation. A fork is what makes them survive.

## What changed

| Branch | Change |
|---|---|
| `fix/spawn-defaults-honor-deployment-flags` | `request_bot` resolves both capture flags from the deployment when the caller has no opinion (`None`), so every caller — not only the HTTP route — honours `TRANSCRIBE_ENABLED` / `RECORDING_ENABLED`. `POST /bots` keeps its request-body resolvers, so an explicit value still wins and a non-boolean is still a 422. |
| `fix/auto-join-stamps-every-spawn-refusal` | The sweep stamps `data.auto_join_error` for every way a spawn can refuse — the transcription and authenticated-bot config gates, plus a catch-all — instead of letting the exception abort the whole tick. No row is left `scheduled` with nothing written on it, and one row's failure no longer costs the rows behind it their bots. |
| `feat/azure-stt-speaker-attribution` | Three seams, one capability: the shared STT client speaks the **Azure** envelope when its URL names a deployment (`api-key` header, URL verbatim, `response_format=json`, no faster-whisper-only parts) and rebuilds a window-spanning segment from a plain-`json` reply instead of collapsing it to `end: 0`; a **bilingual** room rides the sealed `allowedLanguages` (deployment knob `TRANSCRIPTION_ALLOWED_LANGUAGES=cs,en`) as a language set the model may switch between per window; and the bot boundary stops blanking the **lettered** speaker labels (`Speaker A/B/…`) — a letter is a refusal to *name*, not a refusal to *separate*, and blanking merged every unnamed voice into one anonymous run. `seg_N` and the bare contested `Speaker` still publish empty. |
| `jana-pilot` (direct) | Join-lead instrumentation (pilot issue #40): the lifecycle callback stamps `data.lobby_at` on the advance to `awaiting_admission` and logs a `lobby_lead` event with `lead_s = scheduled_at - lobby_at` (warning level when negative, i.e. the bot reached the lobby after the scheduled start). Manual sends log `lead_s: null` but still record `lobby_at`, so their cold-start cost stays visible too. |

`jana-pilot` is the integration branch carrying all three, and is what the pilot deploys.

The changes are kept on **separate branches off an unmodified upstream `main`**, each standing on
its own, so any of them can be offered upstream as a clean PR later without untangling it from the
others or from the pin. No upstream PR is open at present - this is a private-use fork for now.

## Deliberately NOT fixed here: upstream #866

[Vexa-ai/vexa#866](https://github.com/Vexa-ai/vexa/issues/866) — the bot never fires `left_alone`
after everyone leaves a Teams meeting. Reproduced twice during the spike: the bot sat alone for 6+
minutes until `DELETE /bots/...` stopped it. (It terminates cleanly when the organiser *ends* the
meeting; #866 only bites the left-alone case.)

This is left to the pilot's own **supervisor** entrypoint, which watches active bots and issues the
stop, rather than patched here. Two reasons: the supervisor has to exist regardless — it also owns
the hard stop at meeting end plus grace, and typed failure stamping — and a stop-when-alone fix
inside the bot is a browser-side behavioural change on three platforms, far wider than this pilot
should carry in a fork it has to keep rebasing.

## Pinning

The pilot deploys a **digest-pinned** image built from this fork, not a tag:

```
<registry>.azurecr.io/vexa-lite@sha256:...
```

A tag such as `vexaai/vexa-lite:v012` can be re-pointed at new content; a digest addresses one
immutable blob. This is what makes the capture-only flags un-revertable by container recreation —
the failure mode the spike was bitten by. Build with `make -C deploy/lite build`.
