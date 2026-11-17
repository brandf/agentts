# BRA-67 coverage map — every BRA-62 failure mode → covering test

- **Date:** 2026-11-16
- **Linear:** BRA-67 (project AgentTS) — testing counterpart to BRA-62
  (audit: `docs/audits/robustness-2026-11-16.md`)
- **Method:** each row was checked against the test file itself, not
  against an issue title. "Covered" means the file injects the fault
  and asserts recovery + a journal record. The BRA-71..77 wave closed
  most modes; BRA-67 filled the three that had no test, plus the two
  VM-replacement halves that are testable from inside this VM.

## Map

| Audit row / gap | Failure mode | Covering test |
|---|---|---|
| §2.1 (G2, G9) | VM goes away / is replaced | tick-driver D (SIMULATED: server SIGKILLed, watchdog exit 2, fresh standin recovers) + bra67 C (full kill + clean-shell recovery) + bra67 D (missing engine binary fails loudly) + bra72 A/F (G2) + bra71 A (G9). A TRUE replacement (the VM itself) is not testable from inside the VM — see "Not achievable" below. |
| §2.2 (G1) | C host dies mid-slice | bra74 A (resume slice, SIGKILL), E (first slice, no blob yet), B (registry rc 1 → `queue repair` → completes) |
| §2.3 (G3, G4) | C host dies mid-suspend (torn snapshot) | bra76 A1 (stranded run's blob intact, tmp+rename) + A2 (truncated blob NOT trusted, loud failure) + bra75 (resume from previous blob, re-dispatch dedupe). The kill-during-save_snapshot itself is not injected (the write is sub-millisecond); its observable consequence — a torn blob — is what A2 tests. |
| §2.4 (G3) | TS host dies between dispatch and resume | bra75 A (job, after dispatch), B (exec, after dispatch), C (job, during dispatch — pool trapId dedupe), D (exec, during dispatch — visible re-run) |
| §2.5 (G2, G5) | TS host dies mid-run (queue/registry) | bra72 A/F (stranded "running", explicit + auto repair) + bra77 A/B (atomic queue writes, corrupt-read fails loudly) |
| §2.6 (OK) | Worker dies mid-job | run-worker-pool-suite C (SIGKILL mid-job → lease re-queue → different worker completes once) |
| §2.7 (G6) | Worker completes but complete-job never lands | bra67 B (ghost worker does the work, exits without completing; lease re-queue; retry completes once; marker proves the work was done twice) |
| §2.8 (G6) | Worker goes silent / stuck | bra61 A (nudge before expiry), B (per-jobspec idempotency), C (cost-derived lease) + tick-driver E (lease expiry re-queue + tick event) |
| §2.9 (G5, G7) | Queue / scheduler dies with jobs in flight | bra77 A/B (queue) + bra76 B (corrupt worker store: backup recovery / loud failure) |
| §2.10 (G8) | Gate held for days | run-host-suite cross-process gate (submit → drive to hold → result → deliver-gate → drive → result, 6 fresh processes, journal gate-held → trap-result → completed) + tick-driver C (tick + drive + deliver) + D (held gate across simulated replacement, never flipped) |
| §2.11 (G9) | Coordinator goes away / compaction; which state dir; no frozen copy | bra71 A1–A4 (frozen closure: workflow edit, type error, registry loss, lib edit) + B3 (frozenHash/frozenPath/engineVersion recorded). The "which state dir" half (cwd-dependent default): bra67 C proves an absolute --state-dir recovers from any cwd; the default-cwd hazard itself is an ops rule (cron pins an absolute path), not a test. |
| §2.12 (G10) | Engine rebuild / upgrade between suspend and resume | bra71 B1 (different build refused loudly, mismatch event, blob untouched) + B2 (same engine resumes) |
| §2.13 (G8, G11) | Sleep / cron trap across a host restart | Sleep: bra74 C (sleep-deadline event, remainder only) + bra75 E (remaining time). Cron: bra67 A (absolute target in the trap arg, remainder only). Driver/G8: tick-driver C. |
| §2.14 (G12) | Run needs >50 suspensions in one drive | bra76 C1 (60 sleeps → DriveCapError, drive-cap event, blob intact) + C2 (50 sleeps completes — cap is exactly 50) |
| §2.15 (G13) | Two `queue run` drivers at once | bra72 E (second driver fails loudly, "driver already running", one trap event) |
| §2.16 (G14) | Adapter timeout vs server retries | bra74 D (derived timeout = lease × attempts + margin; never-settling job fails JobTimeout naming both numbers) |
| §2.17 (G15) | Corrupt journal line | bra77 C (bad lines quarantined, Host starts, corruption.log) + D (repair after a corrupt journal) |

## What BRA-67 added (tests/test-bra67.ts)

- **A. Cron across a host restart** — the G11 cron half had no test
  (sleep had two). Kill mid-wait, re-drive, assert remainder-only
  timing + redispatched journal marker.
- **B. Worker completes but complete-job never lands** — audit row 7
  had no test (pool-suite C kills the worker mid-job, so no work is
  proven done). New fixtures: `tests/fixtures/marker-worker.ts`
  (jobspec script with an observable side effect) and
  `tests/fixtures/never-lands-worker.ts` (standalone ghost worker
  that does the work and exits without completing).
- **C. VM-replacement cold start** — the closest faithful test
  achievable from inside this VM: full SIGKILL sweep of every
  AgentTS process, then recovery entirely from a clean shell
  (cwd /tmp, scrubbed env, fresh CLI processes), watchdog first
  (exit 2), then deliver-gate + repair + queue run recover a held
  gate run and a stranded sleep run.
- **D. Missing engine binary fails loudly** — plus the fix that makes
  it true: `src/host.ts` `resolveHostPath` now throws when an
  explicitly set `$DURABLETS_HOST` points at a missing file, instead
  of silently falling back to a different repo binary. (The same
  silent-fallback pattern still exists in the mock plugin,
  `plugins/mock/src/mock-plugin.ts:170-171` — out of scope here, test
  plugin only; noted, not changed.)

## The journal-profiler audit (docs/audits/journal-profiler-2026-11-16.md)

That audit is about profiler schema gaps, not failure modes, so it
contributes no additional fault-injection rows. For the record: its
item 3 (a per-trap dispatch marker) is implemented and exercised by
bra74/bra75/bra67 (`trap-dispatch` / `trap-dispatched` events);
items 1–2 (call site on `trap`, workflowHash/submittedAt on run
start) and 4 (worker lane via adapter) are profiler features, not
crash-recovery behavior, and have no fault-injection test — nor
should they; they belong to the profiler build, not this suite.

## Not achievable: an actual VM-replacement recovery test

A test running inside this VM cannot replace the VM itself. What a
real replacement does that a process restart does not:

1. **All processes die with no graceful shutdown** — testable, and
   covered (tick-driver D, bra67 C).
2. **Build artifacts are gone (C host binary, node_modules)** — the
   binary half is testable via bra67 D (loud failure when the pinned
   binary is missing). The node_modules half is NOT testable in a
   suite: it would require deleting node_modules and reinstalling
   (destructive, minutes-long, network-dependent). The audit §3
   job-2 daily health check is the operational cover for the
   rebuild + reinstall + version-verify step.
3. **No ambient process/env state carries over** — testable, and
   covered by bra67 C (clean shell, different cwd, scrubbed env).
4. **Home persists, state dir at the same path** — the state dir is
   the sole carrier; bra67 C proves recovery from it alone.

## Known gap found by this work (filed separately, not fixed here)

**State-dir relocation:** a state dir copied to a new path does not
resume — the registry stores `snap`/`out`/`log` as absolute paths
under the old state dir (`host.ts` `startRunFrom`/`loadBlob` resume
through `entry.snap`), and `frozenPath` is stored absolute
(`frozenFor`/`requireFrozen` use it verbatim). A real VM
replacement keeps the path, so this does not affect the replacement
story, but a backup-restore to a new path (or a moved state dir)
fails loudly instead of resuming. Fix sketch: store frozenPath
relative to the state dir (resolve against the current state dir at
load, absolute as legacy fallback) and rebase registry snap/out/log
to the current workdir when the recorded path is gone. Filed as
BRA-85 — "State dir relocation: a copied/moved state dir cannot
resume suspended runs (absolute paths in registry + frozenPath)"
(https://linear.app/brandf/issue/BRA-85/state-dir-relocation-a-copiedmoved-state-dir-cannot-resume-suspended),
verified empirically 2026-11-16 (cp -r state dir, delete original,
`queue run` fails "frozen copy missing … was deleted").
