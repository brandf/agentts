# AgentTS architecture

This is the technical reference for the system as it is today
(2026-11-16, after the BRA-59 function flip). Every claim traces to
code in this repo; where older write-ups disagree with the code, the
code wins — the known disagreements are listed at the end. The
top-level [README](../README.md) is the front door; this doc is the
reference. It does not repeat the component READMEs — it links to
them.

## 1. The three layers

```
Layer 1  DurableTS core (C)          packages/durablets/src/durablets.c
         trap / all / any / race, suspend into a blob, resume a blob.
         Routes traps by type string. Knows nothing about jobs,
         gates, journals, scheduling, or workers.

Layer 2  AgentTS host (TypeScript)   apps/agentts/src/
         Interprets traps, journals, drives runs, freezes workflow
         source, schedules, owns the clock. Environment-independent.

Layer 3  Environment adapter         apps/agentts/plugins/<name>/
         Answers job / exec / gate / decide. The ONLY layer that     one folder per environment (mock, direct,
         knows about an environment (mock answers, local processes,  muse, briefing): the adapter implementation
         the Muse worker pool). Swapping it touches no workflow,     (<name>-adapter.ts) next to the loadable
         no host logic, and no core code.                            seam (src/adapter.ts). See plugins/README.md.
```

Dependency rule: each layer talks only to its neighbors through a
small interface; nothing skips a layer. Layer 1 never talks to layer
3; layer 3 never reaches into layer 1. The swap test
(`apps/agentts/tests/swap-test-host.ts`) proves the boundary: the
same workflows run byte-identically under the reference plugin, the
mock plugin, and the host.

Sources: `packages/durablets/README.md` ("The three layers"),
`packages/durablets/src/durablets.h`, `apps/agentts/src/adapter.ts`,
`apps/agentts/src/host.ts`.

## 2. Layer 1 — the DurableTS core

The core is a C library plus a thin host CLI, built against a
patched minimal dquickts tree (`packages/durablets/vendor/dquickts`,
vendored by `packages/durablets/re-vendor.sh` — see `BUILDING.md` at
the repo root; upstream stencil-hq/dquickts pinned at commit `96a9a79`,
2026-11-11, plus the BRA-42 `JS_AbandonSuspended` patch — see
`packages/durablets/dquickts-bra42.patch` and the tree's
`VENDORED_FROM` stamp). The engine tree is never modified by this
repo. Build it with `make -C packages/durablets durablets`
(binary to `packages/durablets/out/`, or `OUT_DIR=...`).

What the core does:

- **`trap(type, arg)`** — the single dispatch point. It suspends
  the run, hands the trap to the host plugin, and resumes with the
  plugin's result. Trap types are routed by string only; the core
  does not interpret them.
- **`all` / `any` / `race`** — fork/join builtins with
  `Promise`-like semantics: `all` collect-all by default,
  fail-fast with a `true` flag (bare values on success, first
  branch error thrown at the call site); `any` first success wins,
  all-fail throws a real `AggregateError`; `race` first settler
  wins, losers cancelled; empty-list behavior matches `Promise`
  (`all([])` returns `[]`, `any([])` throws, `race([])` never
  settles).
- **Suspend / resume** — a run suspends into a snapshot blob and
  resumes from a blob with a value or a throw. The blob path is
  always chosen by the plugin and passed on the command line; the
  core never chooses, lists, or stores blob paths. Its only
  filesystem writes are that blob and the `<blob>.result.json`
  file it writes when a top-level run completes.
- **Trap identity** — a trap's id is `runId + "/trap-N"`
  (`runId` + ordinal as one id).
- **Entry guard** — the host-generated driver calls
  `__agentts_begin()`, then the workflow's entry function. A trap
  or combinator call not under the entry function on the stack
  throws immediately.
- **Cancellation** — cancel a pending trap, a whole combinator, or
  the run (sticky: further trap/combinator calls throw at once);
  nested propagation down the tree, deepest-first. Delivered by
  resuming the suspended wait throwing a real `CancellationError`.
  Cancel-vs-complete is decided by journal order.
- **Error rehydration** — every resume-with-throw path rehydrates
  `{name, message}` records into real `Error`s, trap results
  included; a thrown non-Error crosses as-is.
- **Trap arg-in JSON check** — `trap()` validates its arg before
  suspending: only clean JSON (plus `Date`, which crosses as its
  ISO string) may cross. A dirty arg throws a `JsonBoundaryError`
  synchronously at the call site and never dispatches, consumes no
  ordinal, and writes no blob.

What the core does **not** do: it does not journal (it emits one
JSON object per line on stderr, prefixed `[durablets] `, for the
plugin to record), does not know what a step, job, gate, judge, or
workflow is, does not schedule, and does not interpret trap types.
It is invoked per run-slice — there is no long-lived C-host daemon;
the blob + JSON over process spawn is the v0 shape, and a daemon
over IPC is a later optimization, not built.

CLI modes and exit codes (`packages/durablets/src/durablets.c`):
`run`, `resume`, `cancel`, `branch`, `join`, `join-value`,
`join-throw`, `join-aggregate`. Exit 0 done, 1 error, 2 suspended
at a trap, 3 suspended at a combinator. Workflow output goes to
stdout; diagnostics and `[durablets]` events go to stderr.

## 3. Layer 2 — the AgentTS host

The host (`apps/agentts/src/host.ts`, CLI `apps/agentts/src/cli.ts`)
is the environment-independent plugin. It owns trap
interpretation, the journal, the run registry, the queue, workflow
freezing, the clock, and the drive loop.

### 3.1 The run path: submit → queue → drive → result

There is exactly one way to start a run. There is no in-process
drive mode.

1. **Submit** (`Host.submit`, CLI `agentts run`). The host freezes
   the workflow closure (Section 3.2), runs the first-run gate
   (type-check with TypeScript 5.9.3, M2 checker — see Section 8),
   extracts trap-call-site schemas, validates the input JSON
   against the entry's input schema (JSON-clean first, then
   schema — the same order as the trap boundary), enqueues the
   run, and returns the run ID immediately. A run submitted with
   `--task` carries the task ID. Submit also wakes the tick agent
   with a `run-submitted` system event.
2. **Drive** (`Host.runQueue`, CLI `agentts queue run`, or
   `run --wait`, which is submit → `queue run` → `result` on the
   same path). The queue is driven under a driver lock (one driver
   per state dir; Section 3.4), in priority order, FIFO inside a
   tier. Each entry is driven with **the adapter it was submitted
   with**, not the host's default. Driving is a synchronous loop
   (`driveToCompletion`): spawn the C host per slice, ingest its
   `[durablets]` events into the journal, dispatch each trap, and
   resume — until the run completes, holds at a gate, fails, or
   hits the drive cap (Section 3.4).
3. **Result** (`Host.result`, CLI `agentts result <runId>`). The
   output is read from the result file and validated against the
   extracted output schema before it is returned — a result that
   does not match the entry's declared output is a failure, not a
   result. Statuses: `pending | running | held | done | failed`.
   Exit codes: 0 done, 2 held at a gate, 1 error / refusal.

The host generates a driver per run (`Host.driverFor`): global
code that arms the entry guard and calls the exported entry
function with the validated input JSON. It bundles driver +
workflow + agentts module into one self-contained script with
`Bun.build` (with an external source map, pinned with the run —
Section 7), and refuses loudly if the bundle still contains
`export`/`import` syntax after the build, since the C host evals a
global script and module frames cannot suspend.

### 3.2 Frozen workflow copies + engine version (BRA-71)

At submit, the host freezes the workflow's closure — the entry
file plus its transitive relative imports plus the agentts module
it imports — into `stateDir/frozen/<closureHash>/`, preserving
relative layout. The hash covers (relative path, content) of every
file, so the store is content-addressed and identical source reuses
a directory. The copy is built in a temp dir and renamed into
place, so a crash mid-freeze never leaves a partial copy. A resumed
run executes and validates against the frozen copy, never the live
file: editing (or deleting) the workflow mid-run cannot change what
the run executes. If a recorded frozen copy is missing on disk, the
host refuses loudly rather than falling back to the live file.

Each run also records an engine version,
`dquickts-<pin12>+durablets-<hash16>` — the dquickts pin from the
vendored tree's `VENDORED_FROM` stamp plus a content hash of
`durablets.c` (source-derived, never binary-derived, since the
binary is rebuilt fresh on every `run.sh`). A resume under a
different engine build is refused loudly (`engine-version-mismatch`
journal event; the run is marked failed, the blob stays on disk so
restoring the matching engine and re-queueing can still resume it).
Runs recorded before BRA-71 carry no version and proceed
unchecked. Proven by `apps/agentts/tests/test-bra71.ts`.

### 3.3 The clock

`sleep` / `cron` / clock are host-owned, not adapter calls. The
clock is virtual in tests (default `--clock virtual`; the virtual
epoch observed in real runs is 2027-01-01) and real wall time in
production. A sleep advances the virtual clock with ~0ms of wall
time; the advance is journaled as a `clock-advance` event while
the trap is suspended. `cron` is a one-shot wait until a single
ISO datetime — the name does not imply recurrence.

### 3.4 Drive integrity: cap, lock, repair (BRA-72, BRA-76)

- **Drive cap** (`MAX_DRIVE_ROUNDS = 50`): an infinite-loop guard
  on suspensions in one uninterrupted `driveToCompletion` loop.
  Hitting it fails the run loudly (`DriveCapError` plus a
  `drive-cap` journal event) with the blob intact from the last
  suspension. A failed queue entry is never retried; the remedy is
  to split the workflow into fewer traps per drive.
- **Driver lock**: one driver per state dir
  (`<stateDir>/driver.lock/`, `holder.json` + a heartbeat file
  refreshed every 10s). A second driver refuses loudly. An
  ambiguous lock (live pid, heartbeat older than 30 min) is left
  alone; only a human, with `--force`, breaks a lock
  (`queue repair --force` — never the tick agent, never
  automation).
- **Queue repair** (`Host.repairQueue`, CLI `agentts queue repair`;
  `queue run` repairs before driving, under the lock): stranded
  `"running"` entries are classified from the journal + registry —
  a run whose journal shows lifecycle `completed` is marked done
  (the driver crashed before the queue write); a C-host crash
  mid-slice with an intact blob is re-queued to resume from the
  blob; a run with trap activity but no registry entry is left
  for a human (re-driving would restart from scratch and could
  double-execute a dispatched trap). Repairs are printed, never
  silent. Proven by `apps/agentts/tests/test-bra72.ts`.

### 3.5 Crash recovery (BRA-74, BRA-75)

- **Resume from the last blob (G1):** a C-host crash mid-slice
  (exit 1, no lifecycle event) is distinguished from a genuine
  workflow failure (lifecycle `failed` in the journal). The run
  resumes from its last intact snapshot blob — stored blobs are
  sha256-verified on store and on restore — and the journal
  carries `host-crash` + `host-crash-resumed`. A crash on the
  first slice (no blob yet) retries the run from scratch, bounded
  at 3 attempts, since no trap was dispatched and the re-run is
  idempotent. A genuine failure or a completion is never retried.
- **Journal check before re-dispatch (G3, the largest gap the
  BRA-62 audit found):** after a crash, the host checks the
  journal before dispatching a trap. A trap that already
  dispatched is re-answered from its recorded result, never
  re-executed — exactly one job per trapId for pool jobs (the
  pool dedupes on trapId at enqueue). The one honest exception:
  a crash *during* an `exec` dispatch re-runs the command — its
  output was lost, there is nothing to re-deliver — but the
  journal shows two `trap-dispatch` events (the second marked
  `redispatched: true`), so the duplicate is visible, not silent.
- **Durable sleep deadline (G11):** the sleep deadline is recorded
  durably at dispatch (`sleep-deadline` event); a host killed
  mid-sleep resumes from the recorded deadline and waits only the
  remainder. Re-dispatches reuse the same deadline, never
  re-record it.
- **Adapter timeout (G14):** the muse adapter derives its job
  timeout from the server's `/health` (lease × max attempts),
  instead of a fixed default — a never-settling job fails with
  `JobTimeout` in ~lease × attempts, not after a fixed 600s.
- Proven by `apps/agentts/tests/test-bra74.ts` and
  `apps/agentts/tests/test-bra75.ts`. What is *not* proven: a
  crash in the sub-millisecond window between a gate answer being
  consumed and the `trap-dispatched` write loses that answer —
  recoverable by re-delivering it, not silently lost forever, but
  not exercised.

### 3.6 Atomic writes + corrupt-state resilience (BRA-76, BRA-77)

One mechanism, shared by the host and the worker server
(`apps/agentts/src/corruption.ts`): `atomicWriteFile` — tmp file
in the same directory (pid-suffixed, so two writers cannot clobber
each other's tmp) + rename. A crash mid-write leaves the target
either old or new, never torn; a stray tmp file is never read.
Applied to `queue.json` (with a `queue.json.bak` backup the host
recovers from, recording `queue-recovered`), the worker store,
snapshots, blobs, and delivery records. A corrupt `queue.json`
is recovered from backup, never silently treated as empty; a
corrupt worker store the same way.

Journal loads are tolerant: a line that fails to parse, or parses
to a value that is not a journal event (not a plain object with a
string `event` field), is quarantined — skipped from the returned
list, recorded in the append-only `stateDir/corruption.log`
(deduped by kind+file+line+excerpt), and left in the file for
forensics. The host starts with the good lines intact; one bad
line used to brick the whole host. Proven by
`apps/agentts/tests/test-bra76.ts` (atomic snapshot writes,
corrupt worker-store recovery, drive cap) and
`apps/agentts/tests/test-bra77.ts`.

### 3.7 Cost model, profiler, delivery outbox, watchdog

- **Cost model** (`src/cost-model.ts`, CLI `agentts cost-model`):
  real wall-time actuals per call site, recorded in
  `cost-actuals.jsonl` — pool jobs by assignedAt→completedAt,
  in-engine traps timed in-process. Estimates are mean /
  variance / p90 / n per site. The scheduler reads this log, not
  the journal; since BRA-57 the journal carries the same per-trap
  wall measurement (`wallMs` on trap-results), but neither is
  derived from the other.
- **Profiler** (`src/profiler.ts`, CLI `agentts profile <runId>`):
  read-only. It reads a run's journal plus its branch journals and
  prints a timeline with counters (per-trap-type counts,
  fork/join/branch counts, gate holds, clock-advances, per-trap
  results matched by trapId). It never constructs a Host and never
  dispatches, admits, or mutates runs. `--format html` emits a
  single self-contained page with no external URLs or scripts.
  The timeline axis is event order, not time; wall durations are
  real where the journal carries them (Section 7).
- **Delivery outbox** (`stateDir/deliveries/`, BRA-65): the tick
  agent records a delivery record when a run reaches a terminal
  state (`agentts deliver-result <runId>`; `agentts deliveries`
  lists them). A done run delivers its output; a failed run
  delivers its error with `needsAttention: true` — that *is* the
  escalation for a terminal failure. A non-terminal run is a loud
  error. Re-delivery is idempotent (same runId, same output).
- **Watchdog** (`src/watchdog.ts`, CLI `agentts watchdog`):
  tick-agent liveness + pending work. Exit 0 healthy / nothing
  pending, 2 tick agent dead AND pending work (restart it),
  1 error. The check itself never drives the queue or flips state.
  `agentts escalate '<json>'` writes an escalation record
  (`gate-held` | `stuck-running` | `other`) for a human.

## 4. Layer 3 — environment adapters

The adapter interface (`apps/agentts/src/adapter.ts`) is small on
purpose:

```ts
interface Adapter {
  readonly name: string;  // journaled on first use
  answer(type: string, arg: any, ctx: TrapContext): TrapAnswer | typeof HOLD;
}
type TrapAnswer = { value: unknown; worker?: string; tokens?: number }
                | { throw: unknown; worker?: string; tokens?: number };
```

The adapter answers four trap types: `job`, `exec`, `gate`,
`decide`. `sleep` / `cron` / clock are host-owned (Section 3.3).
A gate answer of `HOLD` means "held open until a human answers" —
the host suspends the run and waits for `deliverGate`; the adapter
never blocks on a human. `worker` names the worker that produced
the answer when the adapter can name one; `tokens` is carried when
known (no adapter reports tokens today). In v0 `answer` is
synchronous — the host drives in a synchronous loop and the C host
is spawned per slice with `spawnSync`; a worker that needs real
time uses a blocking spawn (direct adapter) or a blocking
long-poll (muse adapter, Section 5).

Adapters load from `apps/agentts/plugins/<name>/src/adapter.ts`
(a module exporting `createAdapter()` or a default adapter), with
the implementation in the same plugin's `src/` next to the seam
(`plugins/<name>/src/<name>-adapter.ts`) — one folder per
environment, no built-in fallback for any name (BRA-68 removed
the last short-circuit, "direct"). An unknown name is a loud
error, never a silent default. The full Layer 3 layout, the
adapters-vs-plugins explanation, and the mock adapter appearing
twice (implementation vs seam) are in
`apps/agentts/plugins/README.md`.

| Adapter | What it does |
| --- | --- |
| `mock` (`plugins/mock/src/mock-adapter.ts`, seam `plugins/mock/src/adapter.ts`) | Canned answers: job specs `score`/`verify`/`aggregate` by table, `exec echo hi`, `cat <file>` reads the file for real, gate auto-yes (or held with `--gates hold`), decide via the local decision model. The default outside the production state dir. |
| `direct` (`plugins/direct/src/direct-adapter.ts`, seam `plugins/direct/src/adapter.ts`) | Real execution: one worker process per job trap (`bun workflows/worker.ts '<json>'`, genuine computation over the real input, result JSON from the last stdout line); real `exec`; held gates; local decision model for `decide`. The default on the production state dir. |
| `muse` (`plugins/muse/src/muse-adapter.ts`, seam `plugins/muse/src/adapter.ts`) | Enqueues each job on the get-job/complete-job pool queue (Section 5) and blocks until a worker completes it. Auto-starts the queue server in the state dir when none answers. |
| `briefing` (`plugins/briefing/`) | A worked plugin example; untouched by the BRA-56 fix below. |

Workers for new job specs are registered without a per-workflow
plugin: `--workers-config workers.json` (`{ spec: scriptPath }`,
direct adapter) and `--mock-answers answers.json`
(`{ spec: cannedValue }`, mock adapter). Both fail loudly on a
missing file or bad JSON. The muse worker loop reads the same
workers-config format.

## 5. The worker model

### 5.1 The pool: get-job / complete-job

The pool is a loopback HTTP server (`src/worker-server.ts`,
default port 18741, `agentts worker serve`; state under
`<stateDir>/worker-jobs/`). Workers are persistent: they run a
get-job loop and ask for the next job when the last one completes.
The protocol (`src/worker-protocol.ts`) is one file shared by the
server, the muse adapter, the worker loop script, and the CLI, so
the wire shape cannot drift:

- `GET /health` — liveness + server config (lease, max attempts,
  affinity windows).
- `POST /enqueue { spec, input, runId, trapId, priority?, cpuHeavy?, isDecision?, tokensEst?, ... }` — a job is a spec
  name + JSON input. The server resolves the jobspec prose file
  when it can and records its path + sha256 (`specPath`,
  `specHash`); a job with no spec file proceeds from spec name +
  input. The server is the sole writer of the store.
- `GET /get-job?workerId=W&lastSpec=S&waitMs=N` — **blocking
  long-poll** (BRA-66): blocks until a job is assignable to this
  worker or the wait expires (default 60s, max 120s; `waitMs=0`
  is the old immediate return). Workers neither spin when idle
  nor suffer polling latency.
- `POST /complete-job { jobId, workerId, result | error, files? }`
  — file effects return as full file contents (1 MB cap) and are
  never auto-applied.
- `POST /cancel-job { jobId, reason }` — the run resumes by
  throwing `JobCancelled` at the call site. Also `agentts worker
  cancel <jobId>`.
- `GET /tick?timeoutMs=N` — the tick agent's blocking long-poll
  (Section 5.3). At most one tick call may be pending; a second
  concurrent call is a 409.
- `POST /tick-beat`, `POST /event`, `GET /jobs`, `GET /jobspec`,
  `GET /cost-model`.

Two worker legs run the same loop:

- **Script mode** (`plugins/muse/worker-loop.ts`): a Bun process
  that long-polls `get-job`, runs the job, posts `complete-job`,
  and repeats forever (`for (;;)`). The proof leg.
- **Subagent mode** (`plugins/muse/WORKER.md`): a Muse subagent
  running the same loop by hand with `plugins/muse/get-job.ts` /
  `complete-job.ts`. The true leg. Each worker keeps the same
  worker id across sessions so its affinity stays warm, has its
  own per-worker workspace (never shared), and must not go looking
  for other work, message anyone, or change the plan.

### 5.2 Leases, stuck workers, affinity (BRA-61, BRA-48)

- **Lease:** a running job holds a lease (default 300s, max 3
  attempts). A crashed or timed-out worker's job re-queues on
  lease expiry and fails loudly at max attempts.
- **Cost-derived lease (BRA-61):** the lease is the cost-model
  p90 for the spec × 2, clamped to [60s, 30 min]. A healthy-but-
  slow job gets headroom above the 90th percentile; a fast spec
  cannot get a lease so short that any hiccup expires it; a
  pathological estimate cannot hold a slot forever (a healthy long
  job extends its lease by heartbeating).
- **Nudge:** a running job is nudged once per attempt when its age
  passes half its lease with no completion — a warning shot
  before expiry, and a status check for a long-running job.
- **Affinity:** the scheduler prefers the warm specialist for a
  spec (the worker that most recently completed it), with an
  oldest-job fallback. A job stays reserved for its affinity
  worker for a bounded hold window (default 2s) — an offline
  specialist delays the fallback by at most that window, never
  blocks it — and affinity goes cold after a TTL (default 30 min).
  Affinity never promotes a job out of its priority tier
  (Section 6).
- **Idempotency:** pool enqueue dedupes on trapId (Section 3.5);
  per-jobspec idempotency policy governs re-dispatch after a
  crash during dispatch.
- Stuck-worker behavior is proven by
  `apps/agentts/tests/test-bra61.ts`; the fault-injection suite
  (`apps/agentts/tests/test-bra67.ts`) covers cron across restart,
  a `complete-job` that never lands, VM-replacement cold start,
  and a missing engine binary.

### 5.3 The tick agent (BRA-65)

The system has its own operator session, the tick agent
(`apps/agentts/plugins/muse/TICK-AGENT.md`): not a worker
(workers execute jobs; it does not) and not the coordinator (it
does not admit work or write workflows). Its job is to keep the
machine churning — watch for system events, drive the queue,
deliver completed outputs, handle stuck runs, escalate to the
coordinator when judgment is needed, then tick again.

Its main call is the blocking `GET /tick` long-poll
(`plugins/muse/tick.ts`, default 60s, max 120s), which holds until
a system event arrives (e.g. `run-submitted`, posted by the host
on submit) or the timeout fires. It heartbeats liveness with
`POST /tick-beat` (also refreshed by every tick call) before and
after long actions and every ~20s while one runs; the watchdog
(Section 3.7) reads `<stateDir>/tick/state.json` and presumes
the agent dead mid-drive otherwise. It drives with
`agentts queue run --state-dir <DIR>` and records deliveries in
the outbox (Section 3.7). The production tick agent runs against
`~/workspace/agentts-state/`; the watchdog's default stale
threshold is 15 minutes (`DEFAULT_WATCHDOG_STALE_MINUTES`).

### 5.4 Named roles and anonymous workers (BRA-50)

Three roles, one named agent:

- **Coordinator — Meroki (named).** The one named agent in the
  system. Admits backlog tasks into runs (`agentts admit`,
  Section 6.1), writes workflows, reads delivered results from
  the outbox, spawns the tick agent and the workers, answers
  held gates, and closes issues. Named in `TICK-AGENT.md` and
  `WORKER.md`, and in the host's own comments (`host.ts`: "the
  coordinator (Meroki) reads the outbox"). There is exactly one
  coordinator.
- **Tick agent (a role, not a name).** The system's own operator
  session (Section 5.3): exactly one session, one driver. It
  carries no personal name — it is identified by its role and its
  instructions file, and the watchdog restarts it from those
  instructions. It does not admit work or write workflows; it
  escalates to the coordinator when judgment is needed.
- **Workers — anonymous pool members by default.** A worker is a
  Bun process or a Muse subagent running the get-job loop
  (`WORKER.md`). The pool has no named workers: no registry of
  worker names, no way to address a job to a particular worker,
  and no worker identity beyond an operational `workerId`.

**`workerId` — what it is and what it is not.** It is a
self-asserted handle, not an assigned identity. Script workers
default to `bun-worker-<pid>` (`worker-loop.ts`); subagent
workers use whatever id the coordinator gives them, kept stable
across sessions so affinity stays warm. The server
auto-registers any id on first sight (`touchWorker` in
`worker-server.ts`) — there is no enrollment, no
authentication, no name. It is used for exactly three
operational purposes: (1) **lease ownership** — a running job
records which `workerId` holds it, and only that worker's
completion/heartbeat is accepted (a late completion is a 409);
(2) **affinity** — per-worker completion history
(`WorkerInfo.lastSpec`, `completedBySpec` in
`worker-protocol.ts`) lets the scheduler prefer the warm
specialist for a spec; (3) **debugging** — `jobs.log` and
`scheduler.log` record which `workerId` ran, completed, or
dropped each job. It is **not** a routable identity: there is no
enqueue field naming a worker, no `targetWorker`, no lookup of a
worker by name, and the scheduler is pull-model — a worker asks
for work and the scheduler picks the best queued job *for that
worker* (`scheduler.ts`). A job can be held briefly *for* its
affinity worker (a bounded 2s hold), but that is a preference
for a warm session, not an address.

**Affinity is a session-context cache, not identity routing.**
Affinity exists because a worker's live session context (repo
layout, pitfalls, reviewer prefs) *is* its cache; giving the
same worker the same spec again pays off. It decays: affinity
goes cold after a TTL (default 30 min), and a context reset
makes the worker cold again — expected, by design. What
survives a worker is not the worker's memory but the spec's:
workers post durable learnings per spec via `POST /note`
(`notes/<spec>.md`), read by the next worker on that spec —
possibly a cold one. Institutional memory is keyed by spec, not
by worker.

**Explicitly undecided (BRA-50 — decisions for Brandon, not
built):** whether named workers should exist for routing (send
this job to a specific worker); and if so, whether a named
worker accumulates memory across jobs — and if so, where that
memory lives and who owns it. Until those are decided, do not
add a worker registry, a target-worker enqueue field, or
per-worker memory. The pull model, affinity, and per-spec notes
are the whole identity story.

## 6. Two-layer scheduling (BRA-49)

Scheduling is split in two on purpose: the backlog is not the run
queue.

### 6.1 Layer 1 — admittance: which backlog tasks run

(`src/admittance.ts`, CLI `agentts admit`; pure logic, no I/O —
the CLI supplies the backlog, the in-flight links, and the
workflow map, and performs the side effects.)

Admit in priority order (Linear scale: 1 urgent … 4 low,
0/absent = medium) under a WIP limit (default 3). Each admitted
task maps to a library workflow — explicit `--map` JSON
`{ taskId: workflowPath }`, `--workflow` for one workflow for
all, or a `workflow:<name>` label on the task — and starts as a
run carrying the task ID. A task with no mapping is skipped as
`needs-workflow` (it needs AgentTS code written first), never
admitted to nothing. Admitting links task→runId through the task
backend (a `[agentts]` comment on Linear, a row in
`task-runs.json` locally) and enqueues the run with the task's
priority. `admit` never executes a run itself. In-flight tasks
(mirror links, queued runs, or — for Linear — issues in an
In-Progress state) are never re-admitted; a terminal link
(done/failed/cancelled) frees the slot. `--dry-run` prints the
plan and writes nothing. Waiting ages a task's effective priority
one step per 7 days, capped at two steps. The host run queue
drives admitted runs in priority order, FIFO inside a tier.
Task-backend mirroring is comments, not state changes: v0 never
changes issue state — closing issues is the coordinator's job.

### 6.2 Layer 2 — dispatch: which queued job a worker gets

(`src/scheduler.ts` `DispatchScheduler`, `src/quotas.ts`,
enforced by the pool server around selection; the scheduler
itself stays pure — no I/O, no mutation, decisions returned as
data so the server can journal them.)

At dequeue time, for the worker asking: **effective priority
first** (base priority, improved one step per 5 min waited,
capped at two steps — the starvation guard), **then affinity
inside the tier** (a reserved/warm job never promotes out of its
tier), **then estimated cost** (shortest first; unknown costs
sort as the tier average, never as zero). Quotas are enforced by
the server around selection — pool size, CPU slots,
decision-model rate, tokens/hour. A quota-blocked pick is
excluded and selection re-runs, so one blocked job never starves
the queue behind it; exclusions are journaled as
`quota-blocked`, total blockage as `none-quota`. Token budgets
apply at pool dispatch from declared `tokensEst`, because the
local decision model consumes no tokens. The host's in-engine
decide path takes the same decision-rate quota only as an opt-in
wait (`--max-decisions-per-sec`, default unlimited; the window
is 1s, so the wait is at most ~1s). Proven by
`apps/agentts/tests/test-scheduling.ts`.

## 7. The journal

The journal is the source of truth. One JSONL file per run,
`stateDir/journals/<run>.journal` (branch runs get
`<run>_fork-<n>_branch-<m>.journal`), append-only, one
`appendFileSync` per event. The host writes it; the core never
writes a journal file itself. Every event is JSON-clean
(`toJsonValue` throws on a bad event — a bad journal write is a
loud failure, not a silent skip).

**Format v2 (BRA-57):** every event carries `wallTs` (ISO wall
time, stamped by the host when the event has none). Trap results
carry `adapter` (which adapter answered), `worker` (when the
adapter named one), and `wallMs` (host-measured dispatch wall
time). Older v1 journals carry none of these fields and the
profiler reports wall durations from them as unknown, never
invented.

**Events** (from the core's stderr lines, ingested and journaled
by the host): `lifecycle` (`started | suspended | resumed |
completed | failed`), `trap` (with `trapId`, ordinal, type, arg),
`fork` / `join`, `branch-start` / `branch-done`, `cancel`,
`trap-result` / `trap-error`. Host-side events: `trap-dispatch`
and `trap-dispatched` (the dispatch split, BRA-75 — see below),
`clock-advance`, `queue-started`, `host-crash` /
`host-crash-resumed`, `drive-cap`, `engine-version-mismatch`,
`sleep-deadline`, `quota-blocked`, `gate-held` and friends. The
run registry follows lifecycle events only.

**Trap-dispatch split (BRA-75):** dispatching a trap writes a
`trap-dispatch` event first, then a `trap-dispatched` event when
the answer is recorded. That split is what makes crash recovery
exact: on re-drive the host can tell a trap that dispatched from
one that never did, and re-deliver the recorded answer instead of
dispatching again (Section 3.5). It also splits queue-wait from
execution time in the profiler
(`dispatch.wallTs − trap.wallTs` vs `result.wallTs −
dispatch.wallTs`).

**Trap sites (BRA-73):** the agentts wrappers attach the call
site (`{ file, line, column }`, bundle coordinates) to the trap
arg under a reserved key. The host strips the key before dispatch
— no adapter, repair handler, or schema lookup ever sees it —
and journals the site as the trap event's top-level `site`, so
the journaled arg stays exactly the spec the author passed. A
malformed site value is dropped with no site, never trusted. The
bundle + source map pinned with the run (Section 3.1) translate
bundle coordinates back to workflow source. A trap with no site
(a direct `trap()` caller) simply carries none.

**Run-start fields (BRA-73):** the host enriches the
`lifecycle`-`started` event with `workflowHash` (the extraction
source hash, reused — never a second hash of the source),
`workflowPath` (the submitted live path), `submittedAt` (the
queue entry's `enqueuedAt` — submit→start wait is
`started.wallTs − submittedAt`), and the pinned `bundlePath` /
`bundleMapPath`. Fields with no source are omitted, never
invented; enrichment is best-effort and can never fail the
journal write.

**Branch journals:** `all`/`any`/`race` forks write branch
journals alongside the parent's; the profiler reads the whole
tree. The parent snapshot is untouched by children (sha256
checked before forking vs before the join; children work on
copies), and a branch write to fork-time shared state is
discarded.

## 8. The workflow shape (post-BRA-59 function flip)

A workflow is a **function with a trap-like signature: one
JSON-capable input in, one JSON-capable output out.** The default
export IS the workflow:

```ts
export default function improveLoop(input: ImproveLoopInput): ImproveLoopResult {
  // ...
}
```

The host generates a driver (global code) that calls it with the
input JSON; the C host captures the completion value as the run
result. The entry function must stay a plain sync function called
from global code — module frames cannot suspend. The old
global-script shape is gone; do not document or write it.

The run-side module is `agentts`
(`packages/durablets/src/agentts.ts` is canonical;
`apps/agentts/src/agentts.ts` is a verbatim copy — workflows
import it as `../src/agentts`). It wraps the core's `trap(type,
arg)` builtin and is portable: it knows nothing about Muse, any
host, or how a trap is executed.

| Wrapper | Arg | Result |
| --- | --- | --- |
| `job<Input, Output>({ spec, input })` | spec name + typed input | `Output` (call-site type) |
| `exec({ cmd, args?, cwd? })` | shell command | `{ stdout, exitCode, stderr? }` |
| `gate({ question, options? })` | human question | `{ answer }` |
| `sleep({ ms })` | duration from now | `{ sleptMs }` |
| `cron({ at })` | one-shot ISO datetime | `{ scheduled }` |
| `decide<Output>({ question, options? })` | decision question | `Output` (call-site type) |
| `all(thunks, failFast?)` / `any(thunks)` / `race(thunks)` | core combinators, re-exported | see Section 2 |

**Types are the only source of truth.** There are no schemas in
author code. On first run (or when the workflow source hash
changes) the host runs a type extractor over the workflow source
and produces JSON Schema per trap call, cached keyed by the
workflow content hash (plus compiler + checker version) and
pinned with the frozen copy. `job` and `decide` call sites must
supply both type arguments as concrete, named types — the output
type cannot be inferred, so omitting it leaves `Output =
unknown` and the host has no output contract to extract. A call
with no type arguments, or with an unresolved generic type
parameter, fails loudly at first run rather than silently
skipping validation. `exec` / `gate` / `sleep` / `cron` carry no
type arguments: their result type is fixed by the trap type.

**The trap-boundary JSON rule.** Everything crossing a trap
boundary must be clean JSON. Every wrapper runs its arg through
`toJsonValue()` before calling `trap()` — check first, then the
host's schema validation. It throws synchronously at the call
site with a precise path (e.g. `$.input.deadline`), a
machine-readable kind (`undefined`, `function`, `symbol`,
`bigint`, `non-finite-number`, `invalid-date`, `map`, `set`,
`typed-array`, `array-buffer`, `class-instance`, `circular`,
`non-string-key`, `array-hole`, `array-extra-key`, `max-depth`,
`unreadable`), and a fix — and the trap never dispatches. `Date`
is the one sanctioned conversion, to its ISO string. Plain
`JSON.stringify` is not the mechanism: it silently drops
functions/undefined/symbols, turns `Map`/`Set` into `{}`, and
`NaN`/`Infinity` into `null`. The plugin enforces the same rule
on result-out and on every journal write. `job`'s spec shape is
exactly `{ spec, input }` — extra per-job parameters belong
inside `input`, not as extra fields.

**First-run gate.** Before a workflow may start, the host runs
the gate: TypeScript type-check (exact pin 5.9.3; the host
refuses to start when the compiler is unavailable or the wrong
version), type extraction, and the M2 checker (BRA-29:
class/empty contracts, schema-level wiring, layering import
lint). `agentts check <workflow>` runs the gate without running
anything; `--json` emits structured diagnostics
(file, line, column, code, message, expected, actual, fix) as the
write/check/fix loop's machine interface. `agentts check
--layering` lints the layering boundary over a source tree (core
+ host never import Muse-specific things) — and
`apps/agentts/run.sh` runs it over the real tree on every full
run (BRA-68), so the boundary is enforced, not conventional.
There is deliberately no eslint config: the checker already is
the lint, and `run.sh` is what makes it enforced. Scope: core
src, host src, workflows, plugins — not `tests/`, whose drivers
import adapters to test them.

**`decide` is narrow by design.** The in-engine decision model
(`src/decision-model.ts`, `decideLocal`) parses machine-readable
signals out of the question (mean score vs threshold, misses vs
threshold, keyword scoring) and falls back to the first option
at confidence 0.5 when there is no signal. It computes from the
question content; it is not a general reasoner. A full agent is
a `job`, not a `decide`.

**Library workflows.** `JudgeFixLoop` (`workflows/judge-fix-loop.ts`)
is generic over the loop and concrete at the traps: the library
owns the loop logic (fan-out via `all`, reduce, decide cadence,
convergence rule) and calls the traps itself — `job`/`decide` with
contracts parameterized by the item and rubric types
(`JudgeInput<X, R>`, `FixInput<X, R>`, `RubricUpdateInput<R>`,
`AggregateInput`, `LoopDecision`). The caller supplies explicit
type arguments (`judgeFixLoop<WorkItem, Rubric>(...)`); the
extractor specializes the loop's inner trap sites per call site
(BRA-106), reading the concrete type arguments at each call and
re-resolving the inner trap sites under the parameter→concrete
map. The item and rubric types must be exported from the caller's
file — the specialization alias imports them by name. An inferred
call (no explicit type arguments), or a generic library that is
never called with concrete types, fails extraction loudly. The
extractor walks transitive relative imports, so library workflows
extract. `improve-loop.ts` is the same pattern as a
standard-library workflow (two parallel judges, aggregate,
decide, fix, at most three rounds) — with one deliberate
difference: its core takes the trap-calling steps as injected
callbacks, a test seam, not the JudgeFixLoop shape.

## 9. State layout

Default state dir is `./.agentts-state` in the working directory
(or `$AGENTTS_STATE_DIR`); the production state dir is
`~/workspace/agentts-state`. The host creates these subdirs:

| Path | Contents |
| --- | --- |
| `journals/<run>.journal` | JSONL, the source of truth (Section 7) |
| `blobs/<run>.snap` | Snapshot from the last successful suspension, sha256-verified; the only snapshot the host trusts on resume |
| `slices/<run>.{snap,out,log}` | Transient live snapshot, captured stdout, C-host stderr log |
| `slices/<run>.result.json` | Run result file written by the C host on completion |
| `runs/<run>.json` | Persisted registry entry (snapshot path, exit code, workflow path, frozen copy, engine version) |
| `runs/<run>.driver.ts`, `runs/<run>.bundle.js(.map)` | Generated driver + pinned bundle and source map |
| `runs/<run>.gate-answers.json` | Delivered gate answers |
| `frozen/<hash>/` | Frozen workflow closures, content-addressed (Section 3.2) |
| `cache/` | Extraction/schema cache keyed by content hash |
| `queue.json` (+ `queue.json.bak`) | The run queue (runId, workflow, adapter, status, input, priority, taskId, frozen copy, engine version) |
| `task-runs.json` | Local task→run mirror |
| `cost-actuals.jsonl` | Host trap-actual log for the cost model |
| `worker-jobs/` | Pool job store (`store.json` + backup), `jobs.log`, `scheduler.log`, cost model, quotas, server log |
| `deliveries/` (+ `deliveries.log`) | Delivery outbox records |
| `tick/` | Tick-agent liveness state (`state.json`) |
| `driver.lock/` | Driver lock (`holder.json` + heartbeat) |
| `corruption.log` | Append-only quarantined-corruption records |

What does **not** survive a restart: the in-memory run registry
(persisted entries are reloaded from `runs/`), the in-memory
journals (reloaded from disk), queued adapter answers, and the
pending trap metadata for a trap that never resumed (harmless —
it is consumed on attach and stale entries are ignored).

## 10. Quickstart transcript

Verified 2026-11-16 against this tree. Build to a scratch
`OUT_DIR` (the in-tree `packages/durablets/out/durablets` binary
also works — the host falls back to it when `$DURABLETS_HOST` is
unset; the second run below used exactly that fallback):

```sh
$ make -C packages/durablets OUT_DIR=/tmp/bra64-qs/host-bin durablets
cc -g -O2 -Wall -Isrc -I/home/hatch/workspace/dquickts-build-minimal \
  src/durablets.c /home/hatch/workspace/dquickts-build-minimal/libquickjs.a \
  -lm -lpthread -ldl -o "/tmp/bra64-qs/host-bin/durablets"

$ cd apps/agentts
$ bun src/cli.ts version
agentts-host v0 (BRA-44), typescript 5.9.3

$ bun src/cli.ts check workflows/hello.ts --state-dir /tmp/bra64-qs/state
CHECK OK workflows/hello.ts: 1 trap site(s), entry hello(HelloInput): HelloResult,
gate + checker passed (typescript 5.9.3, checker bra29.3)

$ bun src/cli.ts run workflows/hello.ts --run-id run-hello \
    --input-file /tmp/bra64-qs/hello-input.json --wait \
    --state-dir /tmp/bra64-qs/state
{
  "greeting": "Hello, world!"
}

$ bun src/cli.ts result run-hello --state-dir /tmp/bra64-qs/state
{
  "greeting": "Hello, world!"
}
```

The run left a 10-event journal. The first three lines show the
shape (Section 7) — run-start enrichment, trap with site, suspend:

```json
{"event":"lifecycle","lifecycle":"started","runId":"run-hello",
 "workflowHash":"7cda9d93f9f4ff62f9a2a5eda70beb4841bc507b5acdacfdcaa6bc6e20c190e3",
 "workflowPath":".../apps/agentts/workflows/hello.ts",
 "submittedAt":"2026-11-16T22:01:05.178Z",
 "bundlePath":"/tmp/bra64-qs/state/runs/run-hello.bundle.js",
 "bundleMapPath":"/tmp/bra64-qs/state/runs/run-hello.bundle.js.map",
 "wallTs":"2026-11-16T22:01:05.240Z"}
{"event":"trap","runId":"run-hello","trapId":"run-hello/trap-0","ordinal":0,
 "type":"sleep","arg":{"ms":100},
 "site":{"file":".../state/slices/bundle-run-hello.js","line":181,"column":8},
 "wallTs":"2026-11-16T22:01:05.241Z"}
{"event":"lifecycle","lifecycle":"suspended","runId":"run-hello","kind":2,
 "wallTs":"2026-11-16T22:01:05.241Z"}
```

…followed by `queue-started` (with `frozenHash` and
`engineVersion: "dquickts-96a9a79+durablets-1a31de6141d8dc4b"`),
`trap-dispatch`, `clock-advance` (virtual 2027-01-01T00:00:00.000Z
→ +100ms), `trap-dispatched` (`adapter: "mock"`, `wallMs: 3`),
`lifecycle resumed`, `trap-result`, `lifecycle completed`.
`agentts profile run-hello` renders the same run as a timeline
with counters (1 trap, 1 result, 0 errors, 1 clock-advance,
8ms total wall time). The state dir also held the frozen closure
(`frozen/<hash>/workflows/hello.ts` + `src/agentts.ts`), the
extraction cache, `queue.json` (+ `.bak`), the blob
(`blobs/run-hello.snap`), and the pinned bundle + map.

## 11. CLI map

`agentts` is `bun src/cli.ts` from `apps/agentts/`; there is no
installed binary. Full usage is in `src/cli.ts` (the header
comment is authoritative — the host README's CLI list predates
several commands).

| Command | What it does |
| --- | --- |
| `run <workflow> [--run-id ID] [--input-file FILE \| --input JSON] [--wait] [--adapter mock\|direct\|muse] [--clock virtual\|real] [--state-dir DIR] [--task TASK] [--gates auto\|hold] [--workers-config F] [--mock-answers F]` | Submit (and, with `--wait`, drive + fetch result) |
| `result <runId>` | Fetch the validated output, or the current status |
| `status <runId>` | Run status + last 8 journal events |
| `check <workflow> [--json]` | First-run gate without running; `check --layering [dirs...]` lints the layer boundary |
| `deliver-gate <runId> <answer-json>` | Answer a held gate; drive with `queue run` |
| `queue list \| run \| repair [--force]` | Inspect, drive, repair the run queue |
| `admit [--backend linear\|local] [--wip N] [--map F] [--workflow P] [--dry-run]` | Layer-1 admittance (Section 6.1) |
| `sync-task <taskId> <runId> [--backend linear\|local]` | Mirror run status to a task |
| `cost-model` | Cost estimates per call site from `cost-actuals.jsonl` |
| `profile <runId> [--format text\|html] [--journal F] [--out F]` | Read-only journal timeline |
| `worker serve [--port N] [--lease-ms N] [--max-attempts N] [--affinity-hold-ms N] [--affinity-ttl-ms N] [--max-pool-size N] [--max-cpu-slots N] [--max-decisions-per-sec N] [--max-tokens-per-hour N] [--dispatch-aging-ms N]` | Start the pool server |
| `worker status \| cancel <jobId> \| get-job \| complete-job` | Pool operations (get/complete-job delegate to `plugins/muse/`) |
| `deliver-result <runId>` / `deliveries [--json]` | Delivery outbox (Section 3.7) |
| `escalate '<json>'` / `watchdog [--stale-minutes N] [--json]` | Escalations / tick-agent health |
| `version` | `agentts-host v0 (BRA-44), typescript <pin>` |

Exit codes: 0 done, 2 held at a gate, 1 error / refusal.

## 12. What is not built (honest limits)

- **No named workers, no routing to a specific worker, no
  per-worker memory.** Workers are anonymous pool members
  (Section 5.4); `workerId` is an operational handle for leases,
  affinity, and debugging. Cross-job memory lives per spec
  (`notes/<spec>.md`), not per worker. Whether named workers
  should exist, and whether they would accumulate memory, is
  undecided (BRA-50).
- **No versioned release, no published package, no hosted
  service.** The repo is private per BRA-33.
- **No C-host daemon.** One process spawn per run-slice.
- **No async adapters in v0.** `answer()` is synchronous; pool
  adapters block inside it.
- **No general reasoner in `decide`.** The local decision model
  parses the question text; anything needing judgment is a `job`.
- **Crash-during-`exec`-dispatch re-runs the command** (Section
  3.5) — visible in the journal, not silent, but a duplicate
  execution, not a deduped one.
- **A gate answer can be lost** in the sub-millisecond window
  between consumption and the `trap-dispatched` write; recovery
  is re-delivery by a human, and the window is unexercised by
  tests.
- **Pre-BRA-71 runs carry no frozen copy and no engine version**
  and resume from the live file, unchecked.
- **The bench regression gate is flaky.** `run.sh` gates on
  `./bench/check.sh --reps 3` (43 metrics); it has failed on a
  different marginal timing metric in roughly every other run
  during BRA-106 verification, while the same metrics go green on
  re-run (BRA-107, post-MVP). A green gate is not yet stable
  evidence; a red one is not yet evidence of a regression. See
  `apps/agentts/bench/README.md`.
- **The audit's caveat still applies in part:** the BRA-62
  robustness audit (`docs/audits/robustness-2026-11-16.md`) was
  written while BRA-59 was in flight and flagged run-path
  findings for re-verification after the flip. The durability
  mechanisms it audited predate the flip and are unchanged; the
  run-path findings were re-verified here only insofar as the
  quickstart above exercises them.

## 13. Source map (where each section lives)

| Section | Primary sources |
| --- | --- |
| Layers | `packages/durablets/README.md`, `packages/durablets/src/durablets.h`, `apps/agentts/src/adapter.ts` |
| Core | `packages/durablets/src/durablets.c`, `packages/durablets/src/durablets.h`, `packages/durablets/Makefile` |
| Host run path | `apps/agentts/src/host.ts` (`submit`, `runQueue`, `driveToCompletion`, `driverFor`, `bundle`, `result`), `apps/agentts/src/cli.ts` |
| Frozen copy / engine version | `apps/agentts/src/host.ts` (`freezeWorkflow`, `engineVersion`, `assertEngineVersion`), `apps/agentts/tests/test-bra71.ts` |
| Clock | `apps/agentts/src/host.ts` (`nowMs`, `clock-advance`), `apps/agentts/src/cli.ts` |
| Drive cap / lock / repair | `apps/agentts/src/host.ts` (`MAX_DRIVE_ROUNDS`, `acquireDriverLock`, `repairQueue`), `apps/agentts/tests/test-bra72.ts` |
| Crash recovery | `apps/agentts/src/host.ts` (`resumeFromCrash`, journal check, `sleepTargetMs`), `apps/agentts/tests/test-bra74.ts`, `apps/agentts/tests/test-bra75.ts` |
| Atomic writes / corruption | `apps/agentts/src/corruption.ts`, `apps/agentts/tests/test-bra76.ts`, `apps/agentts/tests/test-bra77.ts` |
| Cost / profiler / outbox / watchdog | `apps/agentts/src/cost-model.ts`, `apps/agentts/src/profiler.ts`, `apps/agentts/src/host.ts` (`recordDelivery`), `apps/agentts/src/watchdog.ts` |
| Adapters | `apps/agentts/src/adapter.ts`, `apps/agentts/plugins/*/src/<name>-adapter.ts`, `apps/agentts/plugins/*/src/adapter.ts`, `apps/agentts/plugins/README.md` |
| Worker model | `apps/agentts/src/worker-server.ts`, `apps/agentts/src/worker-protocol.ts`, `apps/agentts/plugins/muse/worker-loop.ts`, `apps/agentts/plugins/muse/WORKER.md`, `apps/agentts/plugins/muse/TICK-AGENT.md`, `apps/agentts/tests/test-bra61.ts`, `apps/agentts/tests/test-bra67.ts` |
| Scheduling | `apps/agentts/src/admittance.ts`, `apps/agentts/src/scheduler.ts`, `apps/agentts/src/quotas.ts`, `apps/agentts/src/cost-model.ts`, `apps/agentts/tests/test-scheduling.ts` |
| Journal | `apps/agentts/src/host.ts` (`journalEvent`, `ingestLog`, `enrichRunStart`, `splitTrapSite`), `apps/agentts/src/profiler.ts` |
| Workflow shape | `packages/durablets/src/agentts.ts`, `apps/agentts/src/agentts.ts`, `packages/durablets/agentts.md`, `apps/agentts/src/extract.ts`, `apps/agentts/src/gate.ts`, `apps/agentts/src/checker.ts`, `apps/agentts/src/validate.ts` |

## 14. Where the code disagrees with older write-ups (code wins)

- **The agentts module was not moved when BRA-44 landed.**
  `packages/durablets/agentts.md` says the move to the host "when
  BRA-44 lands, is a pure file move plus an import-path change."
  BRA-44 landed; the module was *not* moved. Canonical source
  remains `packages/durablets/src/agentts.ts`; the host carries a
  verbatim copy at `apps/agentts/src/agentts.ts` (the same pattern
  the mock plugin uses). This doc follows the code.
- **Layer 3 lives in `apps/agentts/plugins/`, one folder per
  environment (BRA-68).** `packages/durablets/README.md` maps
  layer 3 to `adapters/`; that mapping was stale twice over —
  the actual adapters used to live in `apps/agentts/src/adapters/`
  (built-ins) plus `apps/agentts/plugins/<name>/src/adapter.ts`
  (loadable plugins), and a top-level `adapters/` directory never
  existed. BRA-68 moved the three built-in implementations into
  their plugin folders (`plugins/<name>/src/<name>-adapter.ts`,
  seam next to each), so the folders now read as the
  architecture; see `apps/agentts/plugins/README.md`.
- **Queue writes are atomic now.** The BRA-62 robustness audit
  (`docs/audits/robustness-2026-11-16.md`) records non-atomic
  `queue.json` writes and silent loss on corrupt reads as live
  failure modes. BRA-77 closed both (atomic write + backup
  recovery); Section 3.6 describes the current state, not the
  audit's.
- **The host README's CLI list was stale; it is current now.**
  `apps/agentts/README.md` used to omit `result`,
  `deliver-result`, `deliveries`, `escalate`, `watchdog`, `queue
  repair`, and `worker get-job` / `complete-job`. BRA-108
  (2026-11-17) brought it in line with `src/cli.ts` (see also
  Section 11). `apps/agentts/src/cli.ts` remains authoritative.
- **The two Google Docs were not consulted.** The Skills and
  Process Ideation doc and the Workflow Engine Build Plan live in
  Google Docs, not in this repo, and were not read for this
  write-up. This doc is written from the code alone, per the
  issue's evidence standard; any place where those docs describe
  a different system is a place where the docs are out of date,
  not the code.
