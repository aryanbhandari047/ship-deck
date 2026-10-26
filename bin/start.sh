#!/bin/sh
# Starts Ship Deck in the background unless it already answers on its port range, and
# prints its URL (the server takes the next free port if 4747 is busy and opens the browser
# unless --no-open). For login auto-start too (see README.md). Args go to server.js.
#   sh bin/start.sh [--port 4747] [--no-open] [server.js flags...]
port=${SHIP_DECK_PORT:-4747}
prev=
for a in "$@"; do
  case $a in --port=*) port=${a#--port=} ;; esac
  [ "$prev" = --port ] && port=$a
  prev=$a
done
here=$(cd "$(dirname "$0")/.." && pwd)
p=$port
while [ "$p" -lt $((port + 20)) ]; do
  if curl -s --max-time 1 "http://127.0.0.1:$p/api/health" 2>/dev/null | grep -q '"app":"ship-deck"'; then
    echo "ship-deck: already running at http://127.0.0.1:$p/"
    exit 0
  fi
  p=$((p + 1))
done
# An install with --share (bin/install.sh) starts with sharing, unless SHIP_DECK_SHARE is set.
relay=$(sed -n 's/^share_relay=//p' "$here/.ship-deck-install" 2>/dev/null || true)
if [ -n "$relay" ] && [ -z "${SHIP_DECK_SHARE+x}" ]; then
  SHIP_DECK_SHARE=1
  SHIP_DECK_RELAY=${SHIP_DECK_RELAY:-$relay}
  export SHIP_DECK_SHARE SHIP_DECK_RELAY
fi
dir=${SHIP_DECK_ORDERS_DIR:-$HOME/.ship-deck}
umask 077
mkdir -p "$dir"
log=$dir/server.log
from=$(($(wc -c < "$log" 2>/dev/null || echo 0) + 1))
nohup node "$here/server.js" "$@" >> "$log" 2>&1 &
pid=$!
# Wait up to 5 s for the server to print its URL (the port may have moved).
i=0
url=
while [ $i -lt 50 ]; do
  url=$(tail -c +"$from" "$log" 2>/dev/null | sed -n 's/^Ship Deck: \(http[^ ]*\).*/\1/p' | head -n 1)
  [ -n "$url" ] && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
  i=$((i + 1))
done
if [ -n "$url" ]; then
  echo "ship-deck: started at $url (pid $pid, log $log)"
else
  echo "ship-deck: started (pid $pid); no URL yet, see $log"
fi
