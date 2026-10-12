#!/bin/sh
# Starts Ship Deck in the background unless something already listens on its port.
# For login auto-start (see the LaunchAgent example in README.md). Args go to server.js.
#   sh bin/start.sh [--port 4747] [server.js flags...]
port=${SHIP_DECK_PORT:-4747}
prev=
for a in "$@"; do
  case $a in --port=*) port=${a#--port=} ;; esac
  [ "$prev" = --port ] && port=$a
  prev=$a
done
here=$(cd "$(dirname "$0")/.." && pwd)
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null || nc -z 127.0.0.1 "$port" 2>/dev/null \
  || curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null; then
  echo "ship-deck: already running on 127.0.0.1:$port"
  exit 0
fi
dir=${SHIP_DECK_ORDERS_DIR:-$HOME/.ship-deck}
umask 077
mkdir -p "$dir"
nohup node "$here/server.js" "$@" >> "$dir/server.log" 2>&1 &
echo "ship-deck: started on http://127.0.0.1:$port/ (pid $!, log $dir/server.log)"
