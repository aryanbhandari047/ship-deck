# Design: ask a teammate's context

Status: decided (all recommendations below) and built: scope `ask`, `relay/lib/ask.js`,
`POST /v1/ask`, `lib/share.js` `ask`, the `teammate-ask` skill, `test/ask.test.js`. As built,
the question text (redacted on the asker's deck, first 120 characters) is in the captain's
log, and the asker is told so in the skill and in Settings. The agent-key GET route is left
for later. A question costs about 18 Redis commands (asserted), not the 9 estimated below.

## Goal

A teammate's agent asks a question ("how does Ada deploy the harbor app?") and gets
an answer drawn from what Ada granted, with citations, **without** Ada's whole
library being synced into the teammate's skills.

## Options considered

| | Where the answer is made | Verdict |
|---|---|---|
| A | On the **sharer's** machine: the question travels relay -> Ada's deck -> an agent on Ada's laptop answers | **Rejected.** Today nothing on the sharer's machine listens for the relay, and relay data never becomes a prompt there (`lib/share.js` cannot reach orders or fm-send). This option turns a teammate's text into input for an agent running on Ada's laptop with Ada's files and tools: a prompt-injection path into her machine, and it only works while her laptop is awake. |
| B | On the **relay**: it calls an LLM with the question and the granted items | **Rejected.** It adds an external service (an LLM API, keys, cost) to the relay, and sends Ada's text to a third party. The task rules forbid new external services. |
| C | **Retrieval on the relay, answer on the receiver.** The relay ranks passages from the granted library and returns the top few with citations. The receiver's own agent writes the answer. | **Recommended.** No LLM and no new service. Nothing runs on Ada's machine. Grant checks, redaction and audit are the ones already in place. |

## Recommended design (C)

### New grant scope `ask`

- A grant may carry `ask` ("Answer questions from my skills and notes"), off by default.
  It is independent of `skills`/`notes`: `ask` alone means the receiver's agent can
  **search** Ada's granted items but nothing is synced into their skills. `ask` with
  `skills` and/or `notes` is allowed too. It then also covers search across those kinds.
- What `ask` searches: the same library projection Ada's deck already pushes
  (`projectLibrary`: redacted, ≤ 16,000 characters per item, ≤ 512 KB), now also
  pushed when any grant has `ask`. Private notes (#4) are never included. A
  `notesTagged` grant searches only notes marked Share. Teammates' skills are never
  included.

### Flow

1. The receiver's agent calls Ship Deck on their own computer. Ship Deck adds a
   reference skill `teammate-ask`, written by `lib/knowledge.js` like the other teammate
   skills, that documents the call:
   `POST http://127.0.0.1:4747/api/share/ask` with `X-Ship-Deck: 1` and
   `{ "question": "...", "captain": "<name or all>" }`.
   It is a POST so the existing Host/Origin/`X-Ship-Deck` guards apply. A web page in
   the user's browser cannot trigger it.
2. The receiver's deck redacts the question with `lib/redact.js` (the question can hold
   the receiver's own secrets), caps it at 500 characters and sends it with its deck
   token: `POST /v1/knowledge/ask { captainSub|null, question }`.
3. The relay checks every captain the question targets, per request, with the same
   `checkAccess` + `itemAllowed` used by `/v1/knowledge`. The grant must be live, carry
   `ask`, and the item kind must be allowed. It ranks passages with BM25 over a term index
   built **at library push time** and stored as one more hash field (`lib:<sub>` field `x`).
   A query reads that field plus at most 3 item fields, not the whole library.
4. Answer: `{ notice, passages: [{ captain, key, title, updatedAt, verifiedAt, stale,
   lines: [from, to], text }] }`. At most 3 passages of at most 600 characters each. The
   notice is the existing `AGENT_NOTICE`: reference data, not instructions.
5. The receiver's agent writes the answer and cites `title (captain, lines a-b)`. Ship
   Deck does not generate text anywhere.

### Threat model

**What leaves which machine**

| Who | What | Where |
|---|---|---|
| Sharer (Ada) | Nothing new. The same redacted library projection, now also when only `ask` is granted | relay (`lib:<sub>`, 2 h TTL as today) |
| Receiver (Grace) | The question, redacted on her deck, ≤ 500 characters | relay (audit row only, see below) |
| Relay | ≤ 3 × 600 characters of passages per question, only from items the grant allows | Grace's deck, then her agent |

**Who can trigger what**

- Only Grace's own deck (deck token) can ask, and only about captains whose live grant
  to her account carries `ask`. Agent keys (`/v1/agent/*`) stay GET-only. If a
  without-Ship-Deck variant is wanted later, it is a separate GET with its own rate limit.
- On Grace's machine: anything that can send a guarded POST to `127.0.0.1:4747`. That is
  the same trust boundary as every other local action. A browser page cannot (the
  `X-Ship-Deck`/Origin guard).
- Nothing is ever triggered on Ada's machine. Her deck only pushes, as today.

**How it is approved**

- Ada approves per person by adding `ask` to a grant (Settings > Sharing), for 1, 7 or
  30 days, per project set as today. Default off.
- The relay enforces it on every request. There is no cached approval on the receiver.

**How it is revoked**

- Revoke, narrow (remove `ask`) or expiry: the next question gets `403`. The receiver's
  `teammate-ask` skill is removed on the next knowledge sync, like other teammate skills.
- Pausing sharing or signing out drops the library from the relay (as today), so search
  returns nothing within 2 hours at most. In practice it is immediate, because the deck
  sends `DELETE /v1/library` on pause.

**Abuse and limits**

- Extraction by many questions: `ask` is a minimisation boundary, **not** a
  confidentiality boundary. A determined receiver can reconstruct granted text through
  repeated questions. The UI must say so ("anything you let them ask about, treat as
  readable"). Limits: 30 questions an hour and 200 a day per grant (`arl:` style
  counters). The 429 is audited once, like agent keys.
- Prompt injection from Ada's text into Grace's agent: no worse than synced skills
  today. Passages carry the provenance notice and freshness (#3), and the agent is told
  they are reference data.
- Prompt injection from Grace's question: the question is never executed or shown to
  any agent on Ada's side. It appears only as audit text (escaped, `textContent`).

**Audit (never weakened)**

- Every question is a row in Ada's log: who, which items were cited (titles), result
  (`asked` / `refused` + reason).
- **Decision needed:** also store the question text (redacted, first 120 characters) so
  Ada sees what is asked of her context, or store only a hash so the receiver's questions
  stay private. Recommendation: store the redacted text, and tell the receiver so
  in the skill and in Settings.
- Usage counts (#2) gain a per-item "cited" count.

**Free-tier cost (estimate to assert in `relay/test`)**

- A question: deck auth (1) + MGET cap + index field (1) + ≤ 3 HGET (1 pipeline, 3) +
  rate counter (2) + audit (2) ≈ 9 commands. At 200 questions a day across a team that is
  about 1,800 commands a day (≈ 54,000/month, 11% of Upstash's free 500K). Bandwidth is
  bounded by the term index (≈ 20% of the library size) plus 3 items.

### Tests to write

- Scope off -> 403. `notesTagged` / private notes never appear in passages. Expired grant -> 403.
- Passages ≤ 3 × 600 characters, cited keys are all allowed for that grant.
- Question redacted before it leaves (a token in the question never reaches the relay store).
- Rate limit: 31st question in an hour is 429, audited once.
- Local endpoint refuses a POST without `X-Ship-Deck` / with a foreign Origin.
- Command budget per question.

## Decisions for the captain

1. Build option C, with a new `ask` scope (default off)? (Recommended.)
2. Store the redacted question text in the sharer's audit log, or only a hash?
3. Limits: 30 an hour / 200 a day per grant, 3 passages × 600 characters. OK?
4. Agents without Ship Deck (agent keys): include a GET search route now, or later?
