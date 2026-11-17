# Robustness / durability audit — AgentTS

- **Date:** 2026-11-16 (audit run ~06:30–07:00 PST)
- **Linear:** BRA-62 (project AgentTS, P-BRA-2)
- **Scope:** read-only audit. No code edited, nothing pushed, no issue closed.
- **Method:** every claim below was checked against the code in
  `~/workspace/agentts-repo` and against real on-disk state. Nothing in
  this report rests on the design record alone; where the design record
  and the code disagree, the code wins and the disagreement is flagged.
- **Caveat — BRA-59 in flight:** the function-flip worker was actively
  editing `cli.ts`, `durablets.c`, `host.ts`, and `workflows/` during
  this audit. The durability mechanisms audited here (journal, blob
  store, registry, queue, worker store) are stable and predate BRA-59,
  but findings touching the run path, the driver, result capture, and
  the entry guard should be re-verified after BRA-59 lands. Where a
  finding depends on BRA-59's new code it is marked as such.
- **Live state found:** there is no production run state on disk to
  inspect. The only state dir, `~/workspace/agentts-host/.agentts-state/`,
  is empty (created 2026-11-16 06:34, all subdirs empty, no `queue.json`,
  no journals, no runs). The only journals on the machine are test
  fixtures under `apps/agentts/tests/fixtures/profiler/` (e.g.
  `briefing-proof3-2026-11-16.journal`, 50 lines — a real run's journal,
  kept as a fixture). All prior real runs went to mkdtemp scratch dirs
  that `run.sh` deletes on success. So the durability *design* is
  on-disk, but no live production run was available to verify against.
  No AgentTS process is running right now (`ps` shows no bun /
  agentts / worker-server process), and no AgentTS cron job exists.

## 1. The durability substrate — what survives and what does not

State dir (default `./.agentts-state` in the working directory, or
`$AGENTTS_STATE_DIR` — `apps/agentts/src/cli.ts:118-119`; the Host
constructor's mkdtemp default only applies when no state dir is passed):

| Path | Contents | Durability |
|---|---|---|
| `journals/<run>.journal` | JSONL, the source of truth; every event stamped `wallTs` (host.ts `journalEvent`) | Append-only, one `appendFileSync` per event. Survives. |
| `blobs/<run>.snap` | Snapshot from the last successful suspension, sha256-verified on store and on restore (`storeBlob`/`loadBlob`) | Survives. Only written after a *successful* suspend. |
| `slices/<run>.{snap,out,log}` | Live (transient) snapshot, captured stdout, C-host stderr log | Survives on disk (they live in the state dir), but the host only trusts `blobs/`, not `slices/`. |
| `runs/<run>.json` | Persisted registry entry (snapshot path, exit code, workflow path); `runs/<run>.gate-answers.json` (delivered gate answers); `runs/<run>.driver.ts` (generated driver) | Survives. Written after every mutation (`saveRunEntry`). |
| `queue.json` | The run queue (runId, workflow, adapter, status, input, priority, taskId) | Survives — but see the failure modes: non-atomic write, silent loss on corrupt read. |
| `cache/` | Extraction/schema cache keyed by content hash (+ compiler + checker version) | Survives. Rebuilt by re-gating on a miss. |
| `cost-actuals.jsonl` | Host trap-actual log (append-only, corrupt lines skipped) | Survives. |
| `task-runs.json` | Local task→run mirror | Survives — but non-atomic write, silent fresh-start on corrupt read. |
| `worker-jobs/store.json` | Worker-pool job store (jobs, workers, gates, seq) | Survives. Atomic tmp+rename write-through before every response. |
| `worker-jobs/jobs.log`, `scheduler.log` | Append-only job transitions + scheduler decisions | Survives. |
| `worker-jobs/cost-model.json`, `quotas.json` | Cost estimates, quota windows | Survives (cost model atomic; quotas best-effort). |
| `worker-jobs/server.log` | Auto-started worker-server log | Survives. |

What does **not** survive a process/VM restart (all in-memory):

- Per-run clocks (`Host.clocks` Map, host.ts). Virtual mode restarts
  at the configured start (default 2027-01-01); real mode uses wall
  time (`Date.now()`), so it survives.
- The `pendingGate` set — but it is re-derived from the journal
  (`isGateSuspended` walks trap vs trap-result events), so no loss.
- The `pendingTrapMeta` map (dispatch provenance: adapter, worker,
  wallMs, tokens). A restart loses provenance for traps dispatched
  before the crash — their trap-result events arrive without it.
  Profiler-data gap, not a correctness gap.
- The decide-quota windows in the Host process (the pool server's
  `quotas.json` persists its own windows best-effort).
- The `extractions` map — re-derived from the content-hash cache.
- Any running process: the CLI drive loop, the worker server, worker
  subagents. All die; nothing restarts them (see §3).
- The built C host binary (`packages/durablets/out/durablets`, a
  build artifact excluded from the GitHub push) and `node_modules`.
  After a VM replacement both must be rebuilt/reinstalled, and the
  TypeScript compiler must be exactly the pinned 5.9.3
  (`gate.ts: EXPECTED_TS_VERSION`) or the host refuses to start
  (`HostRefusalError`). Recovery from a VM replacement is therefore
  rebuild + reinstall + verify versions, not just "resume".

## 2. Failure-mode table

Verdict key: **OK** = recovers automatically with no loss beyond the
stated scope. **GAP** = does not recover automatically, loses
something, or needs a human. Gaps are numbered G1–G10 and collected
in §4.

| # | Failure | What happens | What recovers | What is lost | Verdict |
|---|---|---|---|---|---|
| 1 | VM goes away / is replaced | All processes die. State under `~` survives (home persists across VM replacement). The C host binary and `node_modules` do not (build artifacts). | A new Host over the same state dir reloads journals + registry entries (`loadJournalsFromDisk`, `loadRunEntriesFromDisk`) and resumes suspended runs (rc 2/3) from `blobs/` via `runQueue`. | In-memory clocks (virtual clock resets — test-only impact), dispatch provenance for pre-crash traps, quota windows (best-effort). The rebuild/reinstall step is manual. A run whose snapshot is incompatible with the rebuilt engine cannot resume at all (see 9). A queue entry stranded at `"running"` is never re-driven (see G2). | **OK with gaps (G2, G9)** |
| 2 | C host dies mid-slice (executing workflow code, before any trap) | `spawnSync` returns null status → treated as rc 1. The run is marked failed (`finished.set(1)`, registry entry deleted, `runs/<run>.json` removed). | Nothing automatic. The blob from the *previous* suspension still exists in `blobs/`, and the journal has the full history — but there is no resume-from-last-blob command, and the run is failed in the queue. | The run's forward progress past its last suspension is recoverable only by hand surgery (reconstruct a registry entry from journal + blob). A crash is indistinguishable from a workflow error (both exit 1), so the host cannot auto-retry. | **GAP (G1)** |
| 3 | C host dies mid-suspend (while writing the snapshot) | `save_snapshot` (`durablets.c:1435-1452`) writes with plain `fopen("wb")` + `fwrite` + `fclose` — no tmp file, no rename, no fsync. A kill mid-write leaves a truncated `.snap`. | The blob store still holds the *previous* suspension's snapshot (written only after a successful suspend, sha-verified). Recovery resumes from the previous suspension and re-dispatches the last trap. | The current suspension is lost; the last trap is re-dispatched (duplicate-execution risk, see 4). If the *first* suspension's write dies, no blob exists and the run is failed, not resumable. | **OK with gaps (G3, G4)** |
| 4 | TS host dies after a worker finished but before resume (or between dispatch and resume, any trap type) | The run is suspended (blob stored, journal has the `trap` event, no `trap-result`). On recovery the run resumes from the blob and **re-dispatches the same trap**. `driveStepOnce` goes straight from `lastTrap` to `dispatchTrap` — there is no journal check for an already-dispatched trap (grep for `redispatch`/`already dispatched` finds only a repair-loop comment). The §8 design-record claim that this was "prevented by recording dispatch+result in the journal and checking before re-dispatch" is **not implemented** in the host. | The run itself resumes and completes. The gate trap is safe (answers are persisted to `runs/<run>.gate-answers.json` and consumed on re-dispatch). | The trap executes twice: a job trap enqueues a **new** job (new jobId — the server's `enqueue` has no idempotency key, so the first job's result is orphaned and the work is done twice, at twice the cost); an exec trap re-runs the command (side effects twice); a decide trap re-computes (harmless, cheap); a sleep trap re-waits the full duration in real mode. The worker server's delivery-once (late completion → 409) protects the *job record*, not the *run* — it does not apply across a run recovery. | **GAP (G3) — the largest gap in this audit** |
| 5 | TS host dies mid-run (queue / registry / drive loop) | The drive loop is synchronous and single-threaded; the run is left suspended (blob stored) or mid-slice (see 2). The queue entry was set to `"running"` *before* driving and is only updated after (`runQueue`). | Registry entries are persisted after every mutation; journals + blobs are on disk. A fresh Host reloads them. | A queue entry left at `"running"` is **never re-driven**: `runQueue` skips every entry whose status is not `"queued"`. No repair path exists. `queue.json` is written with plain `writeFileSync` (non-atomic); a crash mid-write corrupts it, and `readQueue` returns `[]` on parse error — the whole queue is silently treated as empty (all queued/running/held runs forgotten by the driver, though their journals/blobs survive). | **GAP (G2, G5)** |
| 6 | Worker dies mid-job | The server's lease sweep runs on every request and once a second (`worker-server.ts: sweepLeases`, `setInterval(..., 1000)`). An expired running job is re-queued (attempts++), or failed at maxAttempts (3). Another worker picks it up. | Automatic. Lease default 5 min (`worker-protocol.ts: DEFAULT_LEASE_MS = 300_000`), maxAttempts 3. | The dead worker's partial work (its per-worker workspace, un-returned file effects) is lost; the job is redone from scratch. | **OK** |
| 7 | Worker completes but `complete-job` never lands | The job stays `"running"` until the lease expires, then is re-queued (see 6) and redone by another worker. The server's delivery-once (a completion accepted only from the assigned worker while the job is running; a late completion is 409, journaled, never double-applied) prevents double-*application* of a completion, but it cannot recover a completion that never arrived. | Automatic re-queue. | The first worker's work is done twice (at-least-once semantics, not exactly-once). For idempotent jobs that is fine; for non-idempotent jobs (file effects, external side effects) it is a duplicate-effect risk. There is no per-jobspec idempotency policy. | **OK with gap (G6 — part of BRA-61's scope)** |
| 8 | Worker goes silent / stuck (alive, never completes) | The lease expires exactly as in 6/7 and the job is re-queued. The worker loop heartbeats (`worker-loop.ts` beats every `min(30s, leaseMs/3)`; `WORKER.md` instructs subagent workers to heartbeat every ~60s on long jobs; the server's `/heartbeat` endpoint extends the lease and reports `cancelled:true`). | Automatic re-queue after lease expiry. | No *nudge*: nothing messages a silent worker before its lease expires. The lease is a fixed config default (5 min), not derived from the cost estimate (`estDurationMs` is recorded at enqueue but never used for the lease). No idempotency policy (see 7). **Correction to BRA-61's premise:** the lease/heartbeat/re-queue safety net already exists; BRA-61 should be rescoped to the nudge + idempotency policy + cost-derived lease, not built as if nothing exists. | **OK with gaps (G6 — BRA-61, rescoped)** |
| 9 | Queue / scheduler dies with jobs in flight | The worker-job store (`store.json`) is durable and atomic (tmp+rename, write-through before every response). The run queue (`queue.json`) is durable but non-atomic (see 5). The scheduler is pure (no state) — nothing to lose. The worker server is a long-lived process with a 1s sweep timer; if it dies the sweep stops and jobs sit `"running"` until it restarts. | The muse adapter auto-starts the server (detached) on the next job trap (`ensureServer`, up to 10s wait for `/health`); on restart the store is reloaded and `sweepLeases` runs on the next request, re-queuing expired jobs. | A corrupt `store.json` makes `loadStore` start **fresh** (all jobs forgotten; `jobs.log` keeps the history but nothing replays it). Reachable mainly via disk corruption or a bug, since writes are atomic. Quota windows persist best-effort (`saveQuotas` swallows failures) — a lost save resets the token/decision windows and can allow overspend after a restart. The local task mirror (`task-runs.json`) is non-atomic and starts fresh on corrupt read, losing in-flight links (admittance then relies on the host queue + Linear issue states as second signals). | **OK with gaps (G5, G7)** |
| 10 | Gate held for days | The run is suspended (rc 2, blob in `blobs/`, `gate-held` event in the journal). The answer is delivered via `agentts deliver-gate`, persisted to `runs/<run>.gate-answers.json`, and the queue entry flips held→queued. | The gate state itself is fully durable — nothing is lost by waiting. | **Nothing wakes the run.** `deliver-gate` does *not* drive; it prints `agentts queue run --state-dir …` and the run only resumes when someone runs it. No watcher, no notification loop, no cron. The muse adapter's `/gate-notify` is best-effort so a polling coordinator *can* see the pending gate — but nothing polls it. Minor: delivering a gate answer twice queues a second answer, which would be consumed by the *next* gate trap in the run (misdelivery) — `deliverGate` refuses only when no gate is pending, and a second delivery still sees the journal-pending gate. | **GAP (G8 — the cron/supervisor closes this)** |
| 11 | Coordinator goes away / conversation compacts | A fresh coordinator can reconstruct a run from disk alone: `queue.json` (runId + workflow + input + status), `runs/<run>.json`, the journal, `blobs/<run>.snap`, the workflow source, the schema cache. `agentts status` / `agentts result` / `agentts queue list` all work from the state dir alone. | Yes, from disk. | Two holes. (a) **Which state dir:** the default is cwd-dependent (`./.agentts-state`); a fresh coordinator starting in a different cwd sees a different, empty state dir and the run is invisible. The runId alone does not locate the state. (b) **No frozen workflow copy:** the registry records the workflow's original path and `ensureExtraction` re-reads it on resume. Editing a workflow file while a run is suspended changes what the resumed run executes and validates against — the extraction cache is keyed by content hash (a changed file gets fresh schemas), but there is no frozen copy of the *source* for execution. The design record's frozen-copy store is referenced in comments (`extract.ts:724`, `agentts.ts:23`) but is not implemented as a store. For a week-long gate this is a live hazard. | **GAP (G9)** |
| 12 | Engine rebuild / upgrade between suspend and resume | Snapshots load only into the same engine build (same version, same native registry in the same order, same word size — prototype record, and `JS_ReadSnapshot` failure returns 1). There is no snapshot version check and no friendly error — just the engine's error string to stderr and exit 1. | None. | The suspended run is unresumable: its blob is garbage to the new build. The journal survives as the audit trail, but the run must be restarted from scratch with a new runId, re-doing completed traps. (Replay was deliberately dropped as a design decision, so there is no rebuild-from-journal path.) The pin (`UPKEEP.md`, dquickts `96a9a79`) and the vendor/trim procedure mitigate this operationally, not mechanically. | **GAP (G10)** |
| 13 | Sleep / cron trap across a host restart | In real mode sleep/cron **block the drive loop** (`Bun.sleepSync`, host.ts `waitReal`) — they are not suspensions to a timer. The run *is* suspended at the trap (blob stored) while the TS host blocks. If the host dies during the wait, the trap is re-dispatched on recovery. | Cron (absolute datetime) recovers correctly: the wait is recomputed as `target - Date.now()`, so only the remaining time is waited. | Sleep (relative duration) re-waits the **full** duration — the elapsed wait is lost (the clock is in-memory and sleep progress is never recorded). A 1-hour sleep interrupted at 59 minutes waits another full hour. In virtual mode the clock resets to the configured start on restart (test-only impact). There is no timer/alarm facility at all: a due sleep/cron fires only when the drive loop reaches it — if nothing is driving (`queue run` is not running), a due timer does nothing. | **GAP (G8 for the driver, G11 for sleep progress)** |
| 14 | Run needs >50 suspensions in one drive | `driveToCompletion` throws `drive loop exceeded` after 50 rounds (host.ts:1850). | Loud failure, not silent. The blob is intact from the last suspension. | The queue marks the run failed and never retries a failed entry — resuming it is manual. Real workflows today are well under 50 (the briefing parent has ~2 combinators; branch drives are separate), so this is a latent limit, not a live failure. | **GAP (G12 — latent limit)** |
| 15 | Two `queue run` drivers at once | `runQueue` has **no lock** (grep for flock/lockfile: zero matches). Two concurrent drivers over the same state dir both read `queue.json`, both see `"queued"`, both drive the same runId. | None. | `startRunFrom` **deletes the run's journal file** on a re-run, and both drivers would execute the same traps — journal loss + double execution. The supervisor must enforce single-instance (flock); the code does not. | **GAP (G13)** |
| 16 | Adapter timeout vs server retries | The muse adapter waits at most 10 min per job (`DEFAULT_JOB_TIMEOUT_MS = 600_000`), but its own comment states the timeout "must exceed leaseMs * maxAttempts" — 5 min × 3 = 15 min. The default violates its own documented constraint. | The server would have retried the job twice more. | A job that needs 3 attempts (two slow workers timing out, third succeeding at ~12 min) throws `JobTimeout` at 10 min even though the job would have completed. The run fails although the work would have succeeded. | **GAP (G14)** |
| 17 | Corrupt journal line | `loadJournalsFromDisk` **throws** on a corrupt line, and the Host constructor calls it — so one corrupt line in *any* journal prevents the host from starting at all: no runs can be driven, no gate answers delivered. (Contrast: the cost log skips corrupt lines, and the worker store starts fresh.) | Loud failure — but fail-everything, not fail-contained. | All runs in the state dir are undrivable until a human removes or repairs the corrupt line. | **GAP (G15)** |

## 3. Do we need a cron / supervisor? Yes — and what exactly it is

**Yes.** The system as built has no background driver at all: nothing
runs `queue run`, nothing delivers gates, nothing checks the worker
server, nothing keeps workers alive, nothing re-drives stranded runs.
Everything is an on-demand CLI invocation. The durable state (journal,
blobs, queue) is the *substrate* for recovery, but nothing *acts* on
it unless a human or the coordinator runs a command. The supervisor
is the missing piece that makes the durable state actually progress —
especially for week-long gates, where the run must wake days after the
coordinator last looked at it.

The mechanism is the runtime's cron system (job files under
`~/workspace/cron.d/`, YAML frontmatter: `id`, `enabled`, `mode:
task`, `schedule: {kind: interval, timezone, every}` + a markdown
body — see `cron.d/hourly/vtt-hourly-deepdive__interval@1h.md` for
the format). Two jobs, both pinned to an **absolute** `--state-dir`
(never the cwd default — a cron's cwd is not the working directory
the runs were submitted from):

### Job 1 — queue driver + worker health (every 5 minutes)

Command (single-instance via `flock` — the code has no locking, see
G13, so the supervisor must provide it):

```sh
flock -n /home/hatch/workspace/agentts-host/.agentts-state/driver.lock \
  /opt/hatch-image/bin/bun /home/hatch/workspace/agentts-repo/apps/agentts/src/cli.ts \
  queue run --state-dir /home/hatch/workspace/agentts-host/.agentts-state
```

What it checks, each run:
- `queue run` exit code (0 = all driven, 1 = a run failed, 2 = held
  at a gate). A non-zero exit is reported, not swallowed.
- `agentts queue list` for entries stuck at `"running"` (stranded by
  a crashed driver — G2) or `"held"` with no gate answer older than
  the operator expects. Stranded entries are **reported, not
  auto-flipped**: flipping `"running"`→`"queued"` while a live
  driver holds the lock would double-drive. The flock + a staleness
  check (entry untouched longer than the driver interval) is the
  safe repair, and it needs a `queue repair` command that does not
  exist yet — file it, do not hand-roll it in the cron.
- `agentts worker status` (server `/health` + job counts): the
  worker server answers, and queued jobs have workers that have been
  seen recently. If jobs are queued with no live workers, the cron
  alerts (it cannot spawn Muse subagents itself); the coordinator
  spawns workers. For specs with registered Bun worker scripts the
  cron *can* start a script-mode worker loop directly
  (`bun plugins/muse/worker-loop.ts --server … --worker-id …`).

What it does on failure: the run's journal already records the
failure; the cron's job is to surface it (its output lands in the
goal/chat log) and to keep driving. It never deletes state, never
edits `queue.json` by hand, never re-enqueues a failed run.

Why 5 minutes: gates are human-timescale (hours/days), but a crashed
driver or a delivered gate answer should be noticed promptly, and a
no-op `queue run` on an empty queue is cheap. A week-long gate costs
nothing to poll.

### Job 2 — daily state health check (once a day)

Command: a small script (or a `bun` one-liner) that verifies, against
the same absolute state dir:

- the state dir exists; the C host binary exists at the resolved
  path (`$DURABLETS_HOST` or the repo candidates) and was built from
  the pinned dquickts commit (`UPKEEP.md`: `96a9a79`);
- `node_modules` present and `typescript` is exactly 5.9.3 (the gate
  refuses any other version — a reinstall that drifts the version
  bricks every run start, loudly);
- every `journals/*.journal` parses as JSONL (a corrupt line bricks
  Host construction — G15, so detect it early, not at 2am during a
  gate delivery);
- `queue.json` and `worker-jobs/store.json` parse;
- `agentts worker status` answers.

On any failure: alert the coordinator with the exact check that
failed. This is also the post-VM-replacement recovery check: after a
VM replacement the first thing that must happen is rebuild the C
host + reinstall deps + verify versions, and this job is what proves
it worked.

### What the supervisor must NOT do

- Never run two drivers concurrently (flock; see G13).
- Never auto-flip a `"running"` queue entry to `"queued"` without a
  staleness check + the lock held (double-drive risk).
- Never delete or edit journals, blobs, or `queue.json` by hand.
- Never auto-restart a *failed* run — a failed run is a decision
  (retry from the last blob is a human/coordinator call until a
  resume-from-last-blob command exists — G1).

## 4. Gap list (prioritised)

1. **G3 — re-dispatch duplicates trap execution after a host crash.**
   No journal check before re-dispatch (`driveStepOnce`). A job trap
   enqueues a new job (orphaning the first job's result); an exec
   trap re-runs (side effects twice); a sleep re-waits in full.
   Fix: record dispatch in the journal and check it before
   re-dispatch; or make job enqueue idempotent on `trapId` (the
   server's `enqueue` should refuse a second live job for the same
   `trapId`). Highest priority — it is the §8 residual the design
   record believed was already fixed.
2. **G2 — queue entries stranded at `"running"` are never re-driven.**
   `runQueue` skips non-`"queued"` entries; no repair command
   exists. Fix: a `queue repair` command (staleness-checked, under
   the driver lock) + a staleness report in the supervisor cron.
3. **G13 — no locking: two concurrent `queue run` drivers corrupt a
   run.** `startRunFrom` deletes the journal on re-run. Fix: a lock
   file around the drive (flock in the supervisor now; in-code
   locking as the durable fix).
4. **G5 — `queue.json` non-atomic write + silent loss on corrupt
   read.** `readQueue` returns `[]` on parse error. Fix: tmp+rename
   writes (as the worker store already does) and a loud error —
   never an empty queue — on corrupt read.
5. **G15 — one corrupt journal line bricks the whole Host.**
   `loadJournalsFromDisk` throws in the constructor. Fix: quarantine
   the corrupt journal (skip it, loudly, per-file) instead of
   failing every run in the state dir.
6. **G9 — no frozen workflow copy.** Editing a workflow while a run
   is suspended changes what the resumed run executes. Fix: copy the
   workflow source (+ its library files) into the state dir at
   submit time and resume from the frozen copy.
7. **G10 — engine upgrade orphans suspended runs.** Snapshots are
   same-build-only with no version check. Fix: record the engine
   build (commit + registry order) in the blob/registry at suspend
   time and refuse loudly *before* attempting a resume with a
   different build — plus an operational rule: never upgrade the
   engine while runs are suspended.
8. **G1 — no resume-from-last-blob path.** A C-host crash mid-slice
   fails the run although its last blob is intact. Fix: a `resume
   <runId>` command that re-drives from the last stored blob.
9. **G8 — nothing wakes a held gate or drives the queue.** Closed by
   the supervisor cron in §3 (the driver job). The remaining piece
   is the `queue repair` command (G2).
10. **G14 — adapter timeout (10 min) is shorter than the server's
    worst-case settle time (lease 5 min × 3 attempts = 15 min).**
    Fix: raise `AGENTTS_MUSE_JOB_TIMEOUT_MS` above
    `leaseMs * maxAttempts` (or derive it from the server config).
11. **G11 — sleep progress is not durable.** A relative sleep
    re-waits in full after a host crash. Fix: record the sleep's
    start (wall clock) in the journal at dispatch and wait only the
    remainder on re-dispatch. (Cron is unaffected — absolute.)
12. **G12 — 50-round drive cap.** Latent limit; a run needing >50
    suspensions in one uninterrupted drive fails loudly. Fix: raise
    or remove the cap (it reads as a test guard) or make it
    per-run-configurable, and document the limit.
13. **G6 — no per-jobspec idempotency policy (BRA-61 scope, rescoped).**
    At-least-once re-queue redone work; non-idempotent jobs risk
    duplicate effects. Fix: per-jobspec idempotency flag; non-
    idempotent jobs check journal + workspace state before re-queue,
    or escalate instead of silently re-running. Also missing from
    BRA-61's original scope: the nudge (nothing messages a silent
    worker before lease expiry) and a cost-derived lease (the lease
    is a fixed 5 min; `estDurationMs` is recorded but never used
    for it).
14. **G7 — corrupt worker store starts fresh (jobs forgotten).**
    `loadStore` swallows a corrupt `store.json` and rebuilds empty.
    Fix: keep a backup copy (rotate `store.json` on each save) or
    replay `jobs.log` to rebuild the store.
15. **G4 — snapshot write is non-atomic (no tmp+rename, no fsync).**
    Mitigated by the blob store holding the previous suspension, but
    the first suspension has no fallback. Fix: write to tmp +
    rename (+ fsync) in `save_snapshot`, same for `write_result_json`.

## 5. What is already good (verified, not assumed)

- **Journals are the source of truth and they are durable.**
  Append-only JSONL, JSON-clean-checked before write, `wallTs` on
  every event, reloaded from disk on construction. The briefing
  fixture journal shows the real shape (`lifecycle` / `trap` /
  `suspended` events with runId, trapId, ordinal, type, arg).
- **Blobs are sha-verified on store and on restore** (`storeBlob` /
  `loadBlob`), and the parent snapshot is hash-checked untouched
  while children run (`snapUntouched`).
- **The worker-job store is atomic** (tmp+rename, write-through
  before response) with a 1-second lease sweep and delivery-once
  completions (late completion → 409, journaled, never
  double-applied). Lease (5 min) + heartbeat + maxAttempts (3)
  already exist — see the BRA-61 correction in §2 row 8.
- **Gate answers are persisted before the run is re-queued**
  (`queueGateAnswer` writes to disk; `deliverGate` flips the queue
  entry after). A delivered answer survives the delivering process.
- **The muse adapter auto-starts its worker server** (detached,
  health-checked, up to 10s wait) when none is running — the server
  is not a manual daemon in the muse path.
- **The gate refuses loudly** on a missing or wrong-version
  TypeScript compiler, and the schema cache is keyed by content
  hash + compiler + checker version, so a stale gate result is
  never trusted.
- **Registry entries persist after every mutation**, and only
  suspended entries (rc 2/3) are restored on reload — done/failed
  runs do not come back as zombies.
- **Quotas are enforced at dispatch** (pool size, CPU slots,
  decision rate, token budget) with live counts read from the
  store, so a restart cannot desync the live quotas.

## 6. BRA-61 correction (recorded here because the audit checked it)

BRA-61 was filed on the premise that a stuck worker has no
automatic recovery. The code shows the recovery already exists:
lease expiry → re-queue (attempts++) → fail at maxAttempts, with a
1-second sweep and a heartbeat endpoint the worker loop uses. What
BRA-61 should cover instead: the nudge (nothing messages a silent
worker before expiry), the per-jobspec idempotency policy (at-
least-once re-queue redoes non-idempotent work), and a cost-derived
lease (the lease is a fixed 5 min; the cost estimate is recorded
but never used for it). Recommend rescoping BRA-61 to those three,
not building lease/heartbeat/re-queue as if they were missing.
