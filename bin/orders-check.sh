#!/bin/sh
# Ship Deck orders wake check (self-contained; POSIX sh + awk only).
# Prints exactly one line "ship-deck: N new captain order(s)" when orders.jsonl
# has orders newer than the last one seen, else prints nothing. Order ids are
# time-sortable, so "newer" is a plain string compare against the cursor.
# Dir: $SHIP_DECK_ORDERS_DIR, default $HOME/.ship-deck.
umask 077
dir=${SHIP_DECK_ORDERS_DIR:-$HOME/.ship-deck}
orders=$dir/orders.jsonl
cursor=$dir/orders-check.cursor
[ -f "$orders" ] || exit 0
last=
[ -f "$cursor" ] && IFS= read -r last < "$cursor"
set -- $(awk -v last="$last" '
  match($0, /"id":"o-[0-9TZ]+-[0-9a-f]+"/) {
    id = substr($0, RSTART + 6, RLENGTH - 7)
    if (id > last) n++
    if (id > max) max = id
  }
  END { printf "%d %s\n", n, max }
' "$orders")
n=$1
max=${2:-}
[ "$n" -gt 0 ] 2>/dev/null || exit 0
printf '%s\n' "$max" > "$cursor.tmp.$$" && mv -f "$cursor.tmp.$$" "$cursor"
echo "ship-deck: $n new captain order(s)"
