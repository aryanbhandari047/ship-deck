# Ship Deck

A local, live GUI of the firstmate fleet, drawn as a top-down ship deck. Every
in-flight task is a crew member at a deck station; the bridge shows the captain,
the first mate at the helm and the watch lamp; queued backlog items sit in the
cargo hold as crates. Inspired by [Munder Difflin](https://github.com/HarnessMD/munder-difflin).

It is **read-only against the fleet home**: it never writes, renames or deletes
anything there. The captain's actions are deliberately narrow:

- **Terminal peek**: the crew drawer shows the last 80 lines of the worker's
  tmux pane (`tmux capture-pane -p -t <window> -S -80`), refreshed every 2 s,
  with a pause toggle.
- **Message a worker**: a one-line message (max 2000 chars, confirmed in the UI)
  sent with exactly `FM_HOME=<home> <home>/bin/fm-send.sh <window> <message>`.
- **Orders to the first mate**: "Clean up this worker", "Merge its PR",
  "Answer decision…", "Ask for status" and free-text orders are *queued* as JSON
  lines in `~/.ship-deck/orders.jsonl`; Ship Deck never acts on them itself.

Those three commands (plus `tmux list-windows`) are the only ones it runs, always
via `execFile` with a fixed argv. The client only sends a crew id; the tmux
window always comes from `state/<id>.meta`. The only files it writes are in
`~/.ship-deck/` (dir 0700, files 0600).

![Ship Deck rendering the sample fixture fleet](docs/screenshot.png)

*(Screenshot uses the fabricated fixture home in `test/fixtures/home`.)*

## Run

Node 18+ with no install step and no dependencies:

```sh
node server.js                      # reads FM_HOME, default /Users/aryanbhandari/Desktop/AI/firstmate
node server.js --home /path/to/home --port 4747
FM_HOME=/path/to/home node server.js
node server.js --no-tmux            # skip the tmux liveness probe
node server.js --stale-days 14      # stale threshold, default 7 (or SHIP_DECK_STALE_DAYS)
node server.js --orders-dir DIR     # orders queue, default ~/.ship-deck (or SHIP_DECK_ORDERS_DIR)
node server.js --memory-dir DIR     # first mate memory shown in the Ship's Library
```

Open <http://127.0.0.1:4747/>. The server binds to `127.0.0.1` only. The page
polls `GET /api/fleet` every 3 s and animates changes in place (no reload).

Try it on the sample fleet without touching the real one:

```sh
cp -R test/fixtures/home /tmp/ship-deck-sample
node server.js --home /tmp/ship-deck-sample --port 4748
echo "done: sample finished" >> /tmp/ship-deck-sample/state/delta-block.status   # updates within ~3 s
```

## Orders for the first mate

Ship Deck appends `{id, ts, kind, target, text, status:"pending"}` to
`~/.ship-deck/orders.jsonl`. The first mate acknowledges with the CLI, which
appends `{id, ts, status, note}` to `~/.ship-deck/orders-ack.jsonl`; the deck
shows each order's latest status and note on the next poll.

```sh
node bin/orders.js list [--pending] [--json]       # pending = no ack yet
node bin/orders.js ack <id> <acknowledged|done|declined> [note...]
sh bin/orders-check.sh    # prints "ship-deck: N new captain order(s)" or nothing
```

`bin/orders-check.sh` is self-contained POSIX sh + awk, meant to be copied into
firstmate's watcher as a custom wake check. It remembers the newest order id it
has reported in `~/.ship-deck/orders-check.cursor` (ids are time-sortable).
All three honour `SHIP_DECK_ORDERS_DIR`.

## Security

- Binds `127.0.0.1` only; every request must carry `Host: 127.0.0.1:<port>` or
  `localhost:<port>` (blocks DNS rebinding).
- `POST /api/send` and `POST /api/orders` also require `X-Ship-Deck: 1`,
  `Content-Type: application/json`, a same-origin `Origin` when one is sent, and
  no cross-site `Sec-Fetch-Site`. Bodies are capped at 16 KB.
- Action ids must match `^[a-z0-9][a-z0-9-]*$` and have a `state/<id>.meta`;
  the window recorded there must look like `session:window`.
- File views only serve regular files directly under `data/<id>/` (symlinks out
  are refused). The Ship's Library serves only a server-side allow-list (see
  below), addressed by key, never by path.

## Tests

```sh
npm test            # same as: node --test test/*.test.js
```

`test/actions.test.js` covers the orders queue, CLI and wake check (temp
`HOME`), window lookup, peek/send with an injected executor (fm-send is never
run), data-file and library allow-lists, and the CSRF/Host guards.
`test/parsers.test.js` covers the parsers against the fabricated fixtures.
`test/snapshot.test.js` builds a snapshot from a temp copy of the fixture home,
checks missing files and an empty home, proves no file under the home changes
(size + mtime fingerprint), and runs the HTTP server to confirm a `.status`
append shows up in the next `/api/fleet` response.

## What it reads

All paths are relative to the fleet home. Missing files are fine.

| Source | Used for |
| --- | --- |
| `state/<id>.meta` | One crew member per file: `project`, `kind` (ship/scout/secondmate), `mode`, `harness`, `model`, `effort`, `window`, `worktree`, `pr`, `pr_head` |
| `state/<id>.status` | Last line is the displayed state (`resolved` shows as working); the last 5 lines feed the detail drawer. An optional `YYYY-MM-DD HH:MM` prefix and `[key=...]` are parsed; stray non-status lines are skipped. Only the last 64 KB is read. |
| `state/<id>.turn-ended` and file mtimes | "Last activity" and "turn ended" times |
| `state/.afk` | Present means the captain is ashore (away sign on the bridge) |
| `state/.last-watcher-beat` mtime | Watch lamp: green under 2 min, amber otherwise |
| `data/backlog.md` | Loose parse of Captain's Call / In flight / Queued / Done; unknown sections are tolerated. Queued items become crates. Items with `(kind: captain)` or `(hold-kind: captain)` count as Captain's Call. |
| `data/projects.md` | Project display names and delivery modes for deck areas |
| `data/secondmates.md` | Officers' cabins (registry entries without a live meta show as vacant) |
| `data/<id>/brief.md` | First paragraph under `# Task`, one line |
| `data/<id>/report.md` | Existence adds a "Scout report" link (served as plain text by `/api/report/<id>`) |
| `data/<id>/*` | Listed in the drawer; click opens a read-only text view (`/api/file/<id>/<name>`) |
| Ship's Library | `AGENTS.md`, `data/captain.md`, `data/captain-shared.md`, `data/learnings.md`, `data/projects.md`, `data/secondmates.md`, `data/backlog.md`, plus every `*.md` in `--memory-dir` (MEMORY.md first); missing files are shown as missing |
| `tmux list-windows -a` | Optional: marks whether a crew member's window is open. Skipped if tmux is missing. |

## The deck

- **Bridge**: captain (faded with an "ashore" sign when `.afk` exists), the
  first mate at the wheel, and the watch lamp.
- **Deck areas**: one per project, largest first, with a state tally. Within an
  area, crew needing attention come first.
- **Crew states**: working (hauling a line), paused (seated, dozing), needs
  decision (amber flag, pulsing beacon), blocked (red flag and ringing bell),
  done (sea chest packed, waiting for cleanup), failed (red, slumped), no status
  yet (faded). A small dot shows whether the tmux window is open.
- **Stale crew**: any crew member that is not done and has had no activity
  (newest mtime of its `.status`, `.turn-ended` or `.meta`) for more than
  `--stale-days` (default 7) gets a greyed, still avatar and a `stale` tag. Its
  underlying state stays visible on the pill, but it moves out of its state's
  count into a separate **Stale** count and is left out of "Needs the captain".
  Done crew are never stale. A new status line makes it active again on the
  next poll.
- **Officers' cabins**: secondmates, behind portholes.
- **Cargo hold**: queued backlog crates; Captain's Call crates carry a red tag.
- **Command Center**: watch status, counts by state plus Stale (click to
  filter), "Needs the captain" (non-stale decision/blocked/failed crew plus the
  Captain's Call backlog),
  recently done, and PR links.
- **Command Center orders**: a free-text "Order to first mate" box and the
  Orders list (latest status and note, pending count badge).
- **Detail drawer**: click any crew member or crate. `#task=<id>` deep-links.
  Shows PR links (new tab), `data/<id>/` files (read-only viewer), the live
  terminal peek, the message box and the order buttons.
- **Ship's Library** (header button): the first mate's permanent context files,
  rendered as escaped markdown with last-modified times and a filter box.
- **Keyboard**: `/` focuses the search box (or the library filter); `Esc`
  closes the file view, the library or the drawer, or clears the filter.

Follows the OS light/dark theme and respects reduced motion.

## Layout

```
server.js          HTTP server: static files, /api/*, POST guards
lib/fleet.js       Parsers and the read-only snapshot builder
lib/actions.js     Window lookup, pane peek, fm-send, data files (the only exec)
lib/orders.js      Orders queue in ~/.ship-deck
lib/library.js     Ship's Library allow-list
bin/orders.js      Orders CLI for the first mate
bin/orders-check.sh  Watcher wake check (POSIX sh)
public/            index.html, style.css, app.js (no build step)
test/              node:test suites and fabricated fixtures
```
