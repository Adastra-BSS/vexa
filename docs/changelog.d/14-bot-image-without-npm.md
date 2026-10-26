- **The bot image ships without npm.** The npm CLI from the Node base is never run in the bot
  (pnpm installs in the builder, the worker starts with `node`), and its bundled node-tar 7.4.3 is
  a Critical finding the release scan blocks on (CVE-2026-59873). The runtime stage removes
  `/usr/lib/node_modules/npm`, `npm` and `npx`.
