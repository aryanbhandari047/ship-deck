# Backlog

## In flight
- [ ] harbor-lights - Harbor lights: rewire the beacon timer (repo: harbor-app) (since 2026-01-10)
- [ ] tide-scout - SCOUT (diagnose only, no fix): tide table drifts by an hour after DST. Deliverable: report at data/tide-scout/report.md. (repo: lighthouse-api) (kind: task) (since 2026-01-08)
  PR https://github.com/example-org/harbor-app/pull/7 open (head 0a1b2c3d). CI gated on a label - the red check is that gate (not a failure); needs the captain's go.
- [ ] buoy-refit - Buoy refit, local-only per captain: build and test locally, no PR yet. (since 2026-01-05)
## Queued
- [ ] fix-foghorn-path - Land the foghorn path fix (horn-lib.sh horn_lock_matches_pid -> inode compare) via PR; also check the clone path. See data/learnings.md 2026-01-02. (since 2026-01-02)
- [ ] buoy-refit-decision-paint-scope - Paint scope: whole hull vs waterline only (repo: harbor-app) (kind: captain) (since 2026-01-06) (hold: The refit repainted the shared hull component, changing ~12 unrelated boats (fleet-wide). Captain must choose: accept fleet-wide paint, or scope the new colour to the waterline only. Details in data/buoy-refit/review-findings.md) (hold-kind: captain)
  Origin: buoy-refit
  Decision key: paint-scope
  State: awaiting captain decision.
- [ ] beacon-flag-techdebt - Tech debt (beacon follow-up). Root cause found live: the builder only renders the 'auto-light' checkbox for field.type==='LAMP' (BasicProperties ~L145), NOT for STROBE (a STROBE field). Deferred. (since 2026-01-07)
  # Beacon follow-up: make autoLight the real mechanism

  ## Root cause (found live)
  The builder only renders the checkbox for `LAMP`.
  - Table: `lamps` (belongs to `towers` via `tower_id`).
  - WARNING: a SEPARATE `light` column exists - do NOT confuse it.

  ## Safe sequencing (do NOT remove the hack first)
  1. Builder: expose the checkbox.
  2. Backfill existing towers.

- [ ] harbor-rollout-remaining - Harbor rollout: remaining groups (review LIVE with captain) (repo: harbor-app) (since 2026-01-09)
  Harbor rollout state (updated 2026-01-09).

  RELEASE #66: OPEN, NOT MERGED, awaiting captain merge.
  - Recommended one-time resolution rule (captain not yet decided): accept every upstream deletion.

- [ ] tide-scout-decision-redeploy-ordering - Redeploy the tide service from fixed tip, or immediately from 7a28c32 (repo: lighthouse-api) (kind: captain) (since 2026-01-08) (hold: The banner is absent only because the service still runs 6b43694 (pre-#66). The tip is un-buildable (duplicate handler, TS2451). Captain must choose option A, fix the build first then redeploy from tip, or option B, redeploy immediately from 7a28c32 which is pre-break.) (hold-kind: captain)
  Origin: tide-scout
  Decision key: redeploy-ordering
  State: awaiting captain decision.
- [ ] quarterly-review - Quarterly review artifact (paused; state + open questions in data/quarterly-review/STATE.md) (since 2026-01-09) (hold: 5 open questions to captain, see data/quarterly-review/STATE.md) (hold-kind: captain)
- [ ] lantern-scope - Lantern scope: which lamp types are pickable as a spare? (repo: lighthouse-api) (kind: captain) (since 2026-01-04) (hold: Options: (A) cost lines only, meaning no backend work; (B) untyped costs in line metadata; (C) first-class per-lamp child rows.) (hold-kind: captain)
## Done
- [x] harbor-actions - Harbor actions: interactive (repo: harbor-app) (done 2026-01-11)
- [x] lantern-review-decision-race - Lantern C6: fix the race now? (repo: lighthouse-api) (kind: captain) (done 2026-01-03) (hold: Continue before reconcile lands starts the walk
  Resolution recorded by fm-decision-hold.
  Decision digest: 0000000000000000000000000000000000000000000000000000000000000000
  Routed identities: lantern-fixes

  Captain decision:
  Captain (3 Jan 2026): fix now together with C5.

  Routed work:- lantern-fixes
- [x] tide-review - Tide: triage review comments data/tide-review/report.md (reported 2026-01-02)
