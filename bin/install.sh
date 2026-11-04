#!/bin/sh
# Installs Ship Deck for one person on their own computer (macOS or Linux), no sudo. One command:
#   curl -fsSL https://raw.githubusercontent.com/aryanbhandari047/ship-deck/main/bin/install.sh | sh
#   - needs Node >= 18 (installed with Homebrew when missing and brew is there); installs missing
#     git, tmux, gh (Homebrew) and the Claude Code CLI (its official installer) when that needs no
#     sudo, else prints the one command to run;
#   - finds the firstmate home (--home, else FM_HOME, else ~/firstmate); when there is none it
#     clones firstmate there ($FIRSTMATE_REPO overrides the URL), adds its private state/, data/
#     and projects/ folders and seeds data/learnings.md with docs/FIRST-MATE.md (so the first mate
#     reads the chat); an existing home is never changed, and a non-empty folder that is not
#     firstmate stops the install;
#   - copies the app into ~/.ship-deck/app, from this checkout, or from a git clone of --from
#     (default: the Ship Deck repo below) when not run from a checkout (e.g. piped from curl);
#   - writes the `ship-deck` launcher into ~/.local/bin and adds ~/.local/bin to PATH in your
#     shell rc file when missing (--no-edit-path to skip);
#   - starts Ship Deck in the background and opens it (--no-start skips; a deck this installer
#     started before is restarted on the new version);
#   - only with --autostart: a macOS LaunchAgent or a systemd user unit;
#   - sharing on by default (the Keychain relay, or --share-relay URL), so teammates' shared skills
#     reach this computer's agent; --no-share turns it off, and the launcher, autostart and later
#     installs remember the choice until --share;
#   - macOS, first install only: "stay awake with the lid closed" (pmset disablesleep, via the
#     `ship-deck awake on` CLI and the terminal's own sudo prompt); asked, on by default,
#     --no-keep-awake skips it, --keep-awake turns it on without asking (also on a re-run).
# Safe to re-run (also how to update): it replaces its own files and nothing else.
#   sh bin/install.sh [--home DIR] [--from GIT_URL] [--autostart] [--no-start] [--share | --share-relay URL | --no-share] [--keep-awake | --no-keep-awake] [--no-edit-path]
#   curl ... | sh -s -- [same flags]
set -eu
# One group, parsed whole before it runs: safe when piped (`curl | sh`) even if a step reads stdin.
{

DEFAULT_REPO=https://github.com/aryanbhandari047/ship-deck.git
DEFAULT_RELAY=https://ship-deck-relay.vercel.app
FIRSTMATE_REPO=${FIRSTMATE_REPO:-https://github.com/kunchenguid/firstmate}
CLAUDE_INSTALLER=https://claude.ai/install.sh

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'ship-deck install: %s\n' "$*" >&2; exit 1; }

usage() {
  say "usage: sh bin/install.sh [--home DIR] [--from GIT_URL] [--autostart] [--no-start] [--share | --share-relay URL | --no-share] [--keep-awake | --no-keep-awake] [--no-edit-path]"
  say "  --home DIR      your firstmate home, set up there when missing (default: \$FM_HOME, else ~/firstmate)"
  say "  --from GIT_URL  install from a fresh clone of this repo instead of this checkout"
  say "                  (default when not run from a checkout: $DEFAULT_REPO)"
  say "  --autostart     also start Ship Deck at login (LaunchAgent on macOS, systemd user unit on Linux)"
  say "  --no-start      do not start Ship Deck now (default: start it in the background and open it)"
  say "  --share         sharing on (the default, $DEFAULT_RELAY): teammates' shared skills reach your agent"
  say "  --share-relay URL  sharing on with another relay"
  say "  --no-share      sharing off; remembered by later installs until --share"
  say "  --keep-awake    macOS: keep the Mac awake with the lid closed, without asking (first install: asked, on by default)"
  say "  --no-keep-awake macOS: leave normal sleep alone (change it later: ship-deck awake on|off)"
  say "  --no-edit-path  do not add ~/.local/bin to PATH in your shell rc file (added by default when missing)"
}

home_flag=
from=
autostart=0
start=1
[ -n "${SHIP_DECK_NO_START:-}" ] && start=0
edit_path=1
share=keep
keep_awake=ask
while [ $# -gt 0 ]; do
  case $1 in
    --home) [ $# -ge 2 ] || die "--home needs a folder"; home_flag=$2; shift ;;
    --home=*) home_flag=${1#--home=} ;;
    --from) [ $# -ge 2 ] || die "--from needs a git URL"; from=$2; shift ;;
    --from=*) from=${1#--from=} ;;
    --autostart) autostart=1 ;;
    --no-start) start=0 ;;
    --share) share=$DEFAULT_RELAY ;;
    --share-relay) [ $# -ge 2 ] || die "--share-relay needs a URL"; share=$2; shift ;;
    --share-relay=*) share=${1#--share-relay=} ;;
    --no-share) share=off ;;
    --keep-awake) keep_awake=1 ;;
    --no-keep-awake) keep_awake=0 ;;
    --edit-path) edit_path=1 ;; # old flag, now the default
    --no-edit-path) edit_path=0 ;;
    -h|--help) usage; exit 0 ;;
    \#*) break ;; # a pasted "# comment" (zsh without interactivecomments): ignore the rest
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

share=${share%/}
if [ "$share" != keep ] && [ "$share" != off ] && ! printf '%s' "$share" | grep -Eq '^(https://[A-Za-z0-9.-]+|http://(127\.0\.0\.1|localhost))(:[0-9]+)?$'; then
  die "the relay must be an https:// address (got $share)"
fi
[ -n "${HOME:-}" ] || die "HOME is not set"
case $(uname -s) in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) die "unsupported system $(uname -s): macOS and Linux only" ;;
esac

# ---------- prerequisites ----------
say "Checking prerequisites"
brew_bin=$(command -v brew 2>/dev/null || true)
node_ok() { [ -n "$node_bin" ] && "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; }
node_bin=$(command -v node 2>/dev/null || true)
if ! node_ok && [ -n "$brew_bin" ]; then
  say "  installing Node.js with Homebrew"
  "$brew_bin" install node </dev/null || warn "brew install node failed"
  hash -r 2>/dev/null || true
  node_bin=$(command -v node 2>/dev/null || true)
fi
if ! node_ok; then
  found=
  [ -n "$node_bin" ] && found="; found $("$node_bin" --version)"
  if [ "$os" = macos ]; then
    die "Node.js 18 or newer is required$found. Install Homebrew (https://brew.sh) and run this again, or get Node from https://nodejs.org"
  fi
  die "Node.js 18 or newer is required$found. Get it from https://nodejs.org (or your package manager) and run this again"
fi
say "  ok    node $("$node_bin" --version)"
has() { command -v "$1" >/dev/null 2>&1 || [ -x "$HOME/.local/bin/$1" ]; }
need=
for c in git tmux gh; do has "$c" || need="$need $c"; done
if [ -n "$need" ] && [ -n "$brew_bin" ]; then
  say "  installing$need with Homebrew"
  # shellcheck disable=SC2086 # one word per tool
  "$brew_bin" install $need </dev/null || warn "brew install$need failed"
fi
if ! has claude && command -v curl >/dev/null 2>&1; then
  say "  installing Claude Code (its official installer, no sudo)"
  curl -fsSL "$CLAUDE_INSTALLER" | bash || warn "the Claude Code installer failed"
fi
# The one command to run for a tool that is still missing.
fix_for() {
  case $1 in
    claude) say "curl -fsSL $CLAUDE_INSTALLER | bash" ;;
    *) if [ -n "$brew_bin" ] || [ "$os" = macos ]; then say "brew install $1"
       elif command -v apt-get >/dev/null 2>&1; then say "sudo apt-get install -y $1"
       elif command -v dnf >/dev/null 2>&1; then say "sudo dnf install -y $1"
       else say "install $1 with your package manager"; fi ;;
  esac
}
missing=
check() { # check <command> <what it is for>
  if has "$1"; then say "  ok    $1"; else say "  MISSING $1 ($2): run  $(fix_for "$1")"; missing="$missing $1"; fi
}
check git "to get firstmate and run worker branches"
check tmux "the workers run in it"
check claude "the Claude Code CLI"
check gh "the GitHub CLI; then run gh auth login"
# Signed in to GitHub? (your first mate opens pull requests with gh)
gh_login=0
if command -v gh >/dev/null 2>&1 && ! gh auth status >/dev/null 2>&1 </dev/null; then gh_login=1; fi
[ "$os" = macos ] && [ -z "$brew_bin" ] && case $missing in *git*|*tmux*|*gh*) say "  (no Homebrew: get it from https://brew.sh first)" ;; esac

# ---------- firstmate home ----------
if [ -n "$home_flag" ]; then home=$home_flag; how="--home"
elif [ -n "${FM_HOME:-}" ]; then home=$FM_HOME; how="FM_HOME"
else home=$HOME/firstmate; how="default"
fi
case $home in "~"/*) home=$HOME/${home#"~/"} ;; esac
is_fm() { [ -f "$1/AGENTS.md" ] && [ -f "$1/bin/fm-spawn.sh" ]; }
if [ -e "$home" ] && [ ! -d "$home" ]; then die "$home ($how) is a file, not a firstmate folder; pass --home DIR to use another folder"; fi
if [ -d "$home" ] && [ -n "$(ls -A "$home" 2>/dev/null)" ] && ! is_fm "$home"; then
  die "$home ($how) is not empty and is not firstmate; it was left as is. Move it away or pass --home DIR for another folder, then run this again"
fi
if ! is_fm "$home"; then
  has git || die "git is needed to set up firstmate: run  $(fix_for git)  then run this again"
  say "Setting up firstmate (the engine that runs your agents) in $home"
  mkdir -p "$(dirname "$home")"
  git clone --quiet "$FIRSTMATE_REPO" "$home" || die "could not clone $FIRSTMATE_REPO into $home"
fi
home=$(cd "$home" && pwd -P)
seed_learnings=0
# Same test as lib/home.js looksLikeHome; a fresh clone lacks its private (git-ignored) folders.
if [ -d "$home/state" ]; then
  say "Firstmate home: $home ($how)"
else
  (umask 077 && mkdir -p "$home/state" "$home/data" "$home/projects")
  seed_learnings=1
  say "Firstmate home: $home ($how, ready)"
fi

# ---------- the app ----------
# Piped from curl, $0 is the shell, not this file: there is no checkout to copy from.
here=
[ -f "$0" ] && here=$(cd "$(dirname "$0")/.." && pwd -P)
is_checkout() { [ -f "$1/server.js" ] && [ -f "$1/package.json" ] && grep -q '"name": *"ship-deck"' "$1/package.json"; }
umask 077
deck=$HOME/.ship-deck
app=$deck/app
mkdir -p "$deck"
chmod 700 "$deck"
tmp=
cleanup() { [ -n "$tmp" ] && rm -rf "$tmp"; return 0; }
trap cleanup EXIT INT TERM
if [ -z "$from" ] && { [ -z "$here" ] || ! is_checkout "$here"; }; then from=$DEFAULT_REPO; fi
if [ -n "$from" ]; then
  command -v git >/dev/null 2>&1 || die "git is needed to install from $from"
  # Kept as ~/.ship-deck/src so `ship-deck update` can fast-forward it; never reset or discarded.
  src=$deck/src
  if [ -e "$src/.git" ] && [ "$(git -C "$src" remote get-url origin 2>/dev/null)" = "$from" ]; then
    say "Updating Ship Deck from $from"
    [ -z "$(git -C "$src" status --porcelain)" ] || die "$src has local changes; it was left as is. Commit or stash them, then run this again"
    GIT_TERMINAL_PROMPT=0 git -C "$src" fetch --quiet </dev/null || die "could not fetch $from (offline?); nothing was changed"
    git -C "$src" merge --ff-only --quiet '@{u}' >/dev/null 2>&1 || die "$src has commits that are not on $from; it was left as is"
  else
    [ -e "$src" ] && die "$src exists but is not a checkout of $from; move it away and run this again"
    tmp=$(mktemp -d "$deck/.install.XXXXXX")
    say "Cloning Ship Deck from $from"
    GIT_TERMINAL_PROMPT=0 git clone --quiet "$from" "$tmp/src" </dev/null || die "could not clone $from (offline?)"
    mv "$tmp/src" "$src"
  fi
  source_label=$src
else
  src=$here
  source_label=$here
fi
# Sharing: the flag given, else what the last install chose (off only after --no-share), else on.
if [ "$share" = keep ]; then
  share=$(sed -n 's/^share_relay=//p' "$app/.ship-deck-install" 2>/dev/null || true)
  [ -n "$share" ] || share=$DEFAULT_RELAY
fi
share=${share%/}
is_checkout "$src" || die "$src is not a Ship Deck checkout (no server.js / package.json named ship-deck)"
if [ -e "$app" ] && [ ! -f "$app/.ship-deck-install" ]; then
  die "$app exists but was not made by this installer; move it away and run this again"
fi
fresh=1
[ -f "$app/.ship-deck-install" ] && fresh=0
stage=$deck/.app.new
rm -rf "$stage"
mkdir -p "$stage"
for f in server.js package.json README.md lib public bin docs; do
  if [ -e "$src/$f" ]; then cp -R "$src/$f" "$stage/$f"; fi
done
rev=
if [ -d "$src/.git" ] || [ -f "$src/.git" ]; then rev=$(git -C "$src" rev-parse --short HEAD 2>/dev/null || true); fi
printf 'source=%s\nrevision=%s\nshare_relay=%s\n' "$source_label" "$rev" "$share" > "$stage/.ship-deck-install"
rm -rf "$app"
mv "$stage" "$app"
say "Installed Ship Deck in $app${rev:+ (revision $rev)}"

# A fresh home learns the chat contract from its first session; an existing one is only told how.
teach=
if [ "$seed_learnings" = 1 ] && [ ! -e "$home/data/learnings.md" ]; then
  (umask 077 && cp "$app/docs/FIRST-MATE.md" "$home/data/learnings.md")
  say "Taught your first mate to read Ship Deck messages ($home/data/learnings.md)"
elif ! grep -qis 'ship-deck' "$home/data/learnings.md" "$home/data/captain.md" 2>/dev/null; then
  teach="Read ~/.ship-deck/app/docs/FIRST-MATE.md and add it to data/learnings.md"
fi

# ---------- launcher ----------
bindir=$HOME/.local/bin
launcher=$bindir/ship-deck
mkdir -p "$bindir"
fm_line=
# A non-default home is remembered so the launcher and autostart find it without flags;
# FM_HOME, --home and a firstmate folder as the current directory still win.
if [ "$home" != "$HOME/firstmate" ]; then
  fm_line="[ -n \"\${FM_HOME:-}\" ] || case \" \$* \" in *' --home'*) ;; *) [ -f ./bin/fm-spawn.sh ] || { FM_HOME='$home'; export FM_HOME; } ;; esac"
fi
share_line=
# SHIP_DECK_SHARE in the environment (even empty) still wins, so one run can skip sharing.
if [ "$share" != off ]; then
  share_line="[ -n \"\${SHIP_DECK_SHARE+x}\" ] || { SHIP_DECK_SHARE=1; SHIP_DECK_RELAY=\${SHIP_DECK_RELAY:-'$share'}; export SHIP_DECK_SHARE SHIP_DECK_RELAY; }"
fi
cat > "$launcher.tmp" <<EOF
#!/bin/sh
# Ship Deck launcher, written by bin/install.sh (re-run it to update; do not edit).
# Same flags as \`node server.js\` (ship-deck --help). The firstmate home is auto-detected:
# --home, then FM_HOME, then the current folder, then ~/firstmate.
node='$node_bin'
[ -x "\$node" ] || node=node
${fm_line}
${share_line}
[ "\${1:-}" = update ] && { shift; exec sh '$app/bin/update.sh' "\$@"; }
# A deck already running on this home is opened instead of starting a second one.
SHIP_DECK_REUSE=1; export SHIP_DECK_REUSE
exec "\$node" '$app/server.js' "\$@"
EOF
chmod 755 "$launcher.tmp"
mv "$launcher.tmp" "$launcher"
say "Launcher: $launcher"

on_path=0
case ":${PATH:-}:" in *":$bindir:"*) on_path=1 ;; esac
path_line='export PATH="$HOME/.local/bin:$PATH"'
if [ "$on_path" = 0 ]; then
  if [ "$edit_path" = 1 ]; then
    case $(basename "${SHELL:-sh}") in
      zsh) rc=$HOME/.zshrc ;;
      bash) if [ "$os" = macos ]; then rc=$HOME/.bash_profile; else rc=$HOME/.bashrc; fi ;;
      *) rc=$HOME/.profile ;;
    esac
    if [ -f "$rc" ] && grep -qF '# added by ship-deck install' "$rc"; then
      say "PATH line already in $rc (open a new terminal)"
    else
      printf '\n%s  # added by ship-deck install\n' "$path_line" >> "$rc"
      say "Added ~/.local/bin to PATH in $rc (open a new terminal)"
    fi
  elif [ -z "${SHIP_DECK_UPDATING:-}" ]; then
    warn "$bindir is not on your PATH. Add this line to your shell rc file (or re-run without --no-edit-path):"
    warn "  $path_line"
  fi
fi

# ---------- stay awake with the lid closed (macOS) ----------
# First install: asked, on by default. Re-runs leave the user's choice alone unless --keep-awake.
awake_cli() { "$node_bin" "$app/server.js" awake "$@"; }
awake_note=
if [ "$os" = macos ]; then
  if [ "$keep_awake" = ask ] && [ "$fresh" = 0 ]; then keep_awake=0; fi
  # The terminal to ask on (SHIP_DECK_TTY: tests feed an answer file instead).
  tty=${SHIP_DECK_TTY:-/dev/tty}
  tty_ok=0
  (: <"$tty") 2>/dev/null && tty_ok=1
  if [ "$keep_awake" = ask ]; then
    say "Stay awake with the lid closed: your Mac keeps your agents running when you close the lid (macOS may ask for your password once)."
    if [ "$tty_ok" = 1 ]; then
      printf '  Enter to keep, n to skip: '
      ans=
      read -r ans <"$tty" || ans=
      case $ans in [nN]*) keep_awake=0 ;; *) keep_awake=1 ;; esac
    else
      keep_awake=1
    fi
  fi
  if [ "$keep_awake" = 1 ]; then
    # With a terminal: its sudo prompt; without one: the native macOS dialog.
    if [ "$tty_ok" = 1 ]; then awake_cli on <"$tty" || warn "could not turn it on; later: ship-deck awake on"
    else awake_cli on </dev/null || warn "could not turn it on; later: ship-deck awake on"; fi
  fi
  if awake_cli status 2>/dev/null | grep -q ': on$'; then
    awake_note="on: turn it off in Settings > You or with  ship-deck awake off"
  else
    awake_note="off (ship-deck awake on keeps the Mac awake with the lid closed)"
  fi
fi

# ---------- stop decks running from this install, so the new version starts ----------
# Every node process running $app/server.js: the one start.sh recorded, a foreground one, or
# one from an install made before start.sh kept a pid file.
restarted=0
if [ "$start" = 1 ]; then
  for old in $(ps -ax -o pid=,command= 2>/dev/null | grep -F "$app/server.js" | grep -v grep | awk '{print $1}'); do
    [ "$old" = "$$" ] && continue
    kill "$old" 2>/dev/null || continue
    i=0
    while kill -0 "$old" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
    restarted=1
  done
  rm -f "$deck/server.pid"
fi

# ---------- autostart (only when asked) ----------
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
if [ "$autostart" = 1 ]; then
  if [ "$os" = macos ]; then
    agents=$HOME/Library/LaunchAgents
    plist=$agents/local.ship-deck.plist
    mkdir -p "$agents"
    path_env="$(dirname "$node_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by Ship Deck's bin/install.sh (autostart). Remove with:
     launchctl bootout gui/\$(id -u)/local.ship-deck; rm this file -->
<plist version="1.0">
<dict>
  <key>Label</key><string>local.ship-deck</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$(xml_escape "$app/bin/start.sh")</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$path_env")</string>
    <key>FM_HOME</key><string>$(xml_escape "$home")</string>
  </dict>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
    chmod 644 "$plist"
    uid=$(id -u)
    launchctl bootout "gui/$uid/local.ship-deck" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$uid" "$plist"; then
      say "Autostart: $plist (loaded; Ship Deck now starts at login)"
    else
      warn "wrote $plist but launchctl could not load it; run: launchctl bootstrap gui/$uid '$plist'"
    fi
  else
    units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
    unit=$units/ship-deck.service
    mkdir -p "$units"
    cat > "$unit" <<EOF
# Written by Ship Deck's bin/install.sh --autostart. Remove with:
#   systemctl --user disable --now ship-deck.service; rm this file
[Unit]
Description=Ship Deck (local firstmate GUI on 127.0.0.1)

[Service]
Type=simple
Environment=FM_HOME=$home
ExecStart=$launcher --no-open
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    chmod 644 "$unit"
    if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload && systemctl --user enable --now ship-deck.service; then
      say "Autostart: $unit (enabled; Ship Deck now starts at login)"
    else
      warn "wrote $unit but could not enable it; run: systemctl --user daemon-reload && systemctl --user enable --now ship-deck.service"
    fi
  fi
fi

# ---------- start it now ----------
open_url() {
  [ -n "${SHIP_DECK_NO_OPEN:-}" ] && return 0
  if [ "$os" = macos ]; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true; fi
}
# The first deck answering in the port range (start.sh scans the same way).
probe() {
  p=${SHIP_DECK_PORT:-4747}
  while [ "$p" -lt $((${SHIP_DECK_PORT:-4747} + 20)) ]; do
    if curl -s --max-time 1 "http://127.0.0.1:$p/api/health" 2>/dev/null | grep -q '"app":"ship-deck"'; then
      echo "http://127.0.0.1:$p/"; return 0
    fi
    p=$((p + 1))
  done
  return 1
}
url=
running_old=0
if [ "$start" = 1 ]; then
  if [ "$autostart" = 1 ]; then
    # The login service starts it; wait up to 5 s for it to answer.
    i=0
    while [ $i -lt 25 ] && ! url=$(probe); do sleep 0.2; i=$((i + 1)); done
    [ -n "$url" ] && open_url "$url"
  else
    out=$(sh "$app/bin/start.sh" --home "$home" 2>&1 || true)
    url=$(printf '%s\n' "$out" | sed -n 's/.*\(http:\/\/127\.0\.0\.1:[0-9]*\/\).*/\1/p' | head -n 1)
    case $out in *"already running"*) running_old=1; open_url "$url" ;; esac
    [ -n "$url" ] || warn "Ship Deck did not answer yet: $out"
  fi
fi

# ---------- summary ----------
gt() { case $1 in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }
say ""
if [ -n "$url" ]; then
  if [ "$running_old" = 1 ]; then
    say "Ship Deck is already running at $url (restart it to use this version)."
  else
    if [ "$restarted" = 1 ]; then say "Ship Deck is running at $url (restarted on this version)"
    else say "Ship Deck is running at $url"; fi
    [ -n "${SHIP_DECK_NO_OPEN:-}" ] || say "  (opened in your browser)"
  fi
else
  say "Ship Deck is installed. Start it with:  ship-deck"
fi
if [ -n "${SHIP_DECK_UPDATING:-}" ]; then
  [ -n "$url" ] || [ "$start" = 0 ] || warn "Ship Deck did not restart; start it with: ship-deck"
  exit 0
fi
say ""
say "Try these first:"
say "  1. Start your first mate in a new terminal:  cd $(gt "$home") && claude"
say "  2. Say hello in the chat on the deck. Your first mate answers there."
say "  3. Ask it for work in plain words, e.g. \"add github.com/you/app and fix the login bug\"."
say "     Workers show up on the board; anything that needs you rises to Needs you."
todo=
[ -n "$missing" ] && todo="$todo
  - install$missing (commands above)"
[ "$gh_login" = 1 ] && todo="$todo
  - gh auth login   (your first mate opens pull requests with it)"
[ -n "$teach" ] && todo="$todo
  - tell your first mate once: \"$teach\""
[ "$on_path" = 0 ] && todo="$todo
  - open a new terminal so the ship-deck command is found"
if [ -n "$todo" ]; then
  say ""
  say "Before you start:$todo"
fi
say ""
say "Reopen it any time: ship-deck. Update: ship-deck update (or the Update button in the deck)."
if [ "$share" != off ]; then
  say "Sharing: on ($share); nothing is sent until you sign in (More > Share your deck). --no-share turns it off."
else
  say "Sharing: off (re-run with --share to receive teammates' skills)."
fi
[ -n "$awake_note" ] && say "Lid closed, stay awake: $awake_note"
say "Guide: $(gt "$app")/docs/TEAMMATE-SETUP.md"
}
