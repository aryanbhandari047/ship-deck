#!/bin/sh
# Installs Ship Deck for one person on their own computer (macOS or Linux), no sudo:
#   - checks Node >= 18 (required); installs missing git, tmux, gh (Homebrew) and the Claude Code
#     CLI (its official installer) when that needs no sudo, else prints the one command to run;
#   - finds the firstmate home (--home, else FM_HOME, else ~/firstmate); when there is none it
#     clones firstmate there ($FIRSTMATE_REPO overrides the URL) and adds its private state/,
#     data/ and projects/ folders; an existing home is never changed, and a non-empty folder
#     that is not firstmate stops the install;
#   - copies the app into ~/.ship-deck/app, from this checkout, or from a git clone of --from
#     (default: the Ship Deck repo below) when not run from a checkout;
#   - writes the `ship-deck` launcher into ~/.local/bin (warns when that is not on PATH);
#   - only with --autostart: a macOS LaunchAgent or a systemd user unit;
#   - with --share (or --share-relay URL): starts with sharing on, so teammates' shared skills reach
#     this computer's agent; the launcher and autostart remember it until --no-share;
#   - adds ~/.local/bin to PATH in your shell rc file when missing (--no-edit-path to skip).
# Safe to re-run: it replaces its own files and nothing else.
#   sh bin/install.sh [--home DIR] [--from GIT_URL] [--autostart] [--share | --share-relay URL | --no-share] [--no-edit-path]
set -eu

DEFAULT_REPO=https://github.com/aryanbhandari047/ship-deck.git
DEFAULT_RELAY=https://ship-deck-relay.vercel.app
FIRSTMATE_REPO=${FIRSTMATE_REPO:-https://github.com/kunchenguid/firstmate}
CLAUDE_INSTALLER=https://claude.ai/install.sh

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'ship-deck install: %s\n' "$*" >&2; exit 1; }

usage() {
  say "usage: sh bin/install.sh [--home DIR] [--from GIT_URL] [--autostart] [--share | --share-relay URL | --no-share] [--no-edit-path]"
  say "  --home DIR      your firstmate home, set up there when missing (default: \$FM_HOME, else ~/firstmate)"
  say "  --from GIT_URL  install from a fresh clone of this repo instead of this checkout"
  say "                  (default when not run from a checkout: $DEFAULT_REPO)"
  say "  --autostart     also start Ship Deck at login (LaunchAgent on macOS, systemd user unit on Linux)"
  say "  --share         start with sharing on ($DEFAULT_RELAY): teammates' shared skills reach your agent"
  say "  --share-relay URL  the same with another relay; both are remembered until --no-share"
  say "  --no-edit-path  do not add ~/.local/bin to PATH in your shell rc file (added by default when missing)"
}

home_flag=
from=
autostart=0
edit_path=1
share=keep
while [ $# -gt 0 ]; do
  case $1 in
    --home) [ $# -ge 2 ] || die "--home needs a folder"; home_flag=$2; shift ;;
    --home=*) home_flag=${1#--home=} ;;
    --from) [ $# -ge 2 ] || die "--from needs a git URL"; from=$2; shift ;;
    --from=*) from=${1#--from=} ;;
    --autostart) autostart=1 ;;
    --share) share=$DEFAULT_RELAY ;;
    --share-relay) [ $# -ge 2 ] || die "--share-relay needs a URL"; share=$2; shift ;;
    --share-relay=*) share=${1#--share-relay=} ;;
    --no-share) share= ;;
    --edit-path) edit_path=1 ;; # old flag, now the default
    --no-edit-path) edit_path=0 ;;
    -h|--help) usage; exit 0 ;;
    \#*) break ;; # a pasted "# comment" (zsh without interactivecomments): ignore the rest
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

share=${share%/}
if [ "$share" != keep ] && [ -n "$share" ] && ! printf '%s' "$share" | grep -Eq '^(https://[A-Za-z0-9.-]+|http://(127\.0\.0\.1|localhost))(:[0-9]+)?$'; then
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
node_bin=$(command -v node 2>/dev/null || true)
[ -n "$node_bin" ] || die "Node.js 18 or newer is required (https://nodejs.org); install it and run this again"
"$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || die "Node.js 18 or newer is required; found $("$node_bin" --version)"
say "  ok    node $("$node_bin" --version)"
has() { command -v "$1" >/dev/null 2>&1 || [ -x "$HOME/.local/bin/$1" ]; }
brew_bin=$(command -v brew 2>/dev/null || true)
need=
for c in git tmux gh; do has "$c" || need="$need $c"; done
if [ -n "$need" ] && [ -n "$brew_bin" ]; then
  say "  installing$need with Homebrew"
  # shellcheck disable=SC2086 # one word per tool
  "$brew_bin" install $need || warn "brew install$need failed"
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
# Same test as lib/home.js looksLikeHome; a fresh clone lacks its private (git-ignored) folders.
if [ -d "$home/state" ]; then
  say "Firstmate home: $home ($how)"
else
  (umask 077 && mkdir -p "$home/state" "$home/data" "$home/projects")
  say "Firstmate home: $home ($how, ready)"
fi

# ---------- the app ----------
here=$(cd "$(dirname "$0")/.." && pwd -P)
is_checkout() { [ -f "$1/server.js" ] && [ -f "$1/package.json" ] && grep -q '"name": *"ship-deck"' "$1/package.json"; }
umask 077
deck=$HOME/.ship-deck
app=$deck/app
mkdir -p "$deck"
chmod 700 "$deck"
tmp=
cleanup() { [ -n "$tmp" ] && rm -rf "$tmp"; return 0; }
trap cleanup EXIT INT TERM
if [ -z "$from" ] && ! is_checkout "$here"; then from=$DEFAULT_REPO; fi
if [ -n "$from" ]; then
  command -v git >/dev/null 2>&1 || die "git is needed to install from $from"
  tmp=$(mktemp -d "$deck/.install.XXXXXX")
  say "Cloning Ship Deck from $from"
  git clone --quiet --depth 1 "$from" "$tmp/src" || die "could not clone $from (were you added as a collaborator? is gh auth login done?)"
  src=$tmp/src
  source_label=$from
else
  src=$here
  source_label=$here
fi
# Sharing: the relay from --share/--share-relay, none with --no-share, else what the last install chose.
if [ "$share" = keep ]; then
  share=$(sed -n 's/^share_relay=//p' "$app/.ship-deck-install" 2>/dev/null || true)
fi
share=${share%/}
is_checkout "$src" || die "$src is not a Ship Deck checkout (no server.js / package.json named ship-deck)"
if [ -e "$app" ] && [ ! -f "$app/.ship-deck-install" ]; then
  die "$app exists but was not made by this installer; move it away and run this again"
fi
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
if [ -n "$share" ]; then
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
  else
    warn "$bindir is not on your PATH. Add this line to your shell rc file (or re-run without --no-edit-path):"
    warn "  $path_line"
  fi
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

# ---------- summary ----------
say ""
if [ -n "$missing" ]; then
  say "Still to install before your agents can run:$missing (commands above)"
fi
say "Start Ship Deck with:  ship-deck        (opens http://127.0.0.1:4747/; Ctrl+C stops it)"
say "Your first mate:       cd '$home' && claude   (Ship Deck's chat reaches it while it runs)"
say "In the background:     sh $app/bin/start.sh"
if [ -n "$share" ]; then
  say "Sharing:               on ($share); sign in under Settings > Sharing"
else
  say "Sharing:               off (re-run with --share to receive teammates' skills)"
fi
say "Guide: $app/docs/TEAMMATE-SETUP.md"
say "Already running? Restart it to use this version."
