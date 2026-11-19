# Production driver: fresh-Bun cost, measured (BRA-100)

Measured 2026-11-17 on this VM with the `production_path` bench group
in `apps/agentts/bench/` (`bun bench/run.ts --metrics production_path`,
baselines in `bench/baselines.json`). Every number below is a median of
5 reps; two independent runs were made and both are shown — they agree
within ~10% everywhere, so no run-to-run variance note is needed
beyond the one-off `prod_tick_beat_ms` p95 of 63ms in run 1 (median
unaffected).

**This overturns the BRA-93 audit §11 verdict.** The audit measured
`bun src/cli.ts result` = 498ms and concluded NEVER ("operator tool,
not a hot path"). That verdict was wrong for the deployed system: the
production driver — the tick agent — invokes the CLI per action
(`queue run`, `deliver-result`, `deliveries`, `queue list`,
`escalate`, `deliver-gate`), plus `tick.ts` per tick and beat. The
CLI is a hot path for the driver even though it is an operator tool
for a human. The audit's measurement was right; its "who calls this"
assumption was wrong. BRA-100 is the correction: the production path
is now benched, counted, and gated like any other hot path.

**No new correctness problem found.** Nothing here is a silent
loss/corruption issue. The per-action tax is pure overhead (process
spawn + module loading), never a wrong result.

## Measured: the production path through fresh CLI processes

One unit of work = one run submitted → driven → delivered, through
the exact commands in `plugins/muse/TICK-AGENT.md`, each a fresh
`bun` process, against a throwaway worker server on a scratch state
dir (never the production state dir or server). Warm extract cache
throughout — the first CLI submit pays the cold extract once in
warm-up, so these numbers are the per-action tax, not tsc.

| Metric | Run 1 | Run 2 | What it is |
|---|---|---|---|
| `prod_tick_ms` | 12.18 | 12.31 | `tick.ts --timeout-ms 0` (Bun startup + fetch + immediate server response; the 60s block is not waited) |
| `prod_tick_beat_ms` | 12.46 | 10.73 | `tick.ts --beat` (Bun startup + POST /tick-beat) |
| `prod_submit_ms` | 531.74 | 485.43 | `cli.ts run` (submit only, no `--wait`) |
| `prod_queue_run_ms` | 532.29 | 550.60 | `cli.ts queue run`, one queued trivial run — the per-drive-call tax |
| `prod_deliver_result_ms` | 463.07 | 456.28 | `cli.ts deliver-result` |
| `prod_queue_list_ms` | 386.81 | 416.18 | `cli.ts queue list` (light sweep after a tick timeout) |
| `prod_deliveries_ms` | 387.94 | 394.41 | `cli.ts deliveries` (check after a drive) |
| `prod_e2e_ms` | 2255.37 | 2385.06 | whole sequence, 11 fresh processes (below) |
| `prod_invocations_per_run` | 11 | 11 | fresh Bun processes per unit of work (exact) |

Baselines are the run 1 medians (the BRA-93 convention: baselines
come from one real measured run); thresholds are 3.0x for latency,
1.0x for the count (see "Decisions" below).

## The count: 11 fresh Bun processes per unit of work

Itemized from the tick-agent loop (`TICK-AGENT.md`), verified by the
bench executing the sequence and counting its own spawns:

| # | Spawn | Cost (median) |
|---|---|---|
| 1 | `cli.ts run` (submit, by the submitter) | ~500ms |
| 2 | `tick.ts` (notices `run-submitted`) | ~12ms |
| 3 | `tick.ts --beat` (before the drive) | ~12ms |
| 4 | `cli.ts queue run` (the drive) | ~540ms |
| 5 | `tick.ts --beat` (after the drive) | ~12ms |
| 6 | `tick.ts` (notices `workflow-completed`) | ~12ms |
| 7 | `tick.ts --beat` (before the deliver) | ~12ms |
| 8 | `cli.ts deliver-result` | ~460ms |
| 9 | `tick.ts --beat` (after the deliver) | ~12ms |
| 10 | `cli.ts deliveries` (check after the drive) | ~390ms |
| 11 | `cli.ts queue list` (light sweep) | ~400ms |

Six of the eleven are `cli.ts` (~400–540ms each); five are `tick.ts`
(~12ms each). The tick agent's own calls are nearly free — the tax
is concentrated in the CLI.

## The tax, decomposed

- **Bare Bun + a tiny script (`tick.ts`): ~12ms.** Measured.
  Bun startup itself is not the problem.
- **`cli.ts` import graph: ~350ms.** `bun src/cli.ts version`
  (no Host, no work — just loading the module graph) takes
  0.33–0.38s. The graph is load-bearing (the checker pulls in the
  TypeScript compiler API; the Host pulls in the adapters), so this
  is not trimmable by deleting an import — it is the cost of
  starting the CLI at all.
- **Host construction: 0.4–1.6ms** (`host_construct_ms`, existing
  metric). Negligible next to the import graph. BRA-98 (lazy
  journal load) does not move this number at bench journal sizes;
  at 100k events it is 28ms — still small next to 350ms.
- **Per-command work on top of the floor:** `result` ~428ms total
  (existing `result_ms.fresh_cli` baseline), `queue run` ~540ms
  (bundle + slice + notify), submit ~500ms. The work is tens of
  ms; the floor is hundreds.

**End to end: ~2.3s per run through the CLI vs ~63ms in-process**
(`run_e2e_ms.trivial.warm` baseline 62.79ms) — a ~36x tax, of which
~2.2s is the six `cli.ts` spawns. The tick spawns contribute ~60ms
of the 2.3s; the beats, ~48ms. My prior assumption that the beats
were a large share of the tax was wrong — measured, they are the
cheapest part.

**What the tax costs in practice:**

- Per run: ~2.3s of pure overhead, regardless of how fast the run's
  own work is. A run that completes instantly still takes ~2.3s
  from submit to delivered — that is the system's responsiveness
  floor for the tick-agent path.
- Per day: the tick spawns are ~12ms each and the tick blocks up to
  60s, so ~1440 ticks/day cost ~17s/day of CPU — negligible. The
  tax scales with run volume, not with time: at 100 runs/day it is
  ~4 min/day of spawn overhead; at 1000 runs/day, ~38 min/day.
- For runs that take minutes of model time, 2.3s is ~1–4% overhead
  — small. For fast runs it dominates (36x). The tax matters most
  for high-frequency short runs and for the responsiveness floor,
  not for the long agent steps the MVP runs today.

## The ideal, evaluated

Each option carries the devil's advocate in three columns — (1)
measured now, (2) theoretical ideal / lower bound, (3) the
architectural rethink — plus the price tag and a verdict, as in
`AUDIT.md`.

### A. CLI as a server: driver endpoints on the existing worker server

- **Measured now:** 6 `cli.ts` spawns per run, ~2.2s of the 2.3s
  total; 11 spawns per unit of work.
- **Theoretical ideal:** the tick agent curls the server instead of
  spawning Bun — per action, an HTTP round trip (~2ms; the notify
  round trip measured in `AUDIT.md` §10) plus the in-server Host
  work (construct 0.4–1.6ms, or hold one Host per server). The
  per-run overhead drops from ~2.3s to ~50ms, and the spawn count
  from 11 to 0 `bun` processes (the tick/beat HTTP calls stay HTTP —
  they already are). The e2e floor drops from ~2.3s to ~0.1s.
- **Rethink:** add driver operations as HTTP endpoints on the
  worker server that already exists and that the tick agent already
  talks to over HTTP (`/tick`, `/tick-beat`, `/event`): `queue run`,
  `deliver-result`, `queue list`, `deliveries`, `escalate`,
  `deliver-gate`. The tick agent's calls become curl POSTs — the
  same shape as its tick/beat calls today. The driver lock stays:
  the server serializes drives in-process, and the CLI `queue run`
  keeps the file lock so an operator drive concurrent with a
  server drive still refuses loudly, as today. No second server,
  no new deployment shape, no new client — the server, the tick
  agent's HTTP client, the state dir, and the WaitHub are all
  already there.
- **Price tag:** MEDIUM. New endpoints + tick-agent client
  changes + the lock interaction needs care (server-driven runs
  must hold the driver lock; the server's Host lifecycle — one
  held Host vs construct-per-request — is a small design choice).
  Time: days. Risk: the server becomes the driver, so a server
  restart mid-drive must leave the queue recoverable — but that
  is already the design (crash mid-drive self-heals on the next
  drive via REPAIR; BRA-72).
- **Verdict: RECOMMENDED.** This is the follow-on (filed as a
  Linear issue from this audit). It removes the spawns entirely
  with the least new machinery, because the persistent process
  and the HTTP client already exist.

### B. Persistent driver process, separate from the worker server

- **Measured now:** same 2.3s/run as above.
- **Theoretical ideal:** same as (A) — a long-lived Bun process
  holding a Host, driven via stdio, a Unix socket, or HTTP.
  Per-action cost drops to ~ms.
- **Rethink:** a new long-lived process with its own lifecycle,
  supervision, restart protocol, and client — alongside the worker
  server, which is already a long-lived Bun process the tick agent
  talks to over HTTP.
- **Price tag:** MEDIUM-HIGH — same benefit as (A) plus a second
  server to deploy and supervise. Strictly more machinery than
  (A) for the same outcome.
- **Verdict: NOT RECOMMENDED.** (A) dominates it: the persistent
  process already exists, it is the worker server.

### C. Compiled CLI (`bun build --compile`)

- **Measured now:** ~350ms of the ~450ms per `cli.ts` spawn is
  loading the module graph; bare Bun + tiny script is ~12ms.
- **Theoretical ideal:** a compiled binary loads its bundled
  modules from the binary instead of transpiling/loading TS
  sources per invocation — the per-spawn cost plausibly drops
  toward the tens of ms (unmeasured; Bun-compiled CLIs typically
  start in tens of ms). The 11-spawn structure stays, so e2e
  drops from ~2.3s to ~0.3s — better, but the spawns remain and
  Host construct + readQueue per invocation remain.
- **Rethink:** keep the CLI shape exactly; change the build to
  emit a binary per platform.
- **Price tag:** LOW-MEDIUM — build plumbing, a binary artifact
  per platform to publish, and a measured verification that the
  compiled CLI actually starts faster (not assumed). Risk: the
  build story changes for every CLI consumer; the binary must be
  rebuilt and redistributed on every CLI change.
- **Verdict: VIABLE, second choice.** Worth measuring if (A)
  stalls — it is the cheapest change to the deployed shape — but
  (A) removes the spawns entirely and reuses existing machinery,
  so (A) is the recommendation and (C) is the fallback.

### D. Do nothing

- **Measured now:** 2.3s/run, ~4 min/day at 100 runs/day.
- **Theoretical ideal:** 0 — the tax stays.
- **Rethink:** none. The tick spawns are ~12ms (cheap); the runs
  the MVP does today take minutes of model time, so 2.3s is
  ~1–4% overhead.
- **Verdict: DEFENSIBLE for now, not the final answer.** The tax
  grows with run volume and the 2.3s responsiveness floor is real.
  Do not treat "do nothing" as the verdict — file (A) and schedule
  it post-MVP. The bench group now guards the path in the meantime:
  any regression alarms, and the count metric alarms on any change
  to the loop's shape.

### Already the design (not options)

- **Batching:** one `queue run` already drives every queued run —
  the per-run tax above is for a lone run; a burst of submissions
  shares one drive spawn. Nothing to add.
- **Trimming `cli.ts` imports:** the ~350ms graph is load-bearing
  (checker needs tsc, Host needs the adapters). Deleting an import
  to shave the floor is whack-a-mole against the module graph, not
  a fix for per-invocation loading. Not recommended.

## Recommendation

Build **(A)**: driver endpoints on the existing worker server, with
the tick agent calling them over HTTP instead of spawning `bun
src/cli.ts` per action. Filed as the follow-on Linear issue from
this audit. (C), the compiled CLI, is the fallback if (A) stalls.
The `production_path` bench group stays as the guard: it measures
the production path as the tick agent invokes it, and the count
metric fails the gate loudly if the loop gains or loses a CLI call.

## Decisions (recorded)

- **The count metric is a new `count` kind, 1.0x threshold**
  (`bench/baselines.ts`): a count is deterministic by
  construction, so any increase is a real change to the loop, not
  noise — the threshold equals the baseline and any increase fails
  the gate for review. The ratchet can never fire on a count (a
  green observation must beat 0.80x the threshold, impossible for
  an exact count). The `MULTIPLES` entry carries this justification
  in the file, per its own convention.
- **Baselines hand-added, not via `--write-baselines`:** the 9 new
  entries were written from the run 1 medians by hand (existing 43
  entries untouched — verified by diff: 90 added lines, 0 removed
  or changed). `--write-baselines` regenerates the whole file and
  was not run.
- **No separate `test-bra100.ts` suite:** BRA-100 is a measurement
  item like BRA-93 (which likewise has no `test-bra93.ts`) — the
  `production_path` bench group is the executable spec: every step
  asserts (non-zero CLI exit, wrong run status, wrong delivery
  runId all throw), and it runs inside the gated bench check in
  `run.sh`.
- **The tick is measured with `--timeout-ms 0`, not the 60s block:**
  the WaitHub runs its check immediately and a 0ms timer fires at
  once, so the call returns immediately with queued events or a
  timeout — this measures the invocation cost, which is the tax.
  The 60s block is wait time, not cost.
- **The tick/beat finding overturns a prior assumption:** I
  expected the tick and beat spawns (~400ms each by analogy with
  `cli.ts`) to be a large share of the tax. Measured, they are
  ~12ms each — the tax is concentrated in `cli.ts`. The beats are
  the cheapest part of the loop, not a target.
