# Muse adapter plugin (BRA-48) — the worker pool

The Muse environment adapter + the get-job/complete-job worker
pool. Layer 3 only: the host, the scheduler's interface, and the
workflows know nothing about Muse or subagents — the adapter
answers job traps through an HTTP queue, and workers (Bun processes
today, Muse subagents in the true leg) pull jobs from it.

## Layout

```
plugins/muse/
  src/adapter.ts      Host.loadAdapter seam: createAdapter() -> MuseAdapter
  src/muse-adapter.ts MuseAdapter (host Adapter + core async methods)
  worker-loop.ts      Worker-side loop, script mode (Bun proof leg)
  get-job.ts          One-shot get-job (subagent leg)
  complete-job.ts     One-shot complete-job (subagent leg)
  WORKER.md           Standing instructions for subagent workers
  jobspecs/           Prose job specs (judge/fix/aggregate/rubric-update)
  README.md           This file
src/
  worker-protocol.ts  Shared wire types + defaults + endpoints
  worker-server.ts    The queue server (Bun.serve, sole writer)
  worker-http.ts      Sync (curl) + async (fetch) queue clients
  scheduler.ts        Scheduler interface + AffinityScheduler (v0)
```

The implementation lives here now (`src/muse-adapter.ts`, BRA-68),
next to the plugin seam — `src/adapters/muse-adapter.ts` no longer
exists. `src/muse-adapter.ts`
imports nothing Muse-specific from the host side — the adapter is
the only file that knows about the queue, and the queue knows
nothing about Muse.

## API (queue server, loopback only)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | /health | liveness + config |
| POST | /enqueue | `{spec, input, runId, trapId, workspace?, leaseMs?, maxAttempts?}` -> `{jobId}` |
| GET | /get-job?workerId=W | -> `{job: null}` or `{job: JobAssignment}` |
| POST | /complete-job | `{jobId, workerId, result? \| error?, files?}` -> `{ok, status}` / 409 |
| POST | /heartbeat | `{jobId, workerId}` -> `{ok, cancelled}` / 409 |
| GET | /job-status?jobId=J | full job record (result/files included) |
| GET | /jobs | all jobs |
| POST | /cancel-job | `{jobId, reason?}` -> `{ok, status}` |
| GET | /jobspec?spec=S | `{spec, hash, text}` |
| GET/POST | /notes?spec=S, /note | specialist learnings per spec |
| POST | /gate-notify | record a pending gate (informational) |
| GET | /gates | pending gate notices |

State: `<stateDir>/worker-jobs/store.json` (sole writer: the
server), `jobs.log` (every transition), `scheduler.log` (every
get-job decision), `notes/<spec>.md` (learnings), `server.log`
(auto-started server output).

## Decisions (BRA-48, recorded in the issue)

- **File effects return as full file contents** with the completion
  (not a branch push, not a textual patch, not a plugin file copy).
  Exact bytes, reviewable, applies anywhere; the coordinator
  applies them after review — never auto-applied. 1MB cap.
- **Crash/timeout: re-queue, then fail loudly.** Lease expiry
  re-queues (attempts++); at maxAttempts (default 3) the job fails
  and the adapter throws at the call site. An explicit worker error
  counts as an attempt the same way.
- **Affinity preference rule** (see `src/scheduler.ts`): reserved
  for the warm specialist inside the hold window (default 2s) >
  affinity match (worker warm for the spec) > oldest takeable job
  (load-balancing fallback). Warmth decays after 30min without a
  completion of that spec.
- **Scheduler interface is the BRA-49 seam**: `selectJobForWorker`
  + `WorkerView`/`QueuedJobView`/`Selection`. BRA-49 replaces the
  implementation, not the interface.
- **BRA-56 closed by the CLI flags** (`--workers-config`,
  `--mock-answers` in `src/cli.ts`): any workflow's specs can be
  registered without a per-workflow plugin. The briefing plugin
  still works and is untouched.
- **No sandbox beyond the process boundary + workspace cwd in v0**
  for exec/worker processes. A real sandbox is future work.

## Running it

```sh
# 1. Start the queue server (explicit; the adapter auto-starts it
#    if you skip this, but the true-subagent leg needs it running):
bun src/cli.ts worker serve --state-dir <state> --port 18741

# 2. Start workers (proof leg: Bun processes, genuine computation):
bun plugins/muse/worker-loop.ts --server http://127.0.0.1:18741 \
    --worker-id w1 --workspace-root <scratch>/workspaces \
    --workers-config <scratch>/workers.json --poll-ms 500

# 3. Run a workflow through the pool:
bun src/cli.ts run tests/workflows/workflow-judge-fix-loop.ts \
    --adapter muse --state-dir <state>

# True-subagent leg (coordinator): spawn subagents with WORKER.md +
# the server URL + a stable --worker-id each; they run get-job.ts /
# complete-job.ts in a loop. No Bun worker processes needed.
```

Workers config format (`--workers-config`, also `--workers-config`
on `agentts run` for the direct adapter — the BRA-56 fix):

```json
{ "judge": "/abs/path/workflows/worker.ts",
  "fix": "/abs/path/workflows/worker.ts",
  "aggregate": "/abs/path/workflows/worker.ts",
  "rubric-update": "/abs/path/workflows/worker.ts" }
```

## Proof

`tests/run-worker-pool-suite.ts` (run via `./run.sh`): scheduler
unit checks, JudgeFixLoop end-to-end through the pool (9 jobs, each
delivered once), crash/timeout re-queue, affinity across runs,
cancel of a queued and a running job, JSON-boundary rejection,
file-effects return. Read the suite's output + `jobs.log` /
`scheduler.log` — a green summary alone is not the evidence.
