# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Hard rule: the app never writes under FM_HOME; its only writes are `~/.ship-deck/` (orders). `lib/fleet.js` only reads. The only commands allowed are `tmux list-windows`, `tmux capture-pane` and `<home>/bin/fm-send.sh <window-from-meta> <msg>` (all in `lib/actions.js` / `lib/fleet.js`, execFile, fixed argv); add no others. Tests fingerprint the home and inject the executor - never run fm-send in tests.
- POST routes must keep the Host/Origin/`X-Ship-Deck` guards in `server.js`; clients send crew ids or library keys, never paths or tmux targets.
- Zero dependencies, no build step: `node server.js` to run, `npm test` (node:test) to test. See README.md for flags and data sources.
- Never test against the real fleet home by modifying files; copy `test/fixtures/home` (fabricated data only, never real fleet records) to a temp dir and point `--home` at it.
- Real fleet data drifts: status lines may carry a timestamp prefix or `[key=...]`, `project=` paths differ in case, and status logs contain stray shell output. Keep parsers loose and add a fixture case when a new shape appears.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
