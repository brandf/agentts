# AgentTS host executable v0 (Linear BRA-44)

The Layer 2 host: runs workflows end to end through the real DurableTS
engine (C host per run-slice, blob + JSON over process spawn), with a
disk blob store, a JSONL journal (the source of truth), a persisted run
registry, a run queue, plugin/adapter loading, the first-run gate
pipeline in the run path, and the JudgeFixLoop library workflow.

## Layout

```
src/
  host.ts            Host: dispatch, fork/join, registry, queue, CLI-facing API
                     (ported from the BRA-45 mock plugin — same dispatch /
                     fork-join / repair / gate / extraction logic, same
                     journal event shapes; disk store instead of memory)
  adapter.ts         Layer 3 seam: Adapter interface (answer job/exec/gate/
                     decide; sleep/cron/clock are host-owned)
  adapters/
    mock-adapter.ts  canned answers (same table as the mock plugin) +
                     JudgeFixLoop mock judges/fix/aggregate
    direct-adapter.ts real worker processes (job), real exec, held gates,
                     local decision model (decide)
  decision-model.ts  local decision model (deterministic, narrow — parses
                     scores/thresholds/counts out of the question)
  gate.ts            first-run type-check gate (structured diagnostics)
  checker.ts         M2 checker (BRA-29): class/empty contracts, wiring
                     (schema-level), layering import lint — runs in the
                     gate after extraction, before the cache write
  extract.ts         type extraction + content-hash cache (also walks
                     transitive relative imports, so library workflows
                     extract; depHash in the cache key)
  validate.ts        AJV validation against extracted schemas
  agentts.ts         the agentts module (verbatim copy of
                     packages/durablets/src/agentts.ts — the canonical
                     source stays there; see below)
  task-backend.ts    task-backend interface + Linear + local implementations
  cli.ts             `agentts` CLI: run / deliver-gate / status / queue /
                     sync-task / version / check (M2 checker, BRA-29)
workflows/
  judge-fix-loop.ts  generic JudgeFixLoop<X, R> library (loop logic; the
                     trap-calling steps are caller-supplied — see below)
  worker.ts          the direct adapter's worker process (genuine rubric
                     scoring / fixing / aggregating over the real input)
tests/
  run-host-suite.ts  the host suite (ported core suite + host-only tests)
  swap-test-host.ts  byte-identical comparison: reference vs mock vs host
  workflows/         ported core-suite workflows + host fixtures
run.sh               build the C host -> reference suite -> mock suite ->
                     host suite -> swap test; scratch deleted on success
package.json         typescript 5.9.3 (exact pin), ts-json-schema-generator
                     2.9.0, ajv 8.20.0 (same pins as the mock plugin)
```

## Run it

```sh
./run.sh
```

`run.sh` builds the core C host into a scratch dir and points all
suites at it via `$DURABLETS_HOST`. All run outputs live in a mkdtemp
scratch dir, never in this tree; the scratch dir is deleted on success
and kept (path printed) on failure.

## The CLI

```sh
bun src/cli.ts run workflows/... --adapter direct --state-dir ./.agentts-state
bun src/cli.ts run workflows/... --adapter muse --state-dir ./.agentts-state
bun src/cli.ts deliver-gate <runId> '{"answer":"yes"}' --state-dir ./.agentts-state
bun src/cli.ts status <runId> --state-dir ./.agentts-state
bun src/cli.ts queue list --state-dir ./.agentts-state
bun src/cli.ts sync-task BRA-44 <runId> --state-dir ./.agentts-state --backend linear
bun src/cli.ts admit --state-dir ./.agentts-state --backend linear --wip 3 [--map map.json] [--workflow workflows/...] [--dry-run]
bun src/cli.ts cost-model --state-dir ./.agentts-state
bun src/cli.ts worker serve --state-dir ./.agentts-state [--port 18741] [--max-pool-size N] [--max-cpu-slots N] [--max-decisions-per-sec N] [--max-tokens-per-hour N]
bun src/cli.ts worker status [--server http://127.0.0.1:18741]
```

## Worker pool (BRA-48) + the Muse adapter

Job traps can run through a pool of workers instead of the direct
adapter's local processes: `--adapter muse` enqueues each job on the
get-job/complete-job queue (loopback HTTP, `src/worker-server.ts`)
and blocks until a worker completes it. Workers are Bun processes
running `plugins/muse/worker-loop.ts` (script mode — the proof leg)
or Muse subagents running `plugins/muse/get-job.ts` /
`complete-job.ts` in a loop per `plugins/muse/WORKER.md` (the true
leg). Each worker has its own per-worker workspace, never shared;
the scheduler prefers the warm specialist for a spec (affinity)
with an oldest-job fallback (`src/scheduler.ts` — the seam BRA-49
builds on). A crashed/timed-out worker's job re-queues (lease
expiry) and fails loudly at max attempts; cancel arrives via
`POST /cancel-job` (or `agentts worker cancel <jobId>`) and the run
resumes by throwing `JobCancelled` at the call site. File effects
return with the completion as full file contents (1MB cap) and are
never auto-applied. The adapter auto-starts the queue server when
none answers; `agentts worker serve` starts it explicitly.
`tests/run-worker-pool-suite.ts` (run via `./run.sh`) proves it:
scheduler unit, JudgeFixLoop end to end (9 jobs, each delivered
once), crash re-queue, affinity across runs, cancel queued+running,
JSON boundary, file effects, malformed body.

## Two-layer scheduling (BRA-49): admittance + dispatch

Layer 1 — admittance (`src/admittance.ts`, CLI `agentts admit`):
the Linear backlog is not the run queue. Admit in priority order
(Linear 1 urgent … 4 low, 0/absent = medium) under a WIP limit
(default 3): each admitted task maps to a library workflow — explicit
`--map` JSON `{ taskId: workflowPath }`, `--workflow` for one workflow
for all, or a `workflow:<name>` label on the task — and starts as a
run carrying the taskId. A task with no mapping is skipped as
`needs-workflow` (it needs AgentTS code written first), never admitted
to nothing. Admitting links task→runId through the task backend (a
`[agentts]` comment on Linear, a row in `task-runs.json` locally) and
enqueues the run in the host queue with the task's priority;
`agentts queue run` drives the queue. Admit never executes a run
itself. In-flight tasks (mirror links, queued runs, or — for Linear —
issues in an In Progress state) are never re-admitted; a terminal
link (done/failed/cancelled) frees the slot. `--dry-run` prints the
plan and writes nothing.

Layer 2 — dispatch (`src/scheduler.ts` `DispatchScheduler`, same
`Scheduler` interface as v0; `src/cost-model.ts`, `src/quotas.ts`):
the pool server picks, at dequeue time, by effective priority first
(base priority, improved one step per 5 min waited, capped at two
steps — the starvation guard), then affinity *inside* the tier (a
reserved/warm job never promotes out of its tier), then estimated
cost (shortest first). Quotas are enforced by the server around
selection: pool size, CPU slots, decision-model rate, tokens/hour.
A quota-blocked pick is excluded and selection re-runs, so one
blocked job never starves the queue behind it; exclusions are
journaled as `quota-blocked`, total blockage as `none-quota`.
The cost model records real actuals per call site — pool jobs by
assignedAt→completedAt (`job:<spec>`, `GET /cost-model`), in-engine
traps timed in-process into `cost-actuals.jsonl` and read back by
`agentts cost-model`. The same measurement is also journaled on each
trap-result event (BRA-57: journal format v2 stamps every event
with `wallTs` and carries `adapter`/`worker`/`wallMs` on
trap-results), so the profiler reads wall durations from the
journal; the cost log stays the scheduler's input. Unknown sites
have no estimate and sort as the tier average, never as zero. The host's in-engine decide path takes
the same decision-rate quota as an opt-in wait (`--max-decisions-per-sec`,
default unlimited; the window is 1s so the wait is at most ~1s);
token budgets live at pool dispatch from declared `tokensEst`,
because the local decision model consumes no tokens. The host run
queue (`queue.json`) also drives in priority order now, FIFO inside
a tier. `tests/test-scheduling.ts` (run via `./run.sh`) proves it:
admittance, dispatch, cost model, quotas, live server, CLI admit,
host cost actuals, queue priority order.

## Registering workers for new job specs (BRA-56 fix)

```sh
bun src/cli.ts run workflows/... --adapter direct --workers-config workers.json
bun src/cli.ts run workflows/... --adapter mock --mock-answers answers.json
```

`--workers-config` is JSON `{ spec: workerScriptPath }` (paths
resolve against the cwd) and registers each spec on the direct
adapter; the muse worker loop reads the same file format.
`--mock-answers` is JSON `{ spec: cannedValue }` for the mock
adapter. Both fail loudly on a missing file or bad JSON. This
supersedes the per-workflow plugin workaround (`plugins/briefing`
still works and is untouched).

Exit codes: 0 done, 2 held at a gate, 1 error / refusal. State
defaults to `./.agentts-state` (or `$AGENTTS_STATE_DIR`).

State layout: `slices/` (transient .snap/.out/.log), `blobs/` (disk
blob store), `journals/` (JSONL, source of truth), `runs/` (persisted
run entries), `cache/` (schema cache), `queue.json`, `task-runs.json`.

```sh
bun src/cli.ts profile <runId> [--state-dir DIR] [--format text|html] [--journal FILE] [--out FILE]
```

`profile` is read-only: it reads `stateDir/journals/<run>.journal`
plus its branch journals (`<run>_fork-<n>_branch-<m>.journal`) and
prints a timeline with counters — per-trap-type counts, fork/join/
branch counts, gate holds, clock-advances, and per-trap results
(matched by trapId). `--journal FILE` profiles one journal file and
its siblings directly (used for the fixtures). `--format html` emits
a single self-contained page (no external URLs or scripts) that
renders from a `file://` open. See `src/profiler.ts` and
`tests/test-profiler.ts` (fixtures in `tests/fixtures/profiler/`).

## Decisions (hands-dirty, recorded)

- **Profiler time model (BRA-30, updated BRA-57): the timeline axis
  is event order, not time — but wall durations are real where the
  journal carries them.** Journal format v2 (BRA-57) stamps every
  event with `wallTs` and carries `adapter`/`worker`/`wallMs` on
  trap-results, so per-trap wall durations, total run wall time,
  and gate hold durations are real numbers (a trap's wallMs is its
  result event's measured field, else the wallTs difference; a
  gate's hold is result − gate-held). Older (v1) journals carry
  none of these fields and still report them as unknown, never
  invented. Virtual time is separate and real: `clock-advance`
  events carry from/to virtual timestamps, and a sleep/cron trap's
  virtual delta is the sum of the advances between its `trap` and
  `trap-result` (the advance is journaled while the trap is
  suspended). A 2h sleep advances the virtual clock 2h with ~0ms
  of wall time and is shown on the virtual track only, never as a
  2h stall.
- **The profiler is read-only and owns no scheduling.** It reads
  journals; it never dispatches, admits, or mutates runs (BRA-49
  owns the scheduler). `profile` does not construct a Host.
- **Cost actuals do not come from the journal (BRA-49).** The
  scheduler reads `cost-actuals.jsonl`, not the journal: the log is
  the scheduler's append-only input, the journal is the profiler's
  source of truth. Since BRA-57 the journal carries the same
  per-trap wall measurement (wallMs on trap-results), but neither is
  derived from the other — the cost model records wall time where it
  is actually observable (pool jobs by assignedAt→completedAt on the
  server, in-engine traps timed in-process into `cost-actuals.jsonl`).
- **Quotas are enforced at dispatch, not at the trap (BRA-49).**
  Pool size / CPU slots / decision rate / token budget are checked by
  the server around selection, with a blocked pick excluded and
  selection re-run; the scheduler itself stays pure. The host's
  in-engine decide path only takes the decision-rate quota as an
  opt-in wait, and token budgets only apply to pool jobs that declare
  `tokensEst` — the local decision model consumes no tokens, so there
  is no token meter to enforce in-engine.
- **Trap results are folded into the trap line.** The timeline shows
  one line per trap (`[#start→#end] type trapId arg => result`),
  with the `trap-result`/`trap-error` event itself omitted, so a
  31-trap run stays scannable; counters still cover every event.
  An error is a `trap-error` event or a result with a non-empty
  `error` string or `ok:false`.
- **Briefing phase order is what the journal says, not the brief.**
  The journal order is discover → 12 reads → must-read decide →
  render → 7 relates → JFL → write → html build; the task brief's
  paraphrase had must-read after relates, which the journal
  contradicts.

## Decisions (hands-dirty, recorded) — host (BRA-44)

- **Host engine is a port of the mock engine, not a wrapper around
  it.** The mock plugin's blob store and journal are in-memory and its
  store is private — a wrapper cannot inject a blob for a cross-process
  gate resume, and the CLI must resume held gates across processes.
  The port keeps the mock's dispatch/fork-join/repair/gate/extraction
  logic and journal shapes; the swap test proves the port agrees
  byte-identically. gate/extract/validate/agentts are copied verbatim,
  not rewritten.
- **The agentts module is NOT moved.** The canonical source stays
  `packages/durablets/src/agentts.ts` (the durablets package's tests
  import it); the host carries a verbatim copy in `src/agentts.ts`,
  the same pattern the mock plugin uses. Moving it would break the
  core package for no v0 benefit.
- **Adapters load from `apps/agentts/plugins/<name>/src/adapter.ts`,
  with built-in fallback for `direct` only.** `mock` loads from
  `plugins/mock/src/adapter.ts` (BRA-53): the plugin seam returns
  the same `MockAdapter` the Host constructor uses as its default
  (one implementation in `src/adapters/mock-adapter.ts`, shared —
  the plugin file is the loadable module, not a second copy).
  The loader also loads full plugin ENGINE classes
  (`<name>-plugin.ts`, mock first) for in-process use; see
  `Host.loadPlugin`.
- **sleep/cron/clock are host-owned, not adapter calls.** The clock is
  host state (virtual in tests, real wall time in production). The
  adapter answers job/exec/gate/decide only.
- **Gate answers live on the host, not the adapter.** The direct
  adapter holds every gate, so an answer queued in the adapter could
  never be delivered; the host's per-run gate queue is consulted
  before the adapter.
- **JudgeFixLoop is generic over the loop, concrete at the traps.**
  The extractor needs a concrete, named type at every trap call site,
  and a generic function's type parameters are unresolved there (the
  pre-check rejects them loudly). So the library owns the loop logic
  (fan-out via `all`, reduce, decide cadence, convergence rule) and
  the concrete workflow supplies the trap-calling steps, where the
  types are concrete. The extractor walks transitive relative imports
  (new in the host's `extract.ts`; `depHash` in the cache key), so the
  library file's types resolve.
- **The local decision model is narrow by design.** It parses
  machine-readable signals out of the decide question (mean score vs
  threshold, misses vs threshold) and falls back to first-option at
  confidence 0.5 when there is no signal. It computes from the
  question content; it is not a general reasoner. BRA-47 owns the
  canonical Decision shape.
- **Real subagent judges are NOT in this build.** The direct adapter's
  job path spawns real worker PROCESSES (genuine computation over the
  real input — see `workflows/worker.ts`), not canned answers. True
  Muse-subagent judges need a caller that can spawn subagents (this
  build runs at depth 2 and cannot); the worker API is the seam they
  plug into (BRA-48/49 worker pool). The mock run proves the loop;
  the real run proves the worker path.
- **Task-backend mirroring is comments, not state changes.** Linear
  has no runId field; the link and status are recorded as `[agentts]`
  comments on the issue, and the local JSON mirror is the queryable
  record. v0 never changes issue state — closing issues is the
  coordinator's job.
- **TypeScript 5.9.3 exact pin kept** (same as the mock plugin). The
  host refuses to start a workflow when the compiler is unavailable
  or the wrong version (`HostRefusalError`, never a silent skip).
- **Queue is plugin-internal.** `queue.json` under the stateDir;
  Linear holds task→runId + mirrored status only, never the queue.
