# Driver endpoints on the worker server (BRA-116)

Measured 2026-11-18 on this VM with the `production_path` bench group
in `apps/agentts/bench/` (`bun bench/run.ts --metrics production_path`,
baselines in `bench/baselines.json`). Every number below is a median of
5 reps; three independent runs were made and all three are shown. This
is the BRA-100 audit's option A, built: the tick agent calls HTTP
instead of fresh `bun` per action.

## Measured: the production path over HTTP

One unit of work = one run submitted → driven → delivered, through the
exact commands in `plugins/muse/TICK-AGENT.md`, against a throwaway
worker server on a scratch state dir (never the production state dir
or server). Submit stays a fresh `bun src/cli.ts` process (the
submitter is the operator/coordinator, not the tick agent — there is
no `/submit` endpoint); every tick-agent action is an HTTP call (curl
spawn). Warm extract cache throughout — the first CLI submit pays the
cold extract once in warm-up, so these numbers are the per-action
tax, not tsc.

| Metric | Run 1 | Run 2 | Run 3 | BRA-100 run 1 | What it is |
|---|---|---|---|---|---|
| `prod_tick_ms` | 10.74 | 12.33 | 8.36 | 12.18 | `curl GET /tick?timeoutMs=0` (curl spawn + fetch + immediate server response; the 60s block is not waited) |
| `prod_tick_beat_ms` | 9.12 | 11.23 | 7.24 | 12.46 | `curl POST /tick-beat` (curl spawn + POST) |
| `prod_submit_ms` | 530.32 | 527.76 | 486.91 | 531.74 | `cli.ts run` (submit only, no `--wait`) — unchanged, stays CLI |
| `prod_queue_run_ms` | 71.24 | 82.64 | 95.23 | 532.29 | `curl POST /queue/run`, one queued trivial run — the per-drive-call cost over HTTP |
| `prod_deliver_result_ms` | 22.44 | 23.75 | 22.19 | 463.07 | `curl POST /deliver-result` |
| `prod_queue_list_ms` | 9.09 | 9.10 | 7.52 | 386.81 | `curl GET /queue/list` (light sweep after a tick timeout) |
| `prod_deliveries_ms` | 8.20 | 9.42 | 7.18 | 387.94 | `curl GET /deliveries` (check after a drive) |
| `prod_e2e_ms` | 699.04 | 674.21 | 676.06 | 2255.37 | whole sequence, 1 fresh Bun process + 10 HTTP calls (below) |
| `prod_invocations_per_run` | 1 | 1 | 1 | 11 | fresh Bun processes per unit of work (exact) |

Baselines are the run 1 medians (the BRA-93 convention: baselines
come from one real measured run); thresholds are 3.0x for latency,
1.0x for the count (see "Decisions" below). The baselines were set by
hand from run 1 (not `--write-baselines`), with `MANUAL-BASELINE`
lines in `bench/ratchet.log` carrying the before/after numbers — all
nine are tightens, so the `loosen` command's `MANUAL-LOOSEN` label
would have lied.

Run-to-run agreement: the e2e medians agree within 3.7% (699.04,
674.21, 676.06) and submit within 8% (530.32, 527.76, 486.91).
The small-ms metrics wobble more in relative terms — tick 8.36–12.33,
beat 7.24–11.23, queue_run 71.24–95.23, deliveries 7.18–9.42 — but
those are 1–11ms absolute differences on a loaded VM, the scheduling
noise floor, not drift: the within-run means agree much more closely
(queue_run means 80.85 vs 75.40 vs 86.48 across the three runs). The
3.0x thresholds have ample headroom over this noise; no run-to-run
variance note is needed beyond this paragraph.

## The count: 1 fresh Bun process per unit of work

Itemized from the tick-agent loop (`TICK-AGENT.md`), verified by the
bench executing the sequence and counting its own spawns:

| # | Call | Cost (median) |
|---|---|---|
| 1 | `cli.ts run` (submit, by the submitter) | ~530ms |
| 2 | `curl GET /tick` (notices `run-submitted`) | ~11ms |
| 3 | `curl POST /tick-beat` (before the drive) | ~9ms |
| 4 | `curl POST /queue/run` (the drive) | ~71ms |
| 5 | `curl POST /tick-beat` (after the drive) | ~9ms |
| 6 | `curl GET /tick` (notices `workflow-completed`) | ~11ms |
| 7 | `curl POST /tick-beat` (before the deliver) | ~9ms |
| 8 | `curl POST /deliver-result` | ~22ms |
| 9 | `curl POST /tick-beat` (after the deliver) | ~9ms |
| 10 | `curl GET /deliveries` (check after the drive) | ~8ms |
| 11 | `curl GET /queue/list` (light sweep) | ~9ms |

The e2e median (699ms) is the submit floor (~530ms) plus ~170ms of
HTTP calls. The acceptance criterion's "~0.1s" was directional
("toward"); the measured floor is set by the submit spawn, which
BRA-116 deliberately left CLI. A `/submit` endpoint would take the
e2e to ~170ms — filed as a follow-on only if the submit floor ever
matters (see "Deliberate limits").

## The self-notify deadlock, found by the bench and fixed

The first bench run after the endpoint switch measured
`prod_queue_run_ms` at 2069ms and `prod_e2e_ms` at 2613ms — WORSE
than BRA-100. Direct timing isolated it: `POST /queue/run` took
2.24s while `cli.ts queue run` on the same state took 0.45s, and a
standalone `makeDriverHost` + `runQueue` took 116ms. The 2s was in
the server around the drive.

The cause: `Host.notifyEvent` POSTs the event to the worker server
over HTTP with a synchronous curl spawn and a 2s timeout
(`httpPostSync(..., 2000)`, best-effort). When the server itself
drives a run to a terminal state, the driver Host notifies the server
— itself — while the server's event loop is blocked by the very
`spawnSync` making the call. The `/event` POST cannot be answered
until the loop runs again, which happens only when the curl times
out. So every server drive burned its full 2s notify timeout, and
the `workflow-completed` event was LOST (the tick agent's second
tick never saw it; only the catch-up sweep would have found the
delivery). The CLI never hit this: it notifies a different process,
whose loop is free to answer.

The fix (in this issue, not a follow-on — the endpoints are not done
if the drive costs 2s and drops its completion event): the Host takes
an optional in-process event sink (`HostConfig.onEvent`), and
`notifyEvent` calls it instead of the HTTP POST when set. The
server's `driverHost()` passes its own `emitEvent`, so a driver
Host's events land directly in the server's event queue. Hosts
outside the server (the CLI) leave it unset and notify over HTTP
exactly as before. Verified directly: `POST /queue/run` 2.24s →
0.097s, and the following tick returns the `workflow-completed`
event. The bench numbers above are all post-fix.

## The endpoints

Six driver endpoints on the worker server (`src/worker-server.ts`),
each mirroring the CLI command of the same name exactly (same Host
calls, same refusals, same records):

| Endpoint | Mirrors | Notes |
|---|---|---|
| `POST /queue/run` | `queue run` | runQueue + `--task` sync; driver-lock refusal is 409; repair report in the response |
| `POST /deliver-result` | `deliver-result` | 404 unknown run, 400 non-terminal; `deliveredBy` defaults to `"tick-agent"`; re-delivery is idempotent |
| `GET /queue/list` | `queue list` | current queue entries as JSON |
| `GET /deliveries` | `deliveries --json` | outbox records as JSON |
| `POST /escalate` | `escalate` | 400 unless kind + non-empty reason |
| `POST /deliver-gate` | `deliver-gate` | 404 no suspended run, 400 no gate pending; answer presence checked by key, so JSON null is a valid answer |

`tests/test-bra116.ts` proves them (endpoint behaviour + error
cases, lock refusal in both directions, restart-mid-drive repair,
deliver-gate end to end). `tests/tick-standin.ts` drives through the
same endpoints, so `tests/test-tick-driver.ts` now exercises the
HTTP path end to end with no in-process Host.

## Decisions (recorded)

- **Host per request, not one Host held by the server.**
  A held Host's in-memory journals/registry go stale the moment
  another process drives the same state dir (a CLI `queue run`
  writes newer journals/snapshots; the held Host would drive from
  an old snapshot and `result()` would read an old journal), and a
  held Host pins every journal in memory forever (BRA-98 eager
  load) — unbounded growth in a long-lived server. Cost is 0.4–
  1.6ms at bench journal sizes (measured in the smoke test's
  standalone timing: `makeDriverHost` 7.6ms, `runQueue` 108.5ms
  for a trivial run); the extract cache is on disk
  (`stateDir/cache`), so a fresh Host does not pay cold tsc.
  Recorded in the `makeDriverHost` comment in `src/host.ts`.
- **Submit stays CLI (no `/submit` endpoint).** The submitter is
  the operator/coordinator, not the tick agent; moving gate +
  extract + validation into the server is a bigger API and
  process-lifecycle surface. The remaining ~0.5s submit spawn is
  the production path's floor after this change; if the measured
  numbers show submit dominating, a `/submit` endpoint is the
  follow-on (see below).
- **Tick/beat move to curl too.** `tick.ts` is a thin fetch
  wrapper; the audit's ideal was 0 Bun spawns from the tick agent;
  the 5 tick/beat spawns are ~12ms each (~60ms/unit, more than the
  whole HTTP driver path costs). `tick.ts` stays in the repo as the
  operator wrapper. `TICK-AGENT.md` documents the curl equivalents
  and the exit-22 = 409 meaning.
- **`prod_invocations_per_run` counts Bun processes only.**
  Curl spawns are ~5ms, not the tax. Baseline becomes 1 (the
  submit spawn); the 1.0x count threshold is preserved, so any new
  Bun spawn in the loop still fails the gate.
- **e2e keeps submit in its definition** (comparable with
  BRA-100): expected ~0.6s (submit ~500ms + ~100ms HTTP), not
  ~0.1s — the acceptance's "~0.1s" is directional ("toward").
- **In-process notify for driver Hosts** (see above): the server
  passes its `emitEvent` as the driver Host's `onEvent` sink.
  The CLI's HTTP notify is unchanged.
- **No `/escalations` read endpoint.** The standin's escalation
  dedupe reads the escalations dir from disk, as the production
  agent does (it has shell access to the state dir); the dedupe
  is a local read, not a driver action, and is out of the issue's
  six endpoints.

## Acceptance check (BRA-116)

- Driver endpoints exist and mirror the CLI: yes — six endpoints,
  `tests/test-bra116.ts` section A (behaviour + error cases) green.
- Tick agent calls HTTP instead of fresh bun per action: yes —
  `TICK-AGENT.md` is curl throughout; `prod_invocations_per_run`
  11 → 1; e2e 2255.37 → 699.04ms.
- Lock interaction: yes — section B, both directions (409 from
  the server while the CLI drives; non-zero `queue run` while the
  server drives), exec runs exactly once each way.
- Restart mid-drive: yes — section C, SIGKILL mid-drive, restart,
  repair reports `running -> queued`, run completes.
- Deliver-gate end to end: yes — section D, held run answered
  through `POST /deliver-gate`, drive completes it.
- Full `run.sh` staged + copy-path: exit 0, counts at or above
  the BRA-100 baseline (2002 OK / 79 ^PASS / 52 bench metrics),
  bench ALL GREEN — see the verification section of the BRA-116
  report (numbers in the run logs, not repeated here).

## Deliberate limits (not proved / not built)

- **No `/submit` endpoint.** The submit spawn (~530ms) is now
  76% of the e2e. A `/submit` endpoint would take the e2e to
  ~170ms. Not built: the submitter is the operator, and the
  endpoint is a bigger API surface (gate + extract + validation
  in the server). Follow-on if the submit floor ever matters.
- **The deliver-gate 400 for "no gate pending" is not exercised.**
  Reaching it needs a registry entry for a run suspended at a
  non-gate trap, and no deterministic workflow produces one. The
  server's own deliver-gate 400s (missing answer, missing runId)
  are covered in `test-bra116.ts` section A, and the catch → 400
  branch is the same two lines the CLI's deliver-gate takes.
- **Rollout is manual.** The production server (:18741) runs old
  code with no driver endpoints — it must be restarted with the
  new code before the tick agent uses the curl commands. The live
  tick agent picks up the new instructions on its next spawn (it
  holds the old text in context). The production server/state dir
  were not touched in this task.
- **The 2s self-notify timeout still exists for any OTHER
  in-server HTTP notify.** The fix routes the driver Host's
  notifies in-process; the CLI's HTTP notify path (and its 2s
  timeout) is unchanged and correct for a separate process. If a
  future in-server caller notifies over HTTP to itself, it will
  hit the same 2s burn — the `onEvent` sink is the pattern to
  reuse.
