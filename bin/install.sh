#!/bin/sh
# Installs Ship Deck for one person on their own computer (macOS or Linux), no sudo:
#   - checks Node >= 18 (required), git, tmux, the Claude Code CLI and the GitHub CLI (warned);
#   - checks for a firstmate home (--home, else FM_HOME, else ~/firstmate) and prints the clone
#     command when there is none (it never clones firstmate itself);
#   - copies the app into ~/.ship-deck/app, from this checkout, or from a git clone of --from
#     (default: the Ship Deck repo below) when not run from a checkout;
#   - writes the `ship-deck` launcher into ~/.local/bin (warns when that is not on PATH);
#   - only with --autostart: a macOS LaunchAgent or a systemd user unit;
#   - only with --edit-path: adds ~/.local/bin to PATH in your shell rc file.
# Safe to re-run: it replaces its own files and nothing else.
#   sh bin/install.sh [--home DIR] [--from GIT_URL] [--autostart] [--edit-path]
set -eu

DEFAULT_REPO=https://github.com/aryanbhandari047/ship-deck.git
FIRSTMATE_REPO=https://github.com/kunchenguid/firstmate

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'ship-deck install: %s\n' "$*" >&2; exit 1; }

usage() {
  say "usage: sh bin/install.sh [--home DIR] [--from GIT_URL] [--autostart] [--edit-path]"
  say "  --home DIR      your firstmate home (default: \$FM_HOME, else ~/firstmate)"
  say "  --from GIT_URL  install from a fresh clone of this repo instead of this checkout"
  say "                  (default when not run from a checkout: $DEFAULT_REPO)"
  say "  --autostart     also start Ship Deck at login (LaunchAgent on macOS, systemd user unit on Linux)"
  say "  --edit-path     add ~/.local/bin to PATH in your shell rc file if it is missing"
}

home_flag=
from=
autostart=0
edit_path=0
while [ $# -gt 0 ]; do
  case $1 in
    --home) [ $# -ge 2 ] || die "--home needs a folder"; home_flag=$2; shift ;;
    --home=*) home_flag=${1#--home=} ;;
    --from) [ $# -ge 2 ] || die "--from needs a git URL"; from=$2; shift ;;
    --from=*) from=${1#--from=} ;;
    --autostart) autostart=1 ;;
    --edit-path) edit_path=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

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
missing=
check() { # check <command> <what it is for>
  if command -v "$1" >/dev/null 2>&1; then say "  ok    $1"; else say "  MISSING $1 ($2)"; missing="$missing $1"; fi
}
check git "firstmate and worker branches"
check tmux "firstmate runs its workers in tmux"
check claude "the Claude Code CLI: https://docs.claude.com/en/docs/claude-code"
check gh "the GitHub CLI: https://cli.github.com, then gh auth login"

# ---------- firstmate home ----------
if [ -n "$home_flag" ]; then home=$home_flag; how="--home"
elif [ -n "${FM_HOME:-}" ]; then home=$FM_HOME; how="FM_HOME"
else home=$HOME/firstmate; how="default"
fi
case $home in "~"/*) home=$HOME/${home#"~/"} ;; esac
if [ -d "$home" ]; then home=$(cd "$home" && pwd -P); fi
# Same test as lib/home.js looksLikeHome.
if [ -f "$home/AGENTS.md" ] && [ -f "$home/bin/fm-spawn.sh" ] && [ -d "$home/state" ]; then
  home_ok=1
  say "Firstmate home: $home ($how)"
else
  home_ok=0
  say "No firstmate home at $home ($how)."
  if [ "$how" = default ]; then
    say "  Get firstmate with:"
    say "    git clone $FIRSTMATE_REPO ~/firstmate"
  else
    say "  Get firstmate with:"
    say "    git clone $FIRSTMATE_REPO '$home'"
  fi
  say "  then follow its README to start your first mate. Ship Deck installs anyway and shows"
  say "  its first-run screen until the folder exists."
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
printf 'source=%s\nrevision=%s\n' "$source_label" "$rev" > "$stage/.ship-deck-install"
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
if [ "$home_ok" = 1 ] && [ "$home" != "$HOME/firstmate" ]; then
  fm_line="[ -n \"\${FM_HOME:-}\" ] || case \" \$* \" in *' --home'*) ;; *) [ -f ./bin/fm-spawn.sh ] || { FM_HOME='$home'; export FM_HOME; } ;; esac"
fi
cat > "$launcher.tmp" <<EOF
#!/bin/sh
# Ship Deck launcher, written by bin/install.sh (re-run it to update; do not edit).
# Same flags as \`node server.js\` (ship-deck --help). The firstmate home is auto-detected:
# --home, then FM_HOME, then the current folder, then ~/firstmate.
node='$node_bin'
[ -x "\$node" ] || node=node
${fm_line}
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
    warn "$bindir is not on your PATH. Add this line to your shell rc file (or re-run with --edit-path):"
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
  say "Still to install before firstmate can run:$missing"
fi
[ "$home_ok" = 1 ] || say "Then clone firstmate (above)."
say "Start Ship Deck with:  ship-deck        (opens http://127.0.0.1:4747/; Ctrl+C stops it)"
say "In the background:     sh $app/bin/start.sh"
say "Guide: $app/docs/TEAMMATE-SETUP.md"
say "Already running? Restart it to use this version."
