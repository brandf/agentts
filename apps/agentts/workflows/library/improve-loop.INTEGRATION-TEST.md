# improve-loop — integration test

What this is: the improve-loop workflow end to end through the REAL
engine and REAL workers, no mocks. The C host suspends/resumes the
workflow across processes; the direct adapter spawns a real worker
process (`bun workflows/library/worker.ts`) per job trap; the rubric file is
read for real (`cat` via the direct adapter's exec); the write job
writes real files. This is the end-to-end test — the mock tests in
`tests/test-improve-loop.ts` are unit/integration; this run is the
proof that the loop works for real.

## Prerequisites

- The repo is staged at `~/workspace/agentts-repo/apps/agentts`
  (or the working host dir). Run from that dir.
- The C host binary is built (`packages/durablets/out/durablets`
  exists, or `DURABLETS_HOST` points at a build). `run.sh` builds it;
  the CLI falls back to `out/durablets` by default.
- No node_modules needed in the tree for this run (the CLI + host
  are run with `bun`, which resolves the repo's deps from the
  staged tree's `bun.lock` — if deps are missing, `bun install`
  once in `apps/agentts`).

## Commands

All commands run from `apps/agentts/`. Use a fresh scratch state dir
so the run is reproducible and the tree stays clean.

```sh
# 1. Submit (returns a runId IMMEDIATELY — the run proceeds async):
bun src/cli.ts run workflows/library/improve-loop.ts --adapter direct \
  --input-file tests/fixtures/improve-loop/input-converging.json \
  --state-dir /tmp/improve-loop-itest
# Expected output: `RUN run-improve-loop-<...>` (exit 0).

# 2. Drive the queue (the thing that runs submitted runs):
bun src/cli.ts queue run --state-dir /tmp/improve-loop-itest
# Expected output: `done run-improve-loop-<...>` (exit 0).
# Note: `queue run` drives the run with the adapter it was submitted
# with (recorded on the queue entry) — no --adapter flag is needed
# here, and passing a different one would be ignored.

# 3. Fetch the result by runId:
bun src/cli.ts result run-improve-loop-<...> --state-dir /tmp/improve-loop-itest
# Expected output: the ImproveLoopResult JSON (exit 0). Use the runId
# from step 1.

# --wait variant (same path, blocking fetch — for scripts):
bun src/cli.ts run workflows/library/improve-loop.ts --adapter direct \
  --input-file tests/fixtures/improve-loop/input-converging.json \
  --state-dir /tmp/improve-loop-itest2 --wait
# Expected output: the ImproveLoopResult JSON (exit 0).
```

## What to check

- **Rounds actually happened**: the result's `report.rounds` is 2
  (early stop — the converging fixture's memo is fixed in round 1
  and clean in round 2). The journal
  (`/tmp/improve-loop-itest/journals/run-improve-loop-*.jsonl`)
  shows 2 fork events, each with 2 child runs (the two parallel
  judges), and the fix trap between round 1's judges and round 2's.
- **Fixes actually applied**: the result's `report.changes` has 3
  entries (concrete numbers, worked example, clear recommendation),
  each with a `description` and a `why`. The improved file
  (`<outDir>/improved.md`, default
  `.agentts-scratch/improve-loop-converging/improved.md` relative to
  the run's cwd — the fixture sets `outDir` to
  `.agentts-scratch/improve-loop-converging`) contains the three fix
  sentences ("In 2026, 3 pilot teams ran this process end to end.",
  "worked example:", "clear recommendation:").
- **Report actually produced**: `<outDir>/change-report.json` exists
  and parses; its `changes` match the result's `report.changes`.
- **3-round cap honored**: run the stubborn fixture the same way
  (`--input-file tests/fixtures/improve-loop/input-stubborn.json`):
  `report.rounds` is 3, `report.converged` is false,
  `report.outstanding` is exactly the concise finding, and
  `report.finalMeanScore` is 0.8. The loop must NOT run a 4th round.
- **Run-ID model**: step 1 prints the runId and exits immediately
  (before the run completes); step 3 prints the output JSON for
  that runId. `result` on a pending run prints its status instead
  of failing.

## Pass / fail

- PASS: all four checks above hold for the converging fixture, and
  the stubborn fixture hits the cap exactly as described (3 rounds,
  not converged, concise outstanding, mean 0.8). Both `run` (step 1)
  and `result` (step 3) behave as described.
- FAIL: any check fails. If the workflow is wrong, fix the workflow
  (or the fixtures, if a fixture's content does not trigger the arc
  it claims — say which). If the test (this file) is wrong, fix this
  file and say so. Re-run until green; never report a pass that was
  not executed.
