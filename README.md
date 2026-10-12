# Ship Deck

A local, live GUI of the firstmate fleet, drawn as a top-down ship deck. Every
in-flight task is a crew member at a deck station; the bridge shows the captain,
the first mate at the helm and the watch lamp; queued backlog items sit in the
cargo hold as crates. Inspired by [Munder Difflin](https://github.com/HarnessMD/munder-difflin).

It is **read-only**: it never writes, renames or deletes anything in the fleet
home, never sends tmux keys, and never runs firstmate `bin/` scripts.

![Ship Deck rendering the sample fixture fleet](docs/screenshot.png)

*(Screenshot uses the fabricated fixture home in `test/fixtures/home`.)*

## Run

Node 18+ with no install step and no dependencies:

```sh
node server.js                      # reads FM_HOME, default /Users/aryanbhandari/Desktop/AI/firstmate
node server.js --home /path/to/home --port 4747
FM_HOME=/path/to/home node server.js
node server.js --no-tmux            # skip the tmux liveness probe
```

Open <http://127.0.0.1:4747/>. The server binds to `127.0.0.1` only. The page
polls `GET /api/fleet` every 3 s and animates changes in place (no reload).

Try it on the sample fleet without touching the real one:

```sh
cp -R test/fixtures/home /tmp/ship-deck-sample
node server.js --home /tmp/ship-deck-sample --port 4748
echo "done: sample finished" >> /tmp/ship-deck-sample/state/delta-block.status   # updates within ~3 s
```

## Tests

```sh
npm test            # same as: node --test test/*.test.js
```

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
- **Officers' cabins**: secondmates, behind portholes.
- **Cargo hold**: queued backlog crates; Captain's Call crates carry a red tag.
- **Command Center**: watch status, counts by state (click to filter), "Needs
  the captain" (decision/blocked/failed crew plus the Captain's Call backlog),
  recently done, and PR links.
- **Detail drawer**: click any crew member or crate. `#task=<id>` deep-links.
- **Filter**: `/` focuses the search box (matches id, project, state, kind,
  mode, brief); `Esc` closes the drawer or clears the filter.

Follows the OS light/dark theme and respects reduced motion.

## Layout

```
server.js          HTTP server: static files, /api/fleet, /api/report/<id>
lib/fleet.js       Parsers and the read-only snapshot builder
public/            index.html, style.css, app.js (no build step)
test/              node:test suites and fabricated fixtures
```
