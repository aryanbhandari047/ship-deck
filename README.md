# Ship Deck

**One live board for your fleet of AI coding agents: see who needs you, answer
them, and talk to the agent running the fleet, all from your browser.**

## Why you'd want it

Running many AI coding workers at once quickly turns into terminal juggling.
Ship Deck fixes that:

- **No more tab-hopping.** Every worker is on one board instead of spread over
  a dozen tmux windows.
- **Know who needs you.** Workers waiting on a decision, blocked or failed rise
  to a **Needs you** column; the rest sit under **Working**, **Waiting** or
  **Done**.
- **Answer without a terminal.** Pick a worker's option or type a reply right
  on its card. Merge, clean up or start new work with one click.
- **See what's happening.** A live peek at each worker's terminal and a feed of
  what the orchestrating agent is doing right now.

## What it does

- **Board**: every worker grouped by what it needs from you, with the task
  title, latest update, pull request and tool. Filter by project or search.
- **Ship view**: the same fleet drawn as a nautical chart, one berth per worker
  flying its status flag.
- **Chat with the first mate**: send messages and read its markdown replies.
  Paste, drop or attach screenshots and screen recordings; videos are turned
  into stills the agent can read.
- **One-click actions**: answer a decision, ask for status, merge a PR, clean
  up one or all finished workers, start a new job or a queued item. Each is a
  message the first mate acts on (and confirms anything irreversible); Ship
  Deck never does these itself.
- **Worker details**: the live terminal (last 80 lines, with colours), every
  status update, the brief and data files, a direct one-line message to the
  worker, and the command to resume its Claude Code session.
- **Per-worker model and effort**: switch a Claude worker's model or effort
  live from an allow-list; other tools get it on relaunch.
- **Library**: the first mate's context files, memory and skills, rendered as
  readable pages.
- **Activity feed**: the first mate's tool calls and replies, live from its
  own transcript.
- **Read-only sharing** (opt-in): let a teammate watch your board through a
  relay, with secrets scrubbed and every view logged. Shared skills and notes
  can flow into their own agent as read-only skills.
- **Comfort**: status is a signal flag, a colour and a word (readable without
  colour); light and dark themes that pass WCAG AA; keyboard shortcuts (press
  `?`); browser notifications on request.

## Screenshots

![The Board: Needs you, Working, Waiting and Done, with the chat beside it](docs/screenshot.png)

![A worker that needs you: the decision on top and the live terminal](docs/decision.png)

![The Ship view: the same fleet as a nautical chart](docs/ship.png)

*(Screenshots use the fabricated sample fleet in `test/fixtures/home`.)*

## Quick start

You need **Node.js 18+**, **git**, **tmux**, the **Claude Code** and **GitHub**
CLIs, and a [firstmate](https://github.com/kunchenguid/firstmate) home
(ideally at `~/firstmate`).

```sh
git clone https://github.com/aryanbhandari047/ship-deck.git ~/ship-deck
sh ~/ship-deck/bin/install.sh     # macOS/Linux, no sudo, safe to re-run
ship-deck                         # opens http://127.0.0.1:4747/
```

The installer checks the prerequisites, copies the app to `~/.ship-deck/app`
and adds a `ship-deck` launcher to `~/.local/bin`. Add `--autostart` to start
it at login, or `--home DIR` if your firstmate lives elsewhere.

Without the installer, run it straight from the clone: `npx .` or
`node server.js --home ~/firstmate`.

Try it on the sample fleet first, without touching a real one:

```sh
cp -R test/fixtures/home /tmp/ship-deck-sample
node server.js --home /tmp/ship-deck-sample --orders-dir /tmp/ship-deck-orders
```

- Full setup, including firstmate and teaching your first mate to read the
  chat: [docs/TEAMMATE-SETUP.md](docs/TEAMMATE-SETUP.md)
- Flags, home detection, the message contract, sharing, security and more:
  [docs/REFERENCE.md](docs/REFERENCE.md)
- Letting other agents read a shared library: [docs/AGENT-LIBRARY.md](docs/AGENT-LIBRARY.md)

## How it works

Ship Deck is a small Node server that runs on your own machine and listens on
`127.0.0.1` only. It reads your firstmate home (worker records, queue,
projects, briefs) and the first mate's Claude Code transcripts read-only, and
polls every 3 seconds. Your messages go to `~/.ship-deck/` as an append-only
log the first mate reads and answers, plus a one-line wake signal in its
`state/` folder. The only commands it runs are `tmux list-windows`,
`tmux capture-pane` and firstmate's own `fm-send.sh`. There are no
dependencies and no build step. Nothing leaves your machine unless you turn on
sharing with `--share`.

## Inspiration

Ship Deck is built for and inspired by
[**firstmate**](https://github.com/kunchenguid/firstmate), the orchestration
layer it runs on: firstmate's first mate dispatches and supervises the coding
workers, and Ship Deck is the captain's view of that fleet.

## Tests

```sh
npm test
```
