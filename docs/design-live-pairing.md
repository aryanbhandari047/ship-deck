# Design: live pairing (suggest, captain approves)

Status: decided (all recommendations below: `suggest` scope, off by default, Board only; option
letters plus a note that is shown and never sent; `suggestedBy` on the order) and built:
`relay/lib/suggest.js`, the suggestion routes in `relay/lib/app.js`, `lib/share.js`
`suggestions`/`takeSuggestion`/`resolveSuggestion`/`stopSuggestions`, `server.js` `/api/orders`,
the decision panel in `public/app.js`, the relay viewer form, `test/pairing.test.js`. As built,
"Answer with B" opens the usual confirm, the same step as clicking B, instead of pre-filling a
form. Free-text reply suggestions are not built.

## Goal

A teammate viewing your read-only board on the relay can **suggest** a reply, or an
answer to a worker's decision. Nothing reaches your agent until **you** approve it.

## The invariant this changes, and the one it keeps

- Today: "viewer routes are GET only and nothing a viewer sends reaches a deck"
  (`relay/lib/app.js`), and `lib/share.js` cannot reach orders, wake or fm-send
  (`test/share.test.js` checks its imports).
- After this change: **a viewer's suggestion reaches the captain's screen as data.
  It reaches an agent only through the captain's own send.** The approval is the
  captain's normal local action, a `decision` (or `chat`) order created from the
  captain's browser with the existing Host/Origin/`X-Ship-Deck` guards. So there is no
  new order kind, no new command and no new path into `fm-send`. `lib/share.js` still
  never requires orders/wake/actions. Suggestions are handed to the UI exactly like
  audit rows.

## Flow

1. **Grant.** New scope `suggest` ("Suggest answers"), off by default. It is only
   offered together with `board`, and only for the grant's projects.
2. **Viewer suggests.** On a needs-decision worker in the relay viewer, "Suggest an
   answer" lets them pick one of the worker's current option letters and add an
   optional note (≤ 300 characters). A free-text reply suggestion (≤ 500 characters)
   is also possible, see decision 2.
   `POST /v1/decks/<captainSub>/suggestions { ref, letter?, note?, text? }`, with
   cookie session + `guardCookiePost` (same-origin) as for agent keys.
3. **Relay checks and stores.** Live grant with `suggest`. `ref` must be a worker visible
   under the grant's projects in the latest snapshot. `letter` must be one of that
   worker's current options. Text gets control characters stripped and is capped.
   Stored in `sug:<captainSub>`: at most 20 pending per deck and 5 per viewer, 24 h TTL.
   One audit row: `Suggested B for "Fix the crash"` / `suggested`.
4. **Captain's deck fetches.** The suggestion count rides on the existing
   `GET /v1/grants?brief=1` answer, like the knowledge version, so no new polling. The
   list is fetched only when the count changed: `GET /v1/suggestions` (deck token).
   `lib/share.js` shapes each one field by field (`cleanSuggestion`), maps `ref` back to
   the local worker id (it computes the refs), and drops any whose letter is not among
   that worker's current options ("outdated").
5. **Captain sees it** on that worker's decision panel: "Grace suggests **B**: <note>"
   (rendered with `textContent` only), with **Use this answer** and **Dismiss**.
   - *Use this answer* only **pre-fills** the captain's own decision form: the letter is
     selected, and the note is **not** copied into the message (decision 3). The captain
     still clicks Send. That is the existing `decision` order, with the same validation in
     `lib/orders.js` (letter must exist, target must exist).
   - The deck then reports the outcome: `POST /v1/suggestions/<id> { state: used |
     dismissed }` (deck token). The viewer sees "used" or "dismissed", and the audit gets a row.
6. **Provenance for the first mate:** the order created from a suggestion carries
   `suggestedBy: <email>`, so the first mate's history shows whose idea it was. This is
   an optional field in the order payload, documented in the REFERENCE contract.

## Threat model

**What leaves which machine**

| Who | What | Where |
|---|---|---|
| Viewer | Option letter, optional ≤ 300-character note (or ≤ 500-character reply text) | relay `sug:<sub>` (24 h), then the captain's deck |
| Captain's deck | Nothing new outbound except `used`/`dismissed` states | relay |
| Relay | Suggestions for this captain only, from viewers whose grant still has `suggest` | captain's deck |

**Who can trigger what**

- A viewer with a live `suggest` grant can create a pending suggestion for a worker they
  can see. That is all. They cannot send, order, merge, configure, or reach a terminal.
- Only the captain, in their own browser on their own machine, can turn a suggestion
  into an order, through the same send they use today. The deck never sends a
  suggestion on its own: no auto-accept, no timer, no "accept all".
- The relay owner cannot inject suggestions without a grant. Suggestions are tied to
  a viewer session and checked against the captain's grant record on write **and** on
  read.

**How it is approved**

- Per person, per project set, per duration: `suggest` on the grant. Default off.
- Per suggestion: the captain's own Send after reviewing the pre-filled form.

**How it is revoked**

- Revoke, narrow or expire the grant: new suggestions are refused (403). Pending ones from
  that viewer are filtered out on the next `GET /v1/suggestions`, because the relay re-checks
  the grant on read, and they disappear from the captain's screen.
- "Stop suggestions from <name>" on the captain's panel removes `suggest` from that grant.
- Pausing sharing hides all suggestions and stops fetching them.

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Prompt injection via suggestion text into the captain's agent | The note is shown, not sent. Only the option letter pre-fills the form. A free-text reply (if allowed) pre-fills an editable box, visibly marked "from Grace". The captain reads it before Send, and `suggestedBy` provenance reaches the first mate. |
| A stale suggestion answers a newer decision | It is bound to the worker ref **and** the letter must be among the current options at display time; otherwise shown as outdated and Use is disabled. The captain's send still targets the current decision. |
| Spam / UI flooding | 5 pending per viewer, 20 per deck, 10 a viewer an hour, 24 h TTL. A 429 is audited once. |
| XSS on the captain's deck from viewer text | `textContent` only, control characters stripped on the relay and on the deck (same rule as all relay data). |
| CSRF on the relay viewer | `guardCookiePost` (same-origin) as for agent keys, `SameSite` session cookie. |
| Confused deputy: viewer suggests for a worker outside their projects | The relay checks `ref` against the grant's projects with the same `viewFor` used for reads. |
| Weakened audit | Every create, refusal, use and dismissal is a row in the captain's log. The viewer's own page shows their suggestions' states. |

**Free-tier cost (estimate)**

- Create: session + snapshot + cap (1 MGET) + store (2) + audit (2) ≈ 5 commands. The
  count piggybacks on the grant refresh MGET (+0). A list fetch only on change (2). At
  50 suggestions a day that is well under 1% of the free tier.

## Tests to write

- `lib/share.js` still requires no orders/wake/actions. A suggestion never creates an
  order file without a guarded local POST from the captain's page.
- Scope off -> 403. Hidden project -> 403. Letter not among the current options -> 400.
- Revoked viewer's pending suggestions vanish from the deck's list.
- Caps, TTL and rate limits. Audit rows for create, refused, used, dismissed.
- Viewer text with markup renders as text on the deck (DOM test, or `textContent` check in `public/share.js`/`app.js`).

## UI note

The decision panel belongs to the board, which `sd-redesign` is restyling. The
suggestion block should be one small addition to the existing decision section using
existing components (pill + button row). It should land after the redesign.

## Decisions for the captain

1. Build it with a new `suggest` scope, default off, board-only? (Recommended.)
2. Option letters only, or also free-text reply suggestions? (Recommended: letters +
   a note that is shown but not sent; free text later if wanted.)
3. When the captain uses a suggestion, should the viewer's note ever go to the agent?
   (Recommended: no. The captain retypes anything they want sent.)
4. Add `suggestedBy` to the order payload so the first mate sees provenance? (Recommended: yes.)
