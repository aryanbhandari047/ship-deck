# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Hard rule: the app never writes under FM_HOME or `~/.claude`, except `lib/wake.js` appending one line per order to `<home>/state/ship-deck-inbox.status` (append-only, `--no-wake`; add no other FM_HOME write); its other writes are `~/.ship-deck/` (orders, sessions.json, `attachments/`; see `lib/attachments.js` and the README Attachments section). `lib/fleet.js` only reads. The only commands allowed are `tmux list-windows`, `tmux capture-pane` and `<home>/bin/fm-send.sh <window-from-meta> <msg>` (all in `lib/actions.js` / `lib/fleet.js`, execFile, fixed argv; live config sends only `lib/config.js` allow-listed `/effort`/`/model`); add no others. Every other captain action is an order kind in `lib/orders.js`, documented in the README contract table. Tests fingerprint the home and inject the executor - never run fm-send in tests.
- `createServer` defaults `ordersDir`/`claudeDir` to the real `~/.ship-deck` and `~/.claude`: tests and manual runs must pass temp dirs (`--orders-dir`, `--claude-dir`). In a browser against the real home, never click Send/Apply live (they reach real workers). Browser checks: run against a scratch `--orders-dir`; `chrome-devtools-axi` needs `CHROME_DEVTOOLS_AXI_MCP_PATH` pinned to a cached chrome-devtools-mcp 1.6.0 and writes screenshots only to temp dirs (copy them into `docs/`).
- POST routes must keep the Host/Origin/`X-Ship-Deck` guards in `server.js`; clients send crew ids or library keys, never paths or tmux targets.
- Zero dependencies, no build step: `node server.js` to run, `npm test` (node:test) to test. See README.md for flags and data sources.
- Never test against the real fleet home by modifying files; copy `test/fixtures/home` (fabricated data only, never real fleet records) to a temp dir and point `--home` at it.
- Real fleet data drifts: status lines may carry a timestamp prefix or `[key=...]`, `project=` paths differ in case, and status logs contain stray shell output. Keep parsers loose and add a fixture case when a new shape appears.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
