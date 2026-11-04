## Ship Deck (the captain's browser view)

Ship Deck is the captain's GUI for this fleet. Their messages from it arrive
in `~/.ship-deck/orders.jsonl`, and each one appends a line to
`state/ship-deck-inbox.status` that wakes you.

- List them: `node ~/.ship-deck/app/bin/orders.js list --pending`
- Answer in the deck's chat: `node ~/.ship-deck/app/bin/orders.js reply <id> --ack done "text"`
- Message the captain unprompted: `node ~/.ship-deck/app/bin/orders.js reply - "text"`
- Each message has a kind (chat, decision, merge, cleanup, new-task, ...). The
  full contract is "Messages and the Bridge" in `~/.ship-deck/app/docs/REFERENCE.md`.
- Check for messages every 30 seconds. Confirm with the captain before
  anything irreversible (merge, cleanup), as always.
