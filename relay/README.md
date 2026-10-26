# Ship Deck relay

A small Vercel project that lets Keychain teammates watch each other's Ship Deck, read-only.
A captain's deck pushes a redacted snapshot out to the relay (`ship-deck --share`); teammates
the captain named sign in here and see it. The captain's computer never accepts a connection,
and nothing a viewer does can reach a deck: deck data routes are GET only, and the only viewer
writes are their own read-only agent keys (see [Shared knowledge](#shared-knowledge)).

```
Captain's laptop                       Relay (Vercel + Upstash Redis)            Teammate's browser
Ship Deck on 127.0.0.1 (unchanged)
 └ share agent ── HTTPS push ────────▶ latest snapshot (1 h TTL)          ◀── invite-only sign-in (@keychain.com)
   allow-list + redaction,             grants, append-only audit (90 days)  ──▶ GET only, grant checked per request
   on change, ≤ every 30 s     ◀────── grants + audit (shown as data)
```

Node serverless functions only, no npm dependencies. One function (`api/relay.js`) serves every
dynamic route; the pages in `public/` are static.

## Zero cost

No payment method is needed anywhere, and nothing here can bill: the free tiers stop when a
limit is reached (requests fail until the period resets) instead of charging.

- **Vercel Hobby** (free) under the captain's Keychain-email Vercel account. Hobby is for
  non-commercial use: revisit (Vercel Pro or Keychain cloud) before rolling out widely.
- **Upstash Redis free plan**, created from the Vercel Marketplace (Storage > Upstash for
  Redis > Free) or at upstash.com, without a card.
- No Google Cloud project (sign-in is invite-only email + password for now), no cron, no
  analytics, no log drains, no paid add-ons.

If the relay hits a limit, decks back off (30 s doubling to 15 minutes, "Sharing paused" in
Settings) and the viewer page waits longer between tries; local Ship Deck is unaffected.

### Usage estimate: 10 captains × 5 viewers

Free caps (checked 2026-10-14): Upstash 500,000 commands/month, 10 GB bandwidth, 250 MB
data; Vercel Hobby 1,000,000 function invocations, 4 active CPU-hours, 100 GB transfer.

Redis commands per request (asserted in `relay/test/relay.test.js`):

| Request | Commands |
|---|---|
| Deck push (`POST /v1/snapshot`) | 2 |
| Deck grant refresh (`GET /v1/grants?brief=1`, every 30 min) | 1 |
| Viewer read (`GET /v1/decks/<sub>/<scope>`) | 1, plus 3 when it writes an audit row (first look at that item in 15 min) |
| Viewer deck list (`GET /v1/decks`, on load and every 30 min) | 2 |
| Knowledge check (`GET /v1/knowledge?since=`, a teammate's deck, at most every 10 min, skipped when a grant refresh already showed the same version) | 1 unchanged; 3 + one per sharing captain when the version moved |
| Knowledge read (`GET /v1/knowledge/<captainSub>`, only for a captain whose hash changed) | 5 |
| Agent read (`GET /v1/agent/library[/…]`) | 6: key + deck + item, rate counter, audit row; 7 when it also stamps last-used (at most every 10 min); 2 for an unknown key |
| Deck library push (`POST /v1/library`, on change or hourly) | 4-5 |

Assumptions: each deck runs 10 h a day and its board changes on average every 3 minutes
(pushes happen only on change, at most every 30 s, plus a keep-alive every 10 minutes); each
viewer watches one deck for 30 minutes a day (polls every 30 s while the tab is visible and
pauses after 10 idle minutes) and opens 5 workers.

| | Per day | Redis commands/day | Invocations/day |
|---|---|---|---|
| 10 decks: 230 pushes + 20 grant refreshes each | 2,500 requests | 4,800 | 2,500 |
| 50 viewers: 60 polls, 2 lists, 10 worker reads, 12 audit rows each | 3,600 requests | 5,500 | 3,600 |
| **Total** | | **≈ 10,300 (≈ 310,000/month, 62% of 500K)** | **≈ 6,100 (≈ 183,000/month, 18% of 1M)** |

Shared knowledge: a teammate's deck asks only when its own grant refresh (which it makes every
10 minutes anyway, and which now carries the knowledge version in the same MGET) shows a change,
or while its sharing is paused (1 command per 10 minutes). A change costs one list and one
read per changed captain: 10 knowledge changes a day reaching 5 teammates each is about 450
commands a day (≈ 14,000/month, 3%). Library pushes bump the version only when the content
changed, never on the hourly keep-alive.

Agent keys (optional, for agents without Ship Deck): 10 agent keys reading 20 items a day each is 200 reads, about 1,300
commands a day (≈ 40,000/month, 8%), plus at most 10 library pushes a day per deck (≈ 15,000/month).
Library items are capped at 16,000 characters, so reads move little data. The 60 reads/hour
limit per key is the ceiling: a key read flat out all day would cost about 9,000 commands, so
watch the Upstash console if teammates script their agents; nothing bills either way.

Active CPU: a request does a JSON parse and one Redis round trip, ≤ 10 ms of CPU, so about
30 minutes a month (13% of 4 h); sign-ins cost about 50 ms each (scrypt). Data: snapshots are
2-10 KB, so about 1.2 GB/month of Redis bandwidth (12% of 10 GB) and about 1 GB of Vercel
transfer (1% of 100 GB). Knowledge libraries are at most 512 KB per deck: 10 decks pushing a
full one hourly for 10 h is about 1.5 GB/month more Redis bandwidth (15%), and 5 MB stored.
Storage: 10 snapshots of at most 64 KB plus about 60,000 audit rows of 300 bytes kept 90 days,
about 20 MB (8% of 250 MB).

The expensive switch is **Terminal**: its pane changes every capture, so a deck sharing it
pushes every 30 s while workers print (about 2,400 commands per deck per 10 h day). Keep it
off by default, as the Settings page does, and turn it on for one person at a time. If the
Upstash console ever shows the month trending past the cap, the levers are Terminal and the
number of viewers watching at once; nothing bills either way.

## Deploy (first mate + captain)

1. **Redis.** In the Vercel dashboard (Hobby, the captain's Keychain account): Storage >
   Marketplace > Upstash for Redis > Free plan, any region near Keychain. Or create a free
   database at upstash.com. Keep the REST URL and token.
2. **Project.** Vercel > Add New > Project > import the ship-deck repo. Root Directory:
   `relay`. Framework preset: Other. Leave the build and install commands empty.
3. **Secrets.** Project > Settings > Environment Variables (Production), see the table below.
   Generate the session secret with `openssl rand -base64 48`. Connecting the Upstash
   integration to the project sets `KV_REST_API_URL`/`KV_REST_API_TOKEN`, which work as is.
4. **Deploy**, then open `https://<project>.vercel.app/`: you should see "Sign in to see
   shared decks". Set `PUBLIC_BASE_URL` to exactly that origin and redeploy if it changed.
5. **First account.** Set `OWNER_EMAIL` and `SETUP_CODE` (random 48 characters, e.g.
   `openssl rand -base64 36`), redeploy, open
   `https://<project>.vercel.app/api/auth/setup?code=<SETUP_CODE>` and set a password of at
   least 12 characters. Then remove `SETUP_CODE` and redeploy. The link works once (a second
   click is a 404, even before the password is set) and only while the relay has no
   accounts. Fallback, from this folder on your own computer:
   `UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… PUBLIC_BASE_URL=https://<project>.vercel.app node scripts/bootstrap-owner.js you@keychain.com`,
   then open the printed link (24 h, single use).
   **Owner password reset** (no database credentials needed): set a new `SETUP_CODE` and
   `SETUP_ALLOW_RESET=1`, redeploy, open the same setup link and set a new password. This
   also lifts the owner's sign-in lockout. Then remove both variables and redeploy. Each code
   works once, so a later reset needs a fresh code.
6. **Share.** Start Ship Deck with `--share --share-relay https://<project>.vercel.app`,
   open Settings > Sharing (the share button in the top bar), sign in, add teammates, and send
   each new person the invite link it shows (Slack or email; the relay sends no email).
7. **Check usage** after the first week: Upstash console (commands) and Vercel > Usage.

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | The relay origin, `https://<project>.vercel.app` (no trailing slash). Invite links use it and cookie-authenticated POSTs must come from it. |
| `SESSION_SECRET` | 32+ random characters. Signs deck tokens; changing it signs every deck out. |
| `ALLOWED_HD` | `keychain.com`. The only email domain that can hold an account, exact match. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | From Upstash. `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Marketplace names) also work. |
| `OWNER_EMAIL` | Optional. This account also sees every sign-in attempt (failures, lockouts) in its audit log. |
| `SETUP_CODE` | Only for the first account (step 5) or an owner reset: 32+ random characters (48 suggested). Remove it once you have signed in. |
| `SETUP_ALLOW_RESET` | `1` lets the setup link run while accounts exist, as an owner password reset. Remove it with `SETUP_CODE`. |
| `AUTH_PROVIDER` | Optional, `password` (the only one today). |

The relay refuses to serve (503 "relay not configured", reason in the function log) when it
runs on Vercel without https, a long enough secret or Upstash.

**Google sign-in later.** Auth sits behind `auth/index.js`: a provider returns
`{ sub, email, name }` and everything else (sessions, deck tokens, the domain rule, grants)
stays. A Google provider would check `hd` and `email_verified` from the verified ID token,
and add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and the redirect URIs
`<PUBLIC_BASE_URL>/api/auth/callback` and `http://localhost:3000/api/auth/callback`.

## Local development

```sh
# memory store; prints an invite link
node dev.js --port 3000 --invite you@keychain.com
ship-deck --share --share-relay http://localhost:3000 --orders-dir /tmp/sd-orders ...
# from relay/ (the repo's npm test runs it too)
npm test
```

`dev.js` serves `public/` and the same handler as Vercel, with the same headers. It uses
Upstash when its variables are set, otherwise memory (lost on restart). `vercel dev` also
works with a `.env.local` holding the variables above.

`public/style.css`, `board.js` and `markdown.js` are copies of the deck's files (the relay
deploys alone); after changing them in `../public`, run `node scripts/sync-ui.js`. A test
fails when they drift.

## Accounts and sign-in

- **Invite-only.** There is no sign-up route. A captain creates an invite from Settings
  (`POST /v1/invites`); the relay returns `https://<relay>/invite#<token>`, valid 24 hours,
  single use, and a newer invite for the same email replaces the older. The token is in the
  fragment, so it never reaches logs. Opening it sets the password and signs in. Re-inviting
  an existing account is the password reset and ends its other sessions.
- **Owner setup link.** `GET /api/auth/setup?code=<SETUP_CODE>` answers only while
  `SETUP_CODE` (32+ characters) and `OWNER_EMAIL` are set and no account exists, or, with
  `SETUP_ALLOW_RESET=1`, also while accounts exist (an owner password reset that also clears
  the owner's email lockout and the caller's IP lockout, audited as "Owner password reset via
  setup link"). The code is compared in constant time; a match creates the usual invite for
  `OWNER_EMAIL` only, redirects (302) to it and records `setup:used:<sha256(code)>`, so each
  code works once (the older global `setup:used` flag still blocks every code). Every refusal is the same
  404; wrong codes are audited to `OWNER_EMAIL`'s log and count toward the per-IP lockout.
- **Passwords:** at least 12 characters, scrypt (N=16384, r=8, p=1) with a random salt per
  user, constant-time compare, never logged, stored or returned.
- **Lockout:** 5 failures for an email or from an IP lock both for 15 minutes; failures and
  lockouts are audited (to the account's own log, and to `OWNER_EMAIL`).
- **Sessions:** an opaque random id in an HttpOnly, Secure, SameSite=Lax cookie; the store
  keeps only its SHA-256, for 7 days. `POST /api/auth/logout` ends it. Cookie POSTs must come
  from `PUBLIC_BASE_URL` (login CSRF).
- **Deck tokens:** a deck signs in once with the captain's password and receives a token
  bound to the captain and that device (HMAC with `SESSION_SECRET`, checked against the
  device list on every request). Signing out in Settings deletes the device; up to 10 per
  captain.

## Routes

| Route | Who | |
|---|---|---|
| `POST /api/auth/login`, `/api/auth/logout`, `/api/auth/accept` | browser | sign in, sign out, set a password from an invite |
| `GET /api/auth/setup?code=` | browser | one-time owner setup link: 302 to an invite for `OWNER_EMAIL` |
| `POST /v1/device/login`, `DELETE /v1/device` | deck | get or revoke this deck's token |
| `POST /v1/snapshot` | deck token | store the latest snapshot (re-sanitised against the allow-list, 64 KB) |
| `GET /v1/grants`, `PUT /v1/grants/<email>`, `DELETE /v1/grants/<email or sub>` | deck token | the captain's grants (`?brief=1`: no account or last-viewed lookups) |
| `GET /v1/audit?since=` | deck token | the captain's audit log, newest first |
| `POST /v1/invites` | deck token | a one-time invite link |
| `GET /v1/decks` | viewer session | decks shared with me |
| `GET /v1/decks/<captainSub>/<scope>[?ref=]` | viewer session | one scope: `board`, `updates`, `model`, `skills`, `terminal`, `notes`, `chat` |
| `GET`, `POST /v1/decks/<captainSub>/agent-keys`, `DELETE …/agent-keys/<id>` | viewer session | the viewer's own agent keys for that deck (`POST` returns the key once) |
| `POST /v1/library`, `DELETE /v1/library` | deck token | store or remove the knowledge library projection (re-sanitised, 512 KB) |
| `GET /v1/knowledge[?since=<version>]`, `GET /v1/knowledge/<captainSub>` | deck token | a teammate's own deck: what every captain shares with this account (hashes), and one captain's granted skills and notes with their text |
| `GET /v1/agent/library`, `GET /v1/agent/library/<captainSub>/<key>` | agent key | the library list (JSON) and one item (markdown) |

Nothing else is routed. Viewer deck routes, `/v1/knowledge` and `/v1/agent` answer 405 to every other method. A grant is authored
only through the owning captain's deck token and is checked on every viewer request: grant
present (revoke deletes it), not expired (30 days at most), scope granted, and the worker's
project granted. The first person to use a grant binds it to their account, so a recycled
email does not inherit it. Every view and refusal is audited; repeats of the same view collapse
into one row per 15 minutes to stay inside the free tier.

## Shared knowledge

Grant scopes `skills` and `notes` also share their full text as knowledge the teammate's own
agent uses; the flow for both sides is in [`../docs/AGENT-LIBRARY.md`](../docs/AGENT-LIBRARY.md).
An old `agentLibrary` flag on a stored grant is ignored and left out of every answer.

- The deck pushes a separate, redacted projection (skills when a grant has `skills`, notes and
  memory when one has `notes`) to `lib:<sub>`, a hash with an `index` field (with a short
  content hash per item) and one `i:<key>` field per item, kept 2 hours past the last push.
  The relay re-applies the allow-list (`lib/library.js`) and gives each grant only its kinds.
- `kver:<sub>` is each account's knowledge version: bumped on a grant change for that email and
  when a library push changes content for its grants. Deck auth reads it in the same `MGET` as
  the captain record and returns it with grants and pushes, so an unchanged check is free or
  one command. `GET /v1/knowledge` lists, per captain sharing with the account, a hash over what
  that grant may read; `GET /v1/knowledge/<captainSub>` returns the items and writes one
  `agent sync` audit row. Access that ended answers 403; 401 means only that the device token
  is gone.
- Agent keys (optional, for agents without Ship Deck) are `sdak1.<captainSub>.<random>`, made
  by a signed-in viewer whose grant has `skills` or `notes`, at most 3 per viewer per deck,
  returned once. The relay stores `agk:<sha256(key)>` (label, created, last used, the grant's
  id) and `agks:<captainSub>:<viewerSub>` (the key ids).
- Every key read checks the key, then the live grant: unknown, revoked or expired keys, a
  revoked or ended grant, or a new grant after a revoke answer 401; neither `skills` nor
  `notes` granted answers 403. Each key has 60 reads an hour (`arl:…`, 429 with `Retry-After`).
  Every read of a known key writes one audit row for the captain; going over the limit writes one.

## Data and retention

One Redis database: `user:<email>` (account, scrypt hash), `sess:<hash>` (7 days),
`inv:<hash>` (24 h), `cap:<sub>` (the captain's devices and grants), `snap:<sub>` (latest
snapshot, 1 h, overwritten, never versioned), `vix:<email>` (captains sharing with an email),
`aud:<sub>` and `aud:auth` (audit rows, added with `ZADD` only and aged out after 90 days),
`aseen:…` (15-minute audit de-dupe), `fail:…` (15-minute lockout counters), `lib:<sub>`
(knowledge library, 2 h), `kver:<sub>` (knowledge version, 35 days), `agk:<hash>`/`agks:<sub>:<viewerSub>`
(agent keys, 30 days at most), `arl:…` (hourly agent rate counters).

## Failure modes

- Relay or Upstash down, or over a free limit: decks back off and say "Sharing paused";
  viewers see a note and retry later. The local deck is unaffected.
- Captain offline: viewers see the last snapshot with its time, then "offline" after an hour.
- Lost laptop or leaked deck token: sign that device out (or rotate `SESSION_SECRET` to sign
  out every deck).
- A redaction miss is the main residual risk; that is why Terminal, notes and chat are off by
  default and the snapshot is an allow-list.
