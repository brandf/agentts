# AgentTS benchmarks (BRA-93)

Repeatable benchmark suite + regression alarms for the AgentTS host and
DurableTS core. Every number in `baselines.json` was measured by running
this suite on this VM — nothing is invented.

## What exists today (verified 2026-11-16)

There was **no benchmark suite and no regression threshold** before this
work. Grep of the repo: the profiler journals `wallMs` per trap
(`src/profiler.ts`), and `run.sh` mentions a "per-tier thresholds" suite
name in the BRA-47 context only — no suite, no baselines, no check.
This directory is the first.

## Layout

- `run.ts` — the suite. Runs the hot paths against throwaway state dirs
  under `~/workspace/agentts-perf-state` (never the production state dir,
  never the flush worker's scratch dir). Prints a per-metric table and
  writes a JSON results file.
- `workflows/` — the bench workflows (`bench-trivial.ts`, `bench-snap.ts`,
  `bench-traps.ts`, `bench-fork.ts`). New files only; no production code
  was touched.
- `notify-server.ts` — throwaway HTTP server for the notify benchmark.
  It runs as its own process: `notifyEvent` POSTs via a blocking curl
  spawn, so an in-process server could never answer while the runner is
  blocked in `spawnSync` (deadlock — measured 0 hits the first way).
- `baselines.ts` — the baseline format, threshold multiples, the ratchet
  rule, and the manual-loosen path. One file owns the format so `run.ts`
  and `check.ts` cannot drift apart.
- `baselines.json` — measured medians + thresholds (43 metrics).
- `check.ts` / `check.sh` — the alarm check (below).
- `results/` — dated raw results files (`results-2026-11-16.json` is the
  run the baselines were taken from).
- `AUDIT.md` — the ranked audit with measured numbers, the idealized
  devil's advocate per metric, price tags, and verdicts.
- `ratchet.log` — append-only audit log of every ratchet and loosen
  (created on first ratchet/loosen; absent until then).

## How to run

```sh
cd apps/agentts
bun bench/run.ts [--reps N] [--metrics id,...] [--out FILE] [--write-baselines] [--list]
./bench/check.sh [--reps N] [--no-ratchet] [--results FILE]
./bench/check.sh loosen <metric> <newBaseline> --reason "..."
```

- `run.ts` defaults: 5 reps, all metrics, prints the table. Full suite
  takes ~2 min (the 200-trap step metric is the slow part, ~50s).
- `--write-baselines` rewrites `baselines.json` from the run's medians.
  Only do this after reviewing the numbers — a baseline is a claim
  about what the code does, not an auto-generated artifact.
- `check.sh` runs the suite (default 3 reps), compares each metric's
  median against its threshold, and exits 0 (all green) or 1 (any
  breach, missing metric, or suite failure). A breach never changes a
  baseline.

## Metrics (43)

| Group | Metrics | What it measures |
|---|---|---|
| `slice_spawn_ms` | 1 | One C-host slice via spawnSync (process spawn + QuickJS init + snapshot read + trivial eval) |
| `run_e2e_ms.trivial.cold/warm` | 2 | submit+drive+result for a trivial run; cold = fresh state dir, warm = same Host |
| `submit_ms.cold/warm` | 2 | submit() alone (freeze + extract + validate + enqueue + notify) |
| `drive_ms.trivial.cold/warm` | 2 | runQueue+result for a trivial run |
| `suspend_ms.{1,100,500,1000,5000}kb` | 5 | startRun to first suspension, live heap = size |
| `resume_ms.{1,100,500,1000,5000}kb` | 5 | driveStep resuming a suspended run |
| `snapshot_bytes.{1,100,500,1000,5000}kb` | 5 | Size of the single snapshot file for that rep |
| `trap_step_ms.first5/last5/median` | 3 | Per-driveStep wall time over a 200-trap run (first5 vs last5 shows journal-scan growth) |
| `fork_ms.per_branch` | 1 | startForkBranches for 4 branches, per branch |
| `enqueue_ms`, `enqueue_ms.q200` | 2 | enqueue into an empty queue / a queue with 200 entries |
| `journal_event_ms.small/large10kb` | 2 | One journalEvent append (small / 10KB payload) |
| `host_construct_ms.empty/journals/journals100k` | 3 | new Host(): empty / 10 journals ~1000 events / 1 synthetic journal with 100,000 events |
| `result_ms.warm_host/fresh_cli` | 2 | result() in-process vs via a fresh `bun src/cli.ts result` (Bun startup included) |
| `extract_ms.cold/warm` | 2 | prepareRun: tsc createProgram + schema extraction (cold) / cache hit (warm) |
| `bundle_ms` | 1 | Bun.build of the driver bundle |
| `fsync_ms.500kb.plain/atomic` | 2 | Plain write+rename vs write_file_atomic (2 fsyncs) for a 500KB file |
| `blob_recipe_ms.500kb` | 1 | The storeBlob recipe: copy + sha256 of source, tmp, dest |
| `notify_ms.local_server/dead_port` | 2 | notifyEvent POST via curl spawn to a live loopback server / a dead port |

Notes on the measurements:

- **Snapshot bytes are per-snapshot, not per-directory.** The first
  version summed every `.snap` in the state dir (warmup + all reps)
  and reported 4x the true size (145,903B for a 1KB heap). Fixed: the
  metric now stats the single rep's `.snap` file. The corrected numbers
  (36,472B @1KB, 547,463B @500KB) reproduce the Nov 16 BRA-90
  measurement (35,522B / 546,502B) within 3%.
- **Warm-up reps are discarded** wherever the first rep would pay the
  cold extract (snapshot, trap steps, fork, e2e-warm, extract-warm).
  Without them the medians were polluted by one cold outlier.
- **Variance is real.** Two independent full runs showed run-to-run
  median swings up to ~2.2x on spawn/bundle/blob-recipe metrics
  (slice_spawn 20.5 -> 43.6ms) while the flush worker ran concurrently.
  That is why the latency multiple is 3x, not 2x (see below).

## Thresholds (justified, not invented)

- **Latency: threshold = baseline x 3.0.** Two full runs under
  concurrent load swung up to ~2.2x, so 2x would false-positive on
  machine load alone. 3x sits above demonstrated noise and still
  catches a genuine 3x+ regression.
- **Bytes: threshold = baseline x 1.1.** Snapshot bytes are
  deterministic for a fixed input (reproduced within 3% across runs).
  A 10% growth means the snapshot format or the live heap changed.

The multiple is stored per metric in `baselines.json`; changing a
multiple is a human decision, recorded in `ratchet.log` like a loosen.

## Ratchet rule (per metric)

- Each check run appends the metric's median to `history` (last 10 kept)
  and updates `greenStreak`: an observation <= 0.80 x threshold
  increments the streak; anything above that (but still green) resets
  it to 0; a breach resets it to 0 and fails the check.
- When `greenStreak` reaches **K = 5** consecutive observations each
  beating the threshold by >= 20%, the metric ratchets: new baseline =
  median of those 5 observations, new threshold = new baseline x
  multiple, streak resets to 0. The ratchet is appended to
  `ratchet.log` with before/after numbers.
- Never ratchet on a single good run: one observation is noise.
- **The ratchet can move a baseline UP, not only down.** A streak
  observation only has to be <= 0.80 x threshold — for a latency
  metric (threshold = baseline x 3.0) that is up to 2.4x the old
  baseline — and the new baseline is the window median, which can
  exceed the old baseline. Observed 2026-11-17 (`ratchet.log`):
  `notify_ms.local_server` 8.44 -> 11.2 ms (window [13.19, 12.46,
  7.51, 7.51, 11.2]) and `slice_spawn_ms` 19.61 -> 22.85 ms (window
  [22.85, 36.75, 18.87, 24.56, 19.02]). This contradicts the BRA-93
  "auto-tighten only / loosening is never automatic" rule as
  stated — the rule describes the intent, the code ratchets to the
  window median in either direction. **Open decision (BRA-107
  adjacent):** either clamp the ratchet to tighten-only (new
  baseline = min(window median, old baseline)) or restate the rule
  as "the ratchet tracks the loaded-machine median" and drop the
  auto-tighten-only claim. Do not reword this section to hide the
  discrepancy until the decision lands — the mechanism change is
  code, not docs.
- The **manual** loosen path is separate and unchanged:
  `./bench/check.sh loosen <metric> <newBaseline> --reason "..."`,
  which sets the baseline, recomputes the threshold from the multiple,
  clears history/streak, and logs a `MANUAL-LOOSEN` entry with the
  reason. A human decision, recorded.
- Byte metrics (deterministic) only ratchet if the snapshot actually
  shrinks — an observation equal to the baseline does not beat a 1.1x
  threshold by 20%, so the streak stays 0. That is the intended
  semantics.

## Alarm proof (2026-11-16)

- Full check, reps 3: **ALL GREEN — 43 metrics checked, exit 0.**
- Deliberate regression: `slice_spawn_ms` threshold tightened to 1ms,
  check re-run against the recorded results: **FAIL
  `slice_spawn_ms: observed 43.62 ms > threshold 1 (baseline 43.62,
  x3)`, 1 FAILURE(S), exit 1.** Baselines restored from backup and
  re-verified (threshold 130.86), check green again.
- Loosen path verified: `loosen slice_spawn_ms 43.62 --reason "test of
  loosen path"` exited 0 and wrote a `MANUAL-LOOSEN` line; the test
  entry was removed and baselines restored afterward.

Current state (2026-11-17, from `baselines.json` / `ratchet.log`):
`slice_spawn_ms` baseline 22.85 ms, threshold 68.55 — the 130.86
figure above is the 2026-11-16 value, superseded by two ratchets
since (43.62 -> 19.61, then 19.61 -> 22.85).

## Wiring into run.sh — DONE (2026-11-17)

Wired at `run.sh:263-265`:

```sh
# BRA-93: benchmark regression alarms (bench/check.sh runs the suite
# itself; --no-ratchet keeps a suite run from recording history —
# use the plain form in CI so green runs count toward the ratchet).
./bench/check.sh --reps 3 || exit 1
```

The check takes ~80s at 3 reps. It exits non-zero on any breach, so
`run.sh` fails loudly the same way it does for a test failure. Note
the gate's flakiness: it has failed on a different marginal timing
metric in roughly every other run during BRA-106 verification, while
the same metrics go green on re-run (BRA-107, post-MVP) — a red gate
is not yet evidence of a regression, and the thresholds were
ratcheted under loaded-machine runs. See the variance note above.
