- **Dependencies the release scan accepted are upgraded.** PyJWT 2.15.1 (meeting-api, runtime),
  anyio 4.14.2 and certifi 2026.10.23 (gateway, admin-api, meeting-api, runtime); uv 0.13.5 in
  every Python image; esbuild 0.28 for the bot's page bundle, so the Go 1.2x esbuild binary of 0.25
  is no longer in the bot image; kubectl v1.36.5 in the runtime, matching the AKS 1.36 clusters it
  drives. Each one was an entry in Attend's `.trivyignore.yaml` expiring 2026-11-09.
