#!/bin/sh
# Updates an installed Ship Deck: `ship-deck update` (or sh ~/.ship-deck/app/bin/update.sh).
#   - fast-forwards the install's source checkout (the clone it was installed from, or
#     ~/.ship-deck/src); local changes or a diverged branch stop it and nothing is changed;
#     it never resets or discards anything;
#   - re-runs that checkout's installer with the choices already made (sharing, keep-awake,
#     PATH, autostart, home), without questions;
#   - restarts the deck if one was running from this install; prints old -> new and what changed.
# The deck's Update button runs this same script.
set -eu
{
say() { printf '%s\n' "$*"; }
die() { printf 'ship-deck update: %s\n' "$*" >&2; exit 1; }

app=$(cd "$(dirname "$0")/.." && pwd -P)
deck=$(dirname "$app")
rec=$app/.ship-deck-install
[ -f "$rec" ] || die "$app was not set up by the installer; install with: curl -fsSL https://raw.githubusercontent.com/aryanbhandari047/ship-deck/main/bin/install.sh | sh"
command -v git >/dev/null 2>&1 || die "git is needed to update"
field() { sed -n "s/^$1=//p" "$rec" | head -n 1; }
version() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n 1; }
source=$(field source)
old=$(field revision)
old_version=$(version "$app")

if [ -n "$source" ] && [ -e "$source/.git" ]; then src=$source
elif [ -e "$deck/src/.git" ]; then src=$deck/src
else
  # Installed before updates existed: keep a checkout of its source from now on.
  case $source in ''|/*) die "no git checkout to update from; run the install command again" ;; esac
  [ -e "$deck/src" ] && die "$deck/src exists but is not a git checkout; move it away and run this again"
  say "Getting Ship Deck from $source"
  GIT_TERMINAL_PROMPT=0 git clone --quiet "$source" "$deck/src" </dev/null || die "could not clone $source (offline?)"
  src=$deck/src
fi

[ -z "$(git -C "$src" status --porcelain 2>/dev/null)" ] \
  || die "$src has local changes. Nothing was changed: commit or stash them, then run ship-deck update again"
git -C "$src" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 \
  || die "$src is on a branch with no remote branch to update from. Nothing was changed"
say "Checking for updates ($src)"
GIT_TERMINAL_PROMPT=0 git -C "$src" fetch --quiet </dev/null || die "could not reach the remote (offline?). Nothing was changed"
git -C "$src" merge --ff-only --quiet '@{u}' >/dev/null 2>&1 \
  || die "$src has commits that are not on its remote branch, so it cannot fast-forward. It was left as is: merge or rebase it yourself, then run ship-deck update again"
head=$(git -C "$src" rev-parse HEAD)
if [ -n "$old" ] && [ "$(git -C "$src" rev-parse --verify --quiet "$old^{commit}" 2>/dev/null || true)" = "$head" ]; then
  say "Already up to date: Ship Deck ${old_version:-?} ($old)."
  exit 0
fi

# The deck running from this install: the one start.sh recorded, or one answering in the port range.
is_ours() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && ps -p "$1" -o command= 2>/dev/null | grep -qF "$app/server.js"; }
running=
pid=$(cat "$deck/server.pid" 2>/dev/null || true)
is_ours "$pid" && running=$pid
if [ -z "$running" ] && command -v curl >/dev/null 2>&1; then
  p=${SHIP_DECK_PORT:-4747}
  while [ "$p" -lt $((${SHIP_DECK_PORT:-4747} + 20)) ]; do
    pid=$(curl -s --max-time 1 "http://127.0.0.1:$p/api/health" 2>/dev/null | sed -n 's/.*"app":"ship-deck".*"pid":\([0-9]*\).*/\1/p')
    if is_ours "$pid"; then running=$pid; break; fi
    p=$((p + 1))
  done
fi
if [ -n "$running" ]; then
  kill "$running" 2>/dev/null || true
  i=0
  while kill -0 "$running" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
fi

# Same choices as before: no PATH edit, no questions; started again only if it was running.
start_flag=--no-start
[ -n "$running" ] && start_flag=
# shellcheck disable=SC2086 # empty or one flag
SHIP_DECK_UPDATING=1 SHIP_DECK_NO_OPEN=1 SHIP_DECK_TTY=/dev/null sh "$src/bin/install.sh" --no-edit-path $start_flag </dev/null \
  || die "the installer failed (output above); your previous version is still in $app unless it says otherwise"

new=$(git -C "$src" rev-parse --short HEAD)
say ""
say "Updated Ship Deck ${old_version:-?} (${old:-unknown}) -> $(version "$src") ($new)"
range=$head
[ -n "$old" ] && git -C "$src" rev-parse --verify --quiet "$old^{commit}" >/dev/null 2>&1 && range="$old..$head"
say "What changed:"
git -C "$src" log --no-decorate --format='  %h %s' -n 15 "$range" 2>/dev/null || true
[ -n "$running" ] || say "Start it with: ship-deck"
}
