# AgentTS

Durable execution for agent workflows, in TypeScript.

A workflow is an ordinary TypeScript function. When it needs something
from the outside world — a worker agent session, a shell command, a
human answer, a wait, a cheap decision — it calls a trap, and the run
**suspends into a snapshot blob on disk**. The trap is answered by the
host (or by a worker from a pool), the run resumes from the blob, and
it continues exactly where it left off. A crashed host, a killed
process, or a machine restart does not lose the run: the journal
records what already happened, the blob holds where it stopped, and
the next drive resumes from there instead of starting over. That is
the whole idea: **workflows are functions that can be paused for
arbitrary real-world waits — minutes, hours, days — and resumed
exactly, because every pause is a durable snapshot plus a journal
entry, not memory.**

Status: **pre-release — public release in progress.** The MIT
LICENSE is in place and the MVP release checklist (Linear BRA-91)
is being worked; the repo stays private until the checklist lands
and the visibility flip is made (Linear BRA-33). There is no
versioned release yet. The host is v0 (`agentts-host
0.1.0`); the core is the BRA-43 build. Everything here describes the
system as it is today, verified against the code — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

```
packages/durablets/   Layer 1 — DurableTS core (C + thin CLI):
                      trap / all / any / race builtins, suspend/resume
                      blobs. Knows nothing about jobs, journals, or
                      scheduling. See packages/durablets/README.md.
apps/agentts/         Layer 2 — AgentTS host (TypeScript):
                      submit / queue / drive, journal, registry,
                      adapters, scheduler, worker pool server, CLI.
                      See apps/agentts/README.md.
apps/agentts/plugins/ Layer 3 — environment adapters, one folder per
                      environment (mock, direct, muse, briefing):
                      each holds its adapter implementation next to
                      its loadable seam; plugins/muse/ also holds
                      the worker/tick-agent scripts. See
                      apps/agentts/plugins/README.md.
experiments/          The experiments the core generalized from
                      (combinators, cancellation, engine prototypes).
docs/                 This architecture doc + audit reports.
```

## Quickstart

Prerequisites: `bun` 1.4.4, `cc`, `git`, and `make` — plus the
patched minimal dquickts tree, which you build once per checkout
with `packages/durablets/re-vendor.sh` (it installs as
`packages/durablets/vendor/dquickts`, the core Makefile's default).
The full clean-checkout build, step by step, is in
[`BUILDING.md`](BUILDING.md). All state below goes to a scratch dir,
never the production state dir (`~/workspace/agentts-state`).

```sh
# 1. Build the core C host (binary lands in packages/durablets/out/)
make -C packages/durablets durablets

# 2. Check the host works
cd apps/agentts
bun install  # once per checkout, if node_modules is absent
bun src/cli.ts version
# agentts-host v0 (BRA-44), typescript 5.9.3
```

A hello workflow — a default-exported function, one JSON-capable
input in, one JSON-capable output out — ships at
`apps/agentts/workflows/hello.ts`:

```ts
import { sleep } from "../src/agentts";

export interface HelloInput {
  name: string;
}

export interface HelloResult {
  greeting: string;
}

export default function hello(input: HelloInput): HelloResult {
  sleep({ ms: 100 });
  return { greeting: `Hello, ${input.name}!` };
}
```

```sh
# 3. Check it (first-run gate: type-check + extraction + M2 checker)
bun src/cli.ts check workflows/hello.ts --state-dir /tmp/agentts-quickstart/state
# CHECK OK workflows/hello.ts: 1 trap site(s), entry hello(HelloInput): HelloResult,
# gate + checker passed (typescript 5.9.3, checker bra29.3)

# 4. Run it: submit, drive the queue, fetch the result
echo '{"name":"world"}' > /tmp/hello-input.json
bun src/cli.ts run workflows/hello.ts --run-id run-hello \
  --input-file /tmp/hello-input.json --wait \
  --state-dir /tmp/agentts-quickstart/state
# {
#   "greeting": "Hello, world!"
# }

# Inline JSON works too: --input '{"name":"world"}' instead of
# --input-file; giving both is refused (exit 1).

# 5. Fetch the result again later (it is persisted, not just printed)
bun src/cli.ts result run-hello --state-dir /tmp/agentts-quickstart/state
# {
#   "greeting": "Hello, world!"
# }
```

Every command above was run verbatim from a fresh scratch copy of
this tree on 2026-11-17 (scratch state dir, mock adapter — the
default outside the production state dir): check, run, and result
all exited 0, and the run printed `{"greeting": "Hello, world!"}`.
The full test suite in the same scratch copy (`./run.sh`) exited 0
with 1745 OK lines, bench gate ALL GREEN on all 43 metrics. (The
log's 11 FAIL lines are the known benign ones — passing assertions
whose labels contain "FAIL": fail-fast test names and
expected-failed-state checks. Every suite exits non-zero on a real
failure, so exit 0 is the proof.) The bra67 timing checks that
failed on 2026-11-16 now pass — BRA-102 loosened their bounds; see
[`BUILDING.md`](BUILDING.md#troubleshooting). The same quickstart
was first run against this tree on 2026-11-16; that run's full
transcript, including the journal it left behind, is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#quickstart-transcript).

## The run-ID model

- `agentts run <workflow> --input-file <json>` (or `--input '<json>'`
  for inline JSON; giving both is refused) **submits** and
  returns a run ID immediately (`RUN <id>`). It does not execute the
  workflow inline; there is no in-process drive mode.
- `agentts queue run` **drives** the queue: each queued run is driven
  to completion, a gate hold, or failure, in priority order.
- `run --wait` is the same path (submit, then `queue run`, then
  `result`), not a second mode.
- `agentts result <runId>` fetches the validated output once the run
  is done; `agentts status <runId>` reads the journal;
  `agentts queue list` shows the queue. Exit codes: 0 done, 2 held
  at a gate, 1 error / refusal.
- A run is driven with the **adapter it was submitted with**
  (`--adapter mock|direct|muse`). Scratch state dirs default to
  `mock` (canned answers); the production state dir defaults to
  `direct` (real execution) — a forgotten `--adapter` must never
  silently fake a production run.

## Where to go next

- [`BUILDING.md`](BUILDING.md) — building from a clean checkout:
  prerequisites, vendoring the engine with `re-vendor.sh`, the
  build, the checks, and troubleshooting. Start here if you just
  cloned the repo.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the technical
  reference: the three layers, the trap flow, the worker model,
  two-layer scheduling, the journal, and the workflow shape.
- [`docs/skills/agentts-usage.md`](docs/skills/agentts-usage.md) —
  the usage skill (BRA-69): how to use the system and the core
  workflow library — traps, combinators, the first-run gate, the
  mock adapter, the CLI, the library workflows.
- [`docs/skills/workflow-design.md`](docs/skills/workflow-design.md) —
  the workflow-design skill (BRA-70): judgment from our own
  learning — inline vs. by-reference trap data, jobspecs vs.
  inputs, decisions and the (not yet built) cascade.
- [`packages/durablets/README.md`](packages/durablets/README.md) —
  the core: builtins, blob protocol, cancellation, the JSON
  boundary rule.
- [`packages/durablets/agentts.md`](packages/durablets/agentts.md) —
  the run-side `agentts` module API (trap wrappers, combinators).
- [`apps/agentts/README.md`](apps/agentts/README.md) — the host:
  CLI, worker pool, scheduling, profiler, recorded decisions.
- [`docs/audits/`](docs/audits/) — the BRA-62 robustness audit and
  the journal/profiler audit (2026-11-16).
- `apps/agentts/run.sh` — build + full test run (reference, mock,
  host, swap, worker pool, scheduling, tick driver, and the
  BRA-61/67/71–77 suites). It writes only to scratch dirs, except
  the bench suite, which writes `baselines.json` and `ratchet.log`
  into `apps/agentts/bench/` when it ratchets (see that directory's
  README).

## What this is not (yet)

- No versioned release, no published package, no hosted service.
- No long-lived C-host daemon: the host spawns the C binary once
  per run-slice (blob + JSON over process spawn).
- No general reasoning in the `decide` trap: the in-engine decision
  model is a narrow, deterministic parser of the question text.
  A full agent is a `job` trap, not a `decide` trap.
