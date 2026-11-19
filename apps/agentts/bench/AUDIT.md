# AgentTS performance audit (BRA-93)

Measured 2026-11-16 on this VM with the bench suite in
`apps/agentts/bench/` (run: `bun bench/run.ts`, baselines in
`bench/baselines.json`). Every number below is a median of 5 reps unless
stated otherwise. Two independent full runs were made; where they
differed by more than ~30% both numbers are shown — the machine was
shared with the MVP flush worker, so run-to-run variance up to ~2.2x
on spawn-bound metrics is demonstrated noise, not signal.

**No benchmark suite or regression threshold existed before this work.**
Verified by grep: the profiler journals `wallMs` per trap, and `run.sh`
mentions a "per-tier thresholds" suite name only. This audit is the
first measurement.

**No new correctness problem found.** Nothing in the audit is a silent
loss/corruption issue. The one known correctness problem in this area,
the enqueue read-modify-write race, is already filed as BRA-82 (MVP
blocker, in flight) — this audit measures its cost, it does not
re-discover it.

**BRA-90 (incremental snapshots) is excluded** — in flight as an MVP
blocker. Items 5 and 6 below are the baselines BRA-90 will be judged
against, not recommendations.

## Headline: where a run's time goes

A trivial warm run costs **69ms** end to end (`drive_ms.trivial.warm`).
Its parts, measured separately:

| Part | Measured | Share of the 69ms |
|---|---|---|
| One C-host slice (spawn + QuickJS init + snapshot read + eval) | 43.6ms (`slice_spawn_ms`; 20.5ms in run 1) | ~60% |
| notifyEvent (curl spawn + POST) | 10.5ms | ~15% |
| Bun.build of the driver bundle | 5.1ms | ~7% |
| Queue + run-entry writes | ~2–4ms (enqueue 0.9ms; updateQueueEntry ~1ms each) | ~5% |
| Journal appends | ~0.1ms (0.01ms/event) | ~0% |
| Snapshot I/O at trivial heap | ~5ms (fsync-atomic at small size) | ~7% |

A suspending run at 500KB live heap costs **70ms**
(`suspend_ms.500kb`): spawn 44 + fsync-atomic 26 + blob recipe 9,
with overlap/variance covering the sum. The same three costs dominate
at every heap size; at 5MB the suspend is 155ms.

A cold first run of a new workflow costs **1,693ms**
(`run_e2e_ms.trivial.cold`): submit 1,600ms, of which extract-cold
(tsc) is 1,501ms — 94% of the cold submit. The warm path is 0.6ms.

## Ranked opportunities

Ranked by measured impact on a typical run. Each item carries the
devil's advocate in three columns — (1) measured now, (2) theoretical
ideal / lower bound, (3) the architectural rethink — plus the price
tag and a verdict. A large gap with a disproportionate price is a
documented **not now** (or **never**), not a task.

### 1. Per-slice process spawn — the floor under everything

- **Measured now:** one slice = 43.6ms median (20.5ms in run 1).
  Every drive step pays it (`trap_step_ms.median` 37ms is ~90%
  spawn); every fork branch pays it (`fork_ms.per_branch` 43ms); a
  200-trap run spends ~7.4s of its ~8s in spawns.
- **Theoretical ideal:** ~0ms spawn — a persistent C host process
  holds the runtime; a resume is an IPC round-trip (~1ms). A
  200-trap run would cost ~0.2s of driving instead of ~7.4s.
- **Rethink:** keep one long-lived DurableTS process per run (or per
  host) instead of one process per slice; the snapshot stays the
  durable record, the process is just a cache of it.
- **Price tag:** HIGH complexity, HIGH risk. The whole durability
  model rests on "one slice = one process; a crash loses nothing
  because state is on disk". A persistent host must survive its own
  crashes without losing the in-memory runtime, needs a supervisor and
  a restart protocol, and re-introduces exactly the failure modes
  BRA-74/76/77 hardened against (crash mid-slice must not corrupt the
  blob). Maintainability: a new long-lived component with its own
  lifecycle, on top of the worker pool that already exists. Time:
  weeks, plus re-proving the fault-injection suite.
- **Verdict: NOT NOW.** The spawn tax is ~40ms/step and the MVP's
  workload is agent steps that take seconds-to-minutes of model time.
  Revisit only if a workload needs sub-second step latency or
  >1,000 steps/run. The bench measures the spawn directly, so the
  alarm will catch any regression in it.

### 2. Cold extract: tsc createProgram on first run

- **Measured now:** 1,501ms cold (`extract_ms.cold`; 1,165ms in run 1),
  0.61ms warm (cache hit). Cold submit is 1,600ms; cold e2e 1,693ms.
  The extract is 94% of a cold submit and the single largest absolute
  number in the suite.
- **Theoretical ideal:** 0ms — schemas pre-compiled at author time, or
  a persistent tsc process (tsserver) amortizing the program load
  across runs. First run of a new workflow would cost what a warm run
  costs (~70ms).
- **Rethink:** (a) a tsc daemon the host talks to instead of spawning
  tsc per extract; (b) ship workflows with their schemas, verified
  against the source at submit time.
- **Price tag:** MEDIUM for both. (a) is a new long-lived process with
  lifecycle/supervision — the same family of problem as item 1, smaller.
  (b) changes the authoring contract: "types are the only source of
  truth" only holds if the shipped schema is verifiably derived from
  the same source, which needs a hash/check step — and staleness
  (schema != code) is exactly what the first-run gate exists to
  prevent. Risk: a stale schema silently validates wrong results.
  Time: days for either, plus proof.
- **Verdict: NOT NOW.** The cold cost is paid once per workflow
  version and cached by content hash. It only hurts the first run of
  a new workflow. Revisit if first-run latency matters (interactive
  use, many one-off workflows).

### 3. Two fsyncs per suspension

- **Measured now:** `write_file_atomic` (fwrite + fflush + fsync file
  + rename + fsync dir) = 26.2ms @500KB vs 0.8ms for a plain
  write+rename — a 33x cost for the durability, ~37% of a 500KB
  suspend. At 5MB the suspend is 155ms and the fsync share grows.
- **Theoretical ideal:** 0.8ms (plain write) or one fsync (~13ms), or
  batched/group-committed fsyncs across suspensions.
- **Rethink:** drop to one fsync, drop fsyncs entirely and rely on
  tmp+rename (process-crash safety only), or fsync only at
  durability boundaries (gate/job completion) rather than every sleep
  trap.
- **Price tag:** MEDIUM risk, LOW complexity to implement. The fsyncs
  are what make the snapshot durable across a machine crash; dropping
  them re-opens the torn-snapshot hole BRA-83 is closing. The threat
  model decides: process crash (tmp+rename suffices) vs power loss
  (needs the fsyncs). A per-trap-type fsync policy needs a durability
  argument per trap type, not a blanket change. Time: hours to make
  configurable, days to prove.
- **Verdict: NOT NOW for the MVP.** Durability is the product; do not
  trade it for 25ms/step. Candidate for a documented trade-off later,
  decided with the threat model in hand. BRA-90 shrinks the bytes
  fsynced at large heaps, which reduces this cost proportionally.

### 4. Blob recipe: copy + 3x sha256 per suspension

- **Measured now:** 8.8ms @500KB (`blob_recipe_ms.500kb`; 19.6ms in
  run 1) — copyFileSync of the snapshot plus sha256 of source, tmp,
  and dest. ~13% of a 500KB suspend.
- **Theoretical ideal:** 0 copies + 1 hash (~3ms), or 0 hashes if the
  snapshot is already content-addressed by the C host at write time.
- **Rethink:** audit which of the three hashes catches what; drop the
  redundant ones; or have the C host return the snapshot's hash with
  the write, so the host never re-reads the bytes to hash them.
- **Price tag:** LOW–MEDIUM. The hashes are the corruption-detection
  mechanism (BRA-77); removing one needs a reasoned argument about
  which check catches which failure. The copy exists because the C
  host writes into the slices dir and the blob store is the durable
  copy — removing it means the C host writes directly to the blob
  store, which changes the atomicity story. Time: hours to measure
  and decide.
- **Verdict: INVESTIGATE (small, post-MVP).** The cheapest item on
  this list with a real number attached. Measure which hash is
  redundant; a 1-hash recipe saves ~2/3 of this cost. Not
  MVP-blocking.

### 5. Fork: full snapshot copy per branch (BRA-90 territory)

- **Measured now:** 43.0ms/branch (`fork_ms.per_branch`) at trivial
  heap — mostly the slice spawn (item 1); the copy itself is ~1–2ms
  at this size and scales with heap size. At 5MB heaps the copy is a
  real cost; at trivial heaps it is noise.
- **Theoretical ideal:** 0-copy fork — a branch references the
  fork-point checkpoint by content hash and extends its own chain
  (the BRA-90 design: chain linked by hash, like git commits).
- **Rethink:** the hash-linked checkpoint chain (already decided for
  BRA-90, in flight).
- **Price tag:** covered by BRA-90.
- **Verdict: IN FLIGHT — excluded from this audit per the brief.**
  This measurement (43ms/branch, copy ~1–2ms at trivial heap) is the
  baseline BRA-90 will be judged against.

### 6. Snapshot size: baseline + live heap, uncompressed, ~1:1

- **Measured now:** 36,472B @1KB live; 137,862B @100KB; 547,463B
  @500KB; 1,059,468B @1MB; 5,155,469B @5MB. Snapshot ≈ 36KB baseline
  + live heap, uncompressed. Reproduces the Nov 16 BRA-90 measurement
  within 3%.
- **Theoretical ideal:** a delta against the previous snapshot
  (BRA-90: only what changed), or a compressed full snapshot.
  Compression alone would cut the bytes (and the fsync/copy/hash
  costs that scale with them) by a large factor; deltas cut them
  further for small mutations.
- **Rethink:** BRA-90 deltas (in flight); separately, a deflate pass
  on snapshot write.
- **Price tag:** deltas are BRA-90's. Compression is LOW complexity
  (a pass on write/read) but changes the blob format and the C host's
  read path, and every reader must agree on the format. Time: hours
  to days.
- **Verdict: IN FLIGHT for deltas (BRA-90). Compression is NOT NOW**
  as a separate change — the bytes only cost when the heap is large,
  and BRA-90 addresses large heaps directly. Revisit if deltas land
  and large-heap runs are still I/O-bound.

### 7. Queue read-modify-write

- **Measured now:** enqueue 0.91ms into an empty queue, 1.31ms with
  200 entries (1.4x). Every queue write parses the whole queue.json,
  pretty-prints a full `.bak`, then atomic-writes queue.json; every
  status flip re-reads; `runQueue` does 2+ writes per run plus repair
  plus a final read.
- **Theoretical ideal:** a single append — O(1) regardless of queue
  size, no rewrite, no re-parse.
- **Rethink:** an append-only queue log with compaction, or an index
  over the existing file.
- **Price tag:** MEDIUM–HIGH. The queue file is the source of truth
  for recovery (BRA-77 backup, BRA-72 repair classifies "running"
  entries by reading it); an append-log needs compaction,
  crash-recovery replay, and a new corruption story. The whole-file
  rewrite is what makes backup/recovery simple. Do not churn the
  design while BRA-82 (the RMW race) is being fixed in place. Time:
  days.
- **Verdict: NOT NOW.** 1.3ms is invisible next to the 69ms drive,
  and the scaling (1.4x at 200 entries) is gentle. Revisit at
  10k-entry queues. The bench measures enqueue at 0 and 200 entries,
  so the alarm will catch a scaling regression.

### 8. Journal: full args/results, per-trap linear scans

- **Measured now:** one `journalEvent` append = 0.01ms (small) /
  0.03ms (10KB payload) — journaling is not a hot cost. Per-trap
  scans: `trap_step_ms.first5` 40.11ms vs `last5` 38.23ms over a
  200-trap run (~2,000 events) — **no measurable growth**. Host
  construction: 1.63ms @~1,000 events, 42.5ms @100,000 events
  (linear, ~0.43us/event). The double-parse noted in the code
  (host.ts:1025 — a journal file parsed twice on load) is a 2x
  constant on construction.
- **Theoretical ideal:** O(1) per-trap lookups (trap results indexed
  by trapId), truncated/omitted large args, lazy per-runId journal
  loading, parse-once construction.
- **Rethink:** an in-memory trap-result index maintained on load;
  payload truncation for large args; lazy journal loading.
- **Price tag:** MEDIUM. Indexing changes the journal's "append-only
  record" simplicity; truncation changes the debugging/profiling story
  (BRA-73's profiler wants full args). The double-parse fix is a
  small refactor but touches load paths BRA-77's corruption handling
  depends on. Time: days for the index, hours for parse-once.
- **Verdict: NOT NOW — monitor, don't fix.** At <=200 traps the scans
  are unmeasurable; at 100k events construction is 43ms (fine for a
  CLI invocation). The real risk is a long run with 10k+ traps, where
  the quadratic would show — the bench measures first5 vs last5, so
  the alarm catches it if a workload gets there. Parse-once is a
  small post-MVP cleanup worth doing with the next load-path change.

### 9. Bundle rebuilt per run (no bundle cache)

- **Measured now:** 5.08ms per `Bun.build` (`bundle_ms`; 10.3ms in
  run 1). Extraction is cached by content hash; the bundle is rebuilt
  every run.
- **Theoretical ideal:** 0ms — cache the bundle by the same content
  hash (the bundle is a deterministic function of the frozen workflow
  + engine version).
- **Rethink:** a bundle cache keyed by frozenHash + engineVersion +
  bundler/driver-template version.
- **Price tag:** LOW. The cache key already exists; the risk is cache
  invalidation if the bundler or driver template changes, so the key
  must include those versions. Time: hours.
- **Verdict: WORTH DOING (post-MVP, small).** Saves ~5ms/run plus a
  Bun.build spawn. Modest — 5ms against a 69ms drive is why it ranks
  below the spawn/fsync items despite being the cheapest fix.

### 10. notifyEvent: a curl process spawn per completion

- **Measured now:** 10.46ms to a live loopback server, 8.46ms to a
  dead port — the curl spawn dominates; the server round trip is only
  ~2ms. Best-effort, swallowed on failure, off the durability path.
- **Theoretical ideal:** ~0ms — an in-process HTTP client (Bun has
  fetch) or a persistent connection; no process spawn per event.
- **Rethink:** replace the curl spawnSync with fetch.
- **Price tag:** LOW, but the reason curl was chosen is not recorded
  (possibly to avoid blocking the event loop or for proxy behavior) —
  check before changing. Time: hours.
- **Verdict: WORTH DOING (post-MVP, low priority).** ~10ms per run
  completion, and it happens after the result is durable, so it never
  delays a run. Do it when touching notifyEvent for another reason.

### 11. Fresh-CLI result fetch: Bun startup

- **Measured now:** `result()` in-process = 0.04ms; via a fresh
  `bun src/cli.ts result` = 498ms — ~497ms of it is Bun startup, not
  Host work (construction is 0.4–1.6ms at these journal sizes).
- **Theoretical ideal:** ~0ms — a persistent CLI daemon or a compiled
  binary.
- **Rethink:** a daemon, or compile the CLI.
- **Price tag:** HIGH. A daemon is a new deployment shape with its
  own lifecycle; a compiled binary changes the build. Both for an
  operator tool.
- **Verdict: NEVER (for this product).** The CLI is an operator tool,
  not a hot path; 500ms per invocation is fine. Documented "never" —
  do not chase. (If a script ever calls `agentts result` in a tight
  loop, use the in-process Host API instead.)

  **Superseded 2026-11-17 (BRA-100).** The verdict above measured
  correctly but assumed wrongly about who calls the CLI: the
  production driver (the tick agent) invokes it per action, so the
  CLI *is* a hot path for the deployed system. The production path
  is now benched end to end (`production_path` group, 9 metrics),
  counted (11 fresh Bun processes per unit of work), and gated —
  see `bench/AUDIT-BRA100.md` for the measured tax (~2.3s per run
  vs ~63ms in-process) and the evaluation of the ideal (CLI as a
  server on the existing worker server, recommended). The original
  verdict is kept here as history; the live position is in
  AUDIT-BRA100.md.

## What is already cheap (do not optimize)

- **Journal appends** (0.01ms) and **queue writes** (0.9–1.3ms) are
  rounding errors next to the spawn. The audit's early hypothesis —
  that the queue RMW and the journal scans were hot — did not survive
  measurement.
- **Bundle** (5ms) and **extract-warm** (0.6ms) are cheap; only the
  cold extract is expensive, and only once per workflow version.
- **Host construction** (0.4ms empty, 1.6ms @1k events, 43ms @100k
  events) is fine at any realistic journal volume.

## Summary table

| # | Opportunity | Measured cost | Ideal | Price | Verdict |
|---|---|---|---|---|---|
| 1 | Per-slice process spawn | 43.6ms/step, ~60% of a warm drive | ~1ms IPC | HIGH complexity + HIGH risk (durability model) | NOT NOW |
| 2 | Cold extract (tsc) | 1,501ms, once per workflow version | 0ms | MEDIUM (daemon or pre-compiled schemas; staleness risk) | NOT NOW |
| 3 | Two fsyncs per suspension | 26.2ms @500KB, ~37% of suspend | 0.8ms | MEDIUM risk (power-loss durability) | NOT NOW |
| 4 | Blob recipe (copy + 3x sha256) | 8.8–19.6ms @500KB | ~3ms | LOW–MEDIUM | INVESTIGATE |
| 5 | Fork snapshot copy | 43ms/branch (mostly spawn) | 0-copy | BRA-90 | IN FLIGHT |
| 6 | Snapshot size (uncompressed, ~1:1) | 36KB + heap | delta/compressed | BRA-90 / LOW | IN FLIGHT / NOT NOW |
| 7 | Queue RMW | 0.91ms, 1.31ms @200 entries | O(1) append | MEDIUM–HIGH (recovery story) | NOT NOW |
| 8 | Journal linear scans | Unmeasurable @200 traps; 43ms construct @100k events | O(1) indexed | MEDIUM | NOT NOW (monitor) |
| 9 | Bundle rebuilt per run | 5.08ms | 0ms (cache) | LOW | WORTH DOING |
| 10 | notifyEvent curl spawn | 10.46ms | ~0ms | LOW | WORTH DOING (low priority) |
| 11 | Fresh-CLI Bun startup | 498ms | ~0ms | HIGH (new deployment shape) | NEVER |
