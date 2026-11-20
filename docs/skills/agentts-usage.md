# AgentTS usage skill — how to use the system and the core workflow library

**Status:** 2026-11-16, verified against the code in this repo (post-BRA-59
function flip, after BRA-64). This is the HOW-TO skill. The judgment
skill — what to put inline vs. by reference, jobspecs vs. inputs,
decisions and the cascade — is the companion
[`workflow-design.md`](workflow-design.md) (BRA-70). The technical
reference is [`../ARCHITECTURE.md`](../ARCHITECTURE.md); the front door
is the top-level [`README.md`](../../README.md). This skill links to
those docs instead of repeating them. Where this skill and
`ARCHITECTURE.md` disagree, the code wins — see "Known disagreements"
at the end.

**Audience:** an author (human or agent) writing or running a workflow.
**Scope:** the function workflow shape, the six traps, the combinators,
the first-run gate, the mock adapter, the CLI, the workflow library,
and the run/journal/result model. Nothing here changes the system; it
teaches how to use it as built.

## 1. The workflow shape: a function, one JSON in, one JSON out

A workflow is an ordinary TypeScript function. The default export IS
the workflow:

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

Rules that follow from the shape (see `ARCHITECTURE.md` §8 and
`packages/durablets/src/agentts.ts`):

- **One JSON-capable input in, one JSON-capable output out.** The
  host generates a driver (global code) that calls the entry function
  with the input JSON; the C host captures the return value as the run
  result. The entry function must stay a plain sync function called
  from global code — module frames cannot suspend.
- **Types are the only source of truth.** There are no schemas in
  author code. The host extracts JSON Schema from your types on first
  run (see §4).
- **The old global-script shape is gone.** Do not write it, do not
  document it. (BRA-59 function flip.)
- **Workflows live under `apps/agentts/workflows/library/`** (the
  standard library) or `apps/agentts/workflows/dogfood/` (real
  consumers proving the engine) or `apps/agentts/tests/workflows/`
  (test workflows).
  They import the run-side module as `../src/agentts` (or
  `../../src/agentts` from `tests/workflows/`). The canonical module
  source is `packages/durablets/src/agentts.ts`;
  `apps/agentts/src/agentts.ts` is a verbatim copy.
- **No in-process drive mode.** There is exactly one way to start a
  run: submit it (see §6). `run` returns a run ID immediately;
  `run --wait` is submit → `queue run` → `result` on the same path,
  not a second mode.

## 2. The six trap types

A trap is a call out of the workflow to the outside world. The run
suspends into a snapshot blob, the host (or a worker) answers, and
the run resumes exactly where it left off. The wrappers live in the
`agentts` module (`packages/durablets/src/agentts.ts`); the core
routes traps by type string only and never interprets them.

| Trap | Call | Result | What it is for |
| --- | --- | --- | --- |
| `job` | `job<Input, Output>({ spec, input })` | `Output` (call-site type) | A worker agent session. `spec` is the jobspec name; `input` is that session's input. The expensive, general tool — anything needing judgment. |
| `exec` | `exec({ cmd, args?, cwd? })` | `{ stdout, exitCode, stderr? }` | Run a shell command for real (direct adapter) or canned (mock). One command, one result. |
| `gate` | `gate({ question, options? })` | `{ answer }` | A human answer. The run holds until a human delivers one with `deliver-gate`. Never auto-answered by the direct adapter. The mock adapter (default outside the production state dir) auto-answers "yes" unless the run is submitted AND driven with `--gates hold` — pass it to BOTH `run` and `queue run` (BRA-119); an auto-answer logs `GATE AUTO-ANSWERED` and marks the journal events `auto: true`. |
| `sleep` | `sleep({ ms })` | `{ sleptMs }` | Wait a duration from now. Host-owned clock, not an adapter call. |
| `cron` | `cron({ at })` | `{ scheduled }` | Wait until a single ISO datetime. **One-shot** — the name does not imply recurrence. Host-owned. |
| `decide` | `decide<Output>({ question, options? })` | `Output` (call-site type) | A cheap, narrow decision — no agent session. See §2.1. |

**The trap-boundary JSON rule.** Everything crossing a trap boundary
must be clean JSON. Every wrapper runs its arg through `toJsonValue()`
before calling `trap()`: `undefined`, functions, symbols, `BigInt`,
`NaN`/`Infinity`, `Map`/`Set`, typed arrays, class instances,
circular references, array holes, and nesting past 1000 levels all
throw a `JsonBoundaryError` **synchronously at the call site** with a
precise path (e.g. `$.input.deadline`), a machine-readable kind, and
a fix — and the trap never dispatches. `Date` is the one sanctioned
conversion, to its ISO string. Plain `JSON.stringify` is not the
mechanism: it silently drops functions/`undefined`/symbols, turns
`Map`/`Set` into `{}`, and `NaN`/`Infinity` into `null`. The host
enforces the same rule on result-out and on every journal write.
`job`'s spec shape is exactly `{ spec, input }` — extra per-job
parameters belong inside `input`, not as extra fields.

**Trap identity.** A trap's id is `runId + "/trap-N"` (runId + ordinal
as one id). The wrappers attach the call site (`{ file, line, column }`,
bundle coordinates) to the trap arg under a reserved key; the host
strips it before dispatch and journals it as the trap event's
top-level `site`, so the journaled arg stays exactly the spec you
passed.

### 2.1 `decide` is narrow by design — read this before using it

The in-engine decision model (`apps/agentts/src/decision-model.ts`,
`decideLocal`) parses machine-readable signals out of the question
and picks an option. It is a deterministic parser, not a general
reasoner. Verified live 2026-11-16 (scratch state dir, direct
adapter — see §9):

```ts
decide<DecideResult>({
  question: "loop 2: mean score 0.9 threshold 0.8; 3 of 3 approved. Should the work item be revised or kept?",
  options: ["revise", "keep"],
});
// → { choice: "keep", confidence: 0.65 }
decide<DecideResult>({ question: "Which colour should the cover be?", options: ["blue", "green"] });
// → { choice: "blue", confidence: 0.5 }  — first option, low confidence
```

Signals it parses, in order:

1. `"mean score X"` (or `"score X"`) + `"threshold Y"`: choice is the
   option matching `/converg|keep|accept|pass|yes/i` when X ≥ Y, else
   the option matching `/revise|continue|change|no|reject/i`.
   Confidence `min(0.99, 0.55 + |X − Y|)`.
2. `"misses: N"` + `"update ... if misses >= M"`: choice is the
   option matching `/update/i` when N ≥ M, else `/keep/i`, at
   confidence 0.8.
3. Keyword scoring fallback: +1 per positive keyword (`good`,
   `ready`, `pass`, `strong`, `clear`, `complete`), −1 per negative
   (`bad`, `fail`, `missing`, `weak`, `unclear`, `incomplete`);
   confidence 0.55.
4. No signal at all: first option at confidence 0.5. The fallback is
   journaled like any other decide result, so it is visible, never
   silent.

Consequences for authors:

- **Phrase decide questions with the numbers inline.** A decide
  question that carries no parseable signal returns the first option
  at 0.5 — that is a guess, and the confidence says so. The
  JudgeFixLoop and briefing workflows always embed `mean score X
  threshold Y` (or `misses: N … >= M`) in the question for exactly
  this reason.
- **A full agent is a `job`, not a `decide`.** Anything needing
  judgment — reading findings, weighing trade-offs — is a job trap.
  (The improve-loop's fix-or-stop step is a `job`, not a `decide`,
  for exactly this reason; see §7.)
- **One decide result type per workflow.** The extractor keys decide
  sites by the bare trap type, so one key carries one contract:
  three decide calls with three different result types are a loud
  extraction conflict, not three contracts. The library pattern is a
  single shared type — `LoopDecision { choice: string; confidence:
  number }` in `workflows/library/judge-fix-loop.ts` — with the different
  meanings carried in the question/options, not the type. The
  canonical Decision shape is `Decision` in the `agentts` module
  (BRA-47, landed 2026-11-16); the cascade's decide tier uses
  `DecideTierResult` (same `{ choice, confidence }` shape). Other
  decide calls still name their own single result type.
- **Which adapter answers decide matters.** The direct and muse
  adapters call `decideLocal` directly. The CLI mock path wires
  `decideLocal` in by default (`src/cli.ts`, BRA-54 fix). The bare
  `MockAdapter` switch itself returns a canned `{ choice: "a",
  confidence: 0.9 }` — that is deliberate (the swap test requires
  the host mock adapter to match the mock plugin byte-identically),
  so never rely on a bare mock adapter's decide answer. See "Known
  disagreements".

## 3. Combinators: `all` / `any` / `race`, fail-fast, cancellation

The combinators are core builtins, re-exported from the `agentts`
module. They take thunks (`() => T`); a trap called inside a branch
thunk suspends the branch exactly as a direct trap call would.

- **`all(thunks, failFast?)`** — collect-all by default: every
  branch runs, and the result is an `Outcome<T>[]` — `{ ok: true,
  value }` or `{ ok: false, error }` per branch. A failed branch is
  an outcome, not a failure of the whole `all`. With `failFast:
  true`, the first branch error is thrown at the call site and the
  result is bare values (`T[]`).
- **`any(thunks)`** — first success wins; if every branch fails it
  throws a real `AggregateError`.
- **`race(thunks)`** — first settler wins; losers are cancelled.
- **Empty-list behavior matches `Promise`:** `all([])` returns `[]`,
  `any([])` throws, `race([])` never settles.
- **Cancellation** — cancel a pending trap, a whole combinator, or
  the run (sticky: further trap/combinator calls throw at once);
  nested propagation runs down the tree, deepest-first. A cancelled
  run resumes by throwing a real `CancellationError` at the call
  site. Cancel-vs-complete is decided by journal order.

The library's fan-out idiom is `all` collect-all, then unwrap
outcomes in workflow code and count failures explicitly:

```ts
const outcomes: Outcome<Scorecard>[] = all([
  () => job<JudgeInput, Scorecard>({ spec: "judge", input: { item, rubric, judge: 0 } }),
  () => job<JudgeInput, Scorecard>({ spec: "judge", input: { item, rubric, judge: 1 } }),
]);
const scorecards: Scorecard[] = [];
let failed = 0;
for (const o of outcomes) {
  if (o.ok) scorecards.push(o.value);
  else failed++;
}
```

Pass `failed` on to the aggregate step — the aggregator needs to
know a judge is missing, not just see fewer verdicts.

## 4. The first-run gate: type-check + extraction + checker

Before a workflow may start — on first run, or when its source hash
changes — the host runs the gate (`src/gate.ts`, `src/extract.ts`,
`src/checker.ts`):

1. **TypeScript type-check** (exact pin 5.9.3; the host refuses to
   start when the compiler is unavailable or the wrong version).
   The engine itself raises no type errors (dquickts erases types as
   it parses; Bun strips types without checking), so this gate is
   what closes that hole.
2. **Type extraction** — JSON Schema per trap call site, produced
   from your types. `job` and `decide` call sites must supply both
   type arguments (`job<Input, Output>`, `decide<Output>`) as
   concrete, named types: the output type cannot be inferred, so
   omitting it leaves `Output = unknown` and the host has no output
   contract to extract. A call with no type arguments, or with an
   unresolved generic type parameter, fails loudly at first run
   rather than silently skipping validation. `exec` / `gate` /
   `sleep` / `cron` carry no type arguments: their result type is
   fixed by the trap type. The extractor walks transitive relative
   imports, so library workflows extract.
3. **The M2 checker** (BRA-29: class/empty contracts, schema-level
   wiring, layering import lint) — runs after extraction, before the
   cache write.

**What a gate failure means.** The workflow never starts, nothing
runs, nothing is enqueued. The failure is a structured return value,
not a bare stop: `GateError` carries per-error records (file, line,
column, code, message, expected vs. actual where the compiler
states it) so an authoring agent can fix and resubmit — the
write/check/fix loop's machine interface. Both failure stages were
verified live 2026-11-16 (see §9):

```sh
# Type-check failure: job with no type args, result used as BadResult
$ bun src/cli.ts check workflows/bra69-bad-gate.ts --state-dir /tmp/bra69-70-skills/state
# workflows/bra69-bad-gate.ts:10:3: error TS2322: Type 'unknown' is not assignable to type 'BadResult'.
#   expected: BadResult; actual: unknown
# exit 1

# Extraction failure: type-check passes, but job has 0 type arguments
$ bun src/cli.ts check workflows/bra69-bad-gate2.ts --state-dir /tmp/bra69-70-skills/state
# workflows/bra69-bad-gate2.ts:1:1: error EXTRACTION: ... job(...) has 0 type argument(s)
# — it must carry exactly two, <Input, Output>, both concrete, named types
# exit 1
```

`agentts check <workflow>` runs the gate without running anything;
`--json` emits structured diagnostics. `agentts check --layering
[dirs...]` lints the layering boundary over a source tree (core +
host never import Muse-specific things). The gate runs once per
workflow version: the cache entry records the gate result alongside
the extracted schemas, keyed by the workflow content hash (plus
compiler + checker version), so a second run of the same version
reuses the cached gate result + schemas without re-running the
checker.

**Do not confuse the first-run gate with a `gate` trap.** The
first-run gate is a static check before anything runs; a `gate`
trap is a human question mid-run. They share a word and nothing
else.

## 5. The mock adapter for testing

The mock adapter (`plugins/mock/src/mock-adapter.ts`, seam
`plugins/mock/src/adapter.ts`) is the test double. Scratch state dirs default to
`mock`; the production state dir defaults to `direct` — a forgotten
`--adapter` must never silently fake a production run. What it
answers:

- **job** — canned answers by table: specs `score`/`verify`/
  `aggregate` keyed by input value (e.g. `score:7` → `{ score: 0.92,
  label: "approved" }`), unknown specs → `{ score: 0.5, label:
  "default" }` (with a stderr warning). JudgeFixLoop specs
  (`judge`/`fix`/`aggregate`/`rubric-update`) and improve-loop
  specs (`improve-judge`/`improve-aggregate`/`improve-decide`/
  `improve-fix`/`improve-write`) get input-dependent mock logic
  that mirrors the real workers — the mock judges genuinely
  improve across iterations (base score per judge index + 0.15 per
  revision marker), so a mock JudgeFixLoop run converges for real
  reasons, not canned ones. `bugfix-*` specs run the bugfix worker
  in-process with `simulate: true`; simulated results always carry
  `simulated: true`.
- **exec** — `echo hi` → `{ stdout: "hi\n", exitCode: 0 }`; anything
  else → empty stdout, exit 0. **Exception: `cat <file>` reads the
  file for real** — rubric-file resolution (improve-loop) depends
  on it, and the mock cannot canned-answer a file it has never
  seen. A mock never writes files: the mock improve-write computes
  the same paths + bytes as the real worker without writing.
- **gate** — auto-yes (`{ answer: "yes" }`), or held with
  `--gates hold` (see §6 for the hold cycle).
- **decide** — via the local decision model on the CLI path
  (BRA-54 fix); the bare adapter returns canned `{ choice: "a",
  confidence: 0.9 }` (see §2.1).
- **sleep / cron** — never reach the adapter; the host owns the
  clock. The clock is virtual in tests (default `--clock virtual`;
  the virtual epoch observed in real runs is 2027-01-01) and real
  wall time in production. A sleep advances the virtual clock with
  ~0ms of wall time.

**Testing a new workflow:** run it under `--adapter mock` in a
scratch state dir first. Register workers for new specs without a
per-workflow plugin: `--workers-config workers.json` (`{ spec:
scriptPath }`, direct adapter; the muse worker loop reads the same
format) and `--mock-answers answers.json` (`{ spec: cannedValue }`,
mock adapter). Both fail loudly on a missing file or bad JSON.
An unregistered spec on the direct adapter is a loud error, never a
canned default. **BRA-111:** the workers-config is carried on the
Host and applied to every DirectAdapter it loads — its own adapter
and every fresh one loaded for a queued entry — so the worker
server's driver honors it too (`worker serve --workers-config` /
`AGENTTS_WORKERS_CONFIG`, read fresh on every drive; a missing or
malformed file fails the drive loudly with 500). Before BRA-111 the
server driver built a plain DirectAdapter per request and a run
submitted with `--adapter direct` + a workers-config lost its
workers at the queue drive.

**What mock testing does not prove.** A mock run proves the loop
logic, the trap wiring, and the gate. It does not prove the real
worker, real exec, or real timing. Run the same workflow under
`--adapter direct` before believing a result that depends on
worker behavior — the direct adapter spawns real worker processes
(`bun workflows/library/worker.ts '<json>'`, result JSON from the last
stdout line) with a 600s timeout, runs real `exec`, holds every
gate, and answers `decide` with the local decision model.

## 6. The CLI

`agentts` is `bun src/cli.ts` from `apps/agentts/`; there is no
installed binary. The header comment in `src/cli.ts` is
authoritative; `ARCHITECTURE.md` §11 maps the commands. State
defaults to `./.agentts-state` (or `$AGENTTS_STATE_DIR`); every
example below pins `--state-dir` to a scratch dir. Exit codes: 0
done, 2 held at a gate, 1 error / refusal.

```sh
# Submit (returns the run ID immediately) — input via --input-file,
# or inline JSON with --input (giving both is refused, exit 1)
bun src/cli.ts run workflows/library/hello.ts --run-id run-hello \
  --input-file /tmp/hello-input.json --state-dir /tmp/agentts-quickstart/state
# RUN run-hello
# bun src/cli.ts run workflows/library/hello.ts --run-id run-hello \
#   --input '{"name":"world"}' --state-dir /tmp/agentts-quickstart/state

# Submit + drive + fetch result in one command
bun src/cli.ts run workflows/library/hello.ts --run-id run-hello \
  --input-file /tmp/hello-input.json --wait --state-dir /tmp/agentts-quickstart/state
# { "greeting": "Hello, world!" }

# Fetch the result again later (persisted, not just printed)
bun src/cli.ts result run-hello --state-dir /tmp/agentts-quickstart/state
# { "greeting": "Hello, world!" }

# Status + last 8 journal events; queue inspection and driving
bun src/cli.ts status <runId> --state-dir <DIR>
bun src/cli.ts queue list --state-dir <DIR>
bun src/cli.ts queue run --state-dir <DIR>
bun src/cli.ts queue repair [--force] --state-dir <DIR>

# First-run gate without running anything
bun src/cli.ts check <workflow> [--json] --state-dir <DIR>
bun src/cli.ts check --layering [dirs...] [--json]

# Answer a held gate, then drive
bun src/cli.ts deliver-gate <runId> '{"answer":"yes"}' --state-dir <DIR>
bun src/cli.ts queue run --state-dir <DIR>

# Read-only journal timeline (never dispatches or mutates runs)
bun src/cli.ts profile <runId> [--format text|html] [--journal F] [--out F] --state-dir <DIR>

# Cost estimates per call site, from cost-actuals.jsonl
bun src/cli.ts cost-model --state-dir <DIR>
```

The full command list (see `ARCHITECTURE.md` §11 for the table):
`run`, `result`, `status`, `check`, `deliver-gate`, `queue list |
run | repair`, `admit`, `sync-task`, `cost-model`, `profile`,
`worker serve | status | cancel | get-job | complete-job`,
`deliver-result` / `deliveries`, `escalate`, `watchdog`, `version`.

**The gate-hold cycle, verified live** (scratch workflow with a
`sleep` then a `gate`, `--gates hold`; see §9):

```sh
$ bun src/cli.ts run workflows/bra69-gate-demo.ts --run-id run-gate-demo \
    --input-file /tmp/bra69-70-skills/inputs/gate.json --wait --gates hold \
    --state-dir /tmp/bra69-70-skills/state
GATE PENDING run-gate-demo — deliver an answer with:
  agentts deliver-gate run-gate-demo '{"answer":"yes"}' --state-dir /tmp/bra69-70-skills/state
# exit 2
$ bun src/cli.ts status run-gate-demo --state-dir /tmp/bra69-70-skills/state
# run: run-gate-demo / status: suspended / events: 13
#   ... "event":"gate-held","trapId":"run-gate-demo/trap-1","question":"Ship the briefing draft?"
$ bun src/cli.ts deliver-gate run-gate-demo '{"answer":"yes"}' --state-dir /tmp/bra69-70-skills/state
# gate answer delivered for run-gate-demo — drive it with:
#   agentts queue run --state-dir /tmp/bra69-70-skills/state
$ bun src/cli.ts queue run --state-dir /tmp/bra69-70-skills/state
# done run-gate-demo
$ bun src/cli.ts result run-gate-demo --state-dir /tmp/bra69-70-skills/state
# { "topic": "briefing", "answer": "yes" }
```

Notes from that run's journal/profile: the delivered gate answer is
recorded with adapter `"host"` (a human answered, not an adapter);
the re-dispatch after delivery is visible as a second
`trap-dispatch` event marked `redispatched: true`; the profile
reported the hold as 8.55s of wall time (result.wallTs −
gate-held.wallTs), not the trap's ~0ms dispatch wallMs.

**Other commands you will reach for.** `queue repair` re-classifies
stranded `"running"` entries from the journal + registry (a run
whose journal shows `completed` is marked done; a C-host crash
mid-slice with an intact blob is re-queued; a run with trap activity
but no registry entry is left for a human). Only a human, with
`--force`, breaks a driver lock — never the tick agent, never
automation. `deliver-result <runId>` records a terminal run's
delivery in the outbox; `deliveries` lists them; `escalate '<json>'`
writes an escalation record (`gate-held` | `stuck-running` |
`other`) for a human; `watchdog` checks tick-agent liveness (exit 0
healthy / nothing pending, 2 tick agent dead AND pending work, 1
error) and never drives the queue or flips state. `admit` is Layer-1
scheduling: which backlog tasks run, under a WIP limit (default 3) —
it never executes a run itself (see `ARCHITECTURE.md` §6).

## 7. The workflow library

The library lives in `apps/agentts/workflows/library/` (dogfood
consumers live alongside in `apps/agentts/workflows/dogfood/`). The canonical
inventory — name, file, purpose, input/output, when to use it,
versioning, state — is `apps/agentts/workflows/README.md`
(BRA-52); this section is the how-to for the same entries and
does not duplicate the inventory. Each entry below says what it
does, when to use it, and what its traps are. The pattern they
all share: **the library owns the loop logic and its trap
calls** — the concrete workflow calls the library function with
explicit type arguments, and the extractor specializes the
library's generic trap contracts per instantiation (BRA-106),
so a generic library workflow calls traps directly like any
concrete workflow.

### 7.1 `judge-fix-loop.ts` — JudgeFixLoop (generic loop)

**What it does.** Sends work item X + rubric R to 3 independent
judge agents in parallel (the `all` combinator, collect-all), reduces
the verdicts into an aggregate score, decides whether to change X (a
`decide` trap), loops; every 3 loops considers whether R itself needs
updating; if R improves, at least 2 more loops must pass before
convergence can be declared.

**When to use it.** Any item that improves by critique-and-revise
against a stable rubric: a draft, a fix, a plan. Use it when the
quality bar can be stated as a rubric with a numeric threshold and
the fix step can actually address the judges' findings.

**Shape.** `judgeFixLoop<X, R extends { threshold: number
}>(initial, rubric, maxLoops)` — the caller supplies only the
item, the rubric, and the loop cap, with explicit type arguments
(`judgeFixLoop<WorkItem, Rubric>(...)`). The loop calls
`job`/`decide` directly, with contracts parameterized by X and R
(`JudgeInput<X, R>`, `FixInput<X, R>`, `RubricUpdateInput<R>`,
`AggregateInput`, `LoopDecision`); the extractor specializes
those contracts per call site (BRA-106). The threshold the
loop's questions and aggregate input carry comes from the rubric
itself (`rub.threshold`). The item and rubric types must be
exported from the caller's file — the specialization alias
imports them by name — and an inferred call (no explicit type
arguments) fails extraction loudly. Convergence rule (settled):
a `decide` each loop asks whether the run has converged; the
answer only counts once at least 2 loops have passed since the
last rubric improvement (`loopsSinceRubricChange >= 2`).
Result: `{ item, rubric, loops, converged, lastAggregate }`.

**Verified live** (mock adapter, fixture
`tests/fixtures/judge-fix-loop-input.json`, see §9): 5 loops,
converged, mean 0.85, rubric gained a criterion (`"concrete
example"`) at the loop-3 update — the mock judges score 0.55/0.62/
0.48 first (mean 0.55), +0.15 per revision, so the run revises
twice, keeps at loop 3, updates the rubric at loop 3, and converges
at loop 5 (2 loops after the rubric change).

### 7.2 `improve-loop.ts` — improve-loop (standard-library workflow)

**What it does.** Takes a work item (almost anything: a document, a
presentation, a pull request) and a rubric (inline, or a `{ file }`
reference to a rubric JSON file, read with an `exec` `cat` trap and
parsed as JSON — a malformed file fails loudly rather than judging
against a rubric that is not there), and runs an improvement loop:
two parallel judges critique the item against the rubric and return
a scorecard each; a job aggregates, de-duplicates and filters the
two scorecards; a **job** decides if/what fixes are needed; if fixes
are needed they are applied before looping back. At most **three**
rounds; then the workflow completes with the improved item plus a
change report (rounds, converged, every change + why, outstanding
findings, final mean score).

**When to use it.** Improving a concrete artifact against a
per-run rubric, when you want a bounded loop (3 rounds max) and a
change report as the deliverable. Prefer it over raw JudgeFixLoop
when the item is a document-like artifact and the rubric varies per
run. Note the deliberate difference from JudgeFixLoop: the
fix-or-stop step is a `job` (`improve-decide`), not a `decide` —
because it needs judgment over findings, and the rubric threshold
is advisory (the decide job drives fix-or-stop from the findings,
not the threshold).

**v1 limits, stated plainly** (from the file header): the v0
judge/fix workers are deterministic keyword/coverage workers, not
LLM judgment — the fix appends addressing sentences rather than
rewriting prose. A criterion the fix cannot address by appending
(notably `"concise"`: appending makes text longer) stays outstanding
and the loop hits the 3-round cap honestly instead of pretending to
improve.

**Verified live** (mock adapter, fixture
`tests/fixtures/improve-loop/input-inline.json`, see §9): converged
after 2 rounds with 2 changes, final mean score 1, outstanding
empty; `improvedPath` / `reportPath` under
`.agentts-scratch/improve-loop-inline/` (the mock write computes
paths + bytes without writing files).

### 7.3 `daily-ai-briefing.ts` — the daily AI research briefing (BRA-55)

**What it does.** A real edition end to end through the real engine:
arXiv discovery (reads arxiv.org/list past-week pages — the API 429s
on the shared egress IP), parallel full-text reads (`all`), dedupe
against a copy of the seen list, computed prior-work relations, a
must-read selection by `decide` trap, rendered markdown + meta.json,
a JudgeFixLoop structural polish over the draft, and the weekly HTML
page via the existing builder — all into scratch.

**When to use it.** As the worked example of a full production-style
workflow: fan-out reads, computed ranking, a decide trap that
ratifies a score-ordered leader (the ranking is the real decision;
the v0 decision model cannot reason over paper IDs), and library
reuse (JudgeFixLoop as a structural check, not a semantic judge —
its fix step can only append revision markers).

**How to run it** (from the workflow header — not re-run for this
skill; the BRA-55 proof run is the evidence):

```sh
bun src/cli.ts run workflows/dogfood/daily-ai-briefing.ts --adapter briefing \
  --input-file <input.json> --state-dir <scratch-state-dir> --wait
```

The edition is dated and marked TEST in its scope note; every output
lands under `.agentts-scratch/briefing-test-2026-11-16` (relative to
the host cwd). Mock mode (fixture data, no files written) is the
briefing adapter's `AGENTTS_BRIEFING_MOCK=1`; the workflow's
`input.mock` only marks the edition TEST in its scope note. The
input shape is `BriefingInput` in the workflow file itself; a
sample input lives at `tests/fixtures/briefing-input.json`
(created by BRA-87). No gate:
no step here needs a human decision.

**Production path (BRA-111).** The live cutover runs the workflow
with `--adapter direct --workers-config
workflows/dogfood/briefing-workers.json` (the checked-in config
maps all five briefing specs to `briefing-worker.ts`; paths are
relative to `apps/agentts` — run the CLI and the server from
there), driven through the queue by the tick loop and delivered to
the outbox — the `--adapter briefing` plugin is the workaround the
workers-config replaces. The Nov 18 trial ran this path on a
scratch server; the live briefing stays on the 06:15 cron until
parity is shown and Brandon decides the switch. The mechanism is
proven by `tests/test-bra111.ts` (direct fails loudly without a
config, drives briefing jobs with one, bad configs fail loudly).

### 7.4 `workflow-bugfix-bra54.ts` — the bug-fix workflow (BRA-54)

**What it does.** Fixes a real bug end to end through the real
engine: reproduce → diagnose → fix → judge the fix (JudgeFixLoop)
→ test (full staged `run.sh`) → verify (CLI mock path converges).
Steps are `job` traps (specs `bugfix-*`) served by
`workflows/dogfood/bugfix-worker.ts` — a real worker process with fs + exec
access under the direct adapter, and the same code in-process with
`simulate: true` under the mock adapter (simulated results always
carry `simulated: true`).

**When to use it.** As the template for a fix-a-bug workflow, and as
the worked example of two design points: (1) the JFL judging step
is **advisory, not a gate** — under `--adapter mock` it loops 6
times unconverged (the mock adapter's canned decide is the very bug
being fixed), while under `--adapter direct` it converges at loop 1
via the local decision model; acceptance comes from the test and
verify job results, not from the JFL outcome. (2) Job traps, not
exec traps, for multi-step work — each step is multi-step work a
single exec cannot do, and job traps let the mock adapter simulate
deterministically for fast iteration. No runtime `gate` trap: the
fix is the issue's prescribed option, and human review is post-hoc
(the coordinator verifies and closes the issue after the run), not
in-loop. The first-run type-check gate still runs.

### 7.5 `presentations.ts` — presentations (standard-library workflow, BRA-109)

**What it does.** Takes a deck outline (title + slides) and a
presentation rubric (inline, a `{ file }` reference to a rubric
JSON file, or the default rubric — criteria `["one-idea",
"concise", "concrete", "complete"]`, threshold 0.8), builds the
deck (`slides-create` job trap), runs a JudgeFixLoop review/polish
step over the deck, and renders the final deck to files
(`slides-render` job trap: deck.json + deck.md, default
`.agentts-scratch/presentations-out/`). At most `maxLoops` loops
(default 3). The result carries the final deck, its id and paths,
and the loop outcome (loops, converged, final mean score).

**When to use it.** Turning an outline into a reviewed deck: the
outline states the content, the rubric states the quality bar,
the loop polishes the deck against it. Prefer it over raw
JudgeFixLoop when the item is a deck and the deliverable is the
deck files.

**v1 limits, stated plainly** (from the file header): the Slides
steps are job traps served by the deterministic workers — they do
NOT call the live Google Slides API. `slides-create` computes the
deck locally and returns a deterministic deck id; a live Slides
adapter plugs into the same two specs later. The v0 judge/fix
workers are deterministic keyword/coverage workers, not LLM
judgment — the fix edits the deck structurally (fills empty
slides, shortens long bullets, adds a concrete bullet, trims
over-full slides) rather than rewriting prose, and a criterion
the fix does not know (a custom rubric criterion outside
one-idea / concise / concrete / complete) stays outstanding and
the loop hits the cap honestly instead of pretending to improve.

**Verified live** (mock adapter, fixture
`tests/fixtures/presentations/input-converging.json`, see §9):
converged after 2 loops with 1 revision, final mean score 0.98;
slide 1 trimmed from 6 to 5 bullets keeping the number-bearing
evidence bullet, the long bullet shortened to 12 words +
ellipsis; `deckPath` / `markdownPath` under
`.agentts-scratch/presentations-converging/` (the mock render
computes paths + bytes without writing files). Under the direct
adapter the same fixture converges in 2 loops and the files are
actually written.

### 7.6 `plan-driven-work.ts` — plan-driven-work (the plan → review → execute → review template, BRA-117)

**What it does.** The reusable codification of Brandon's own
6-step loop (plan, review, execute, review, commit, push).
Takes a request + a phase outline + a plan rubric, drafts a
plan (`plan-draft` job trap), improves it through a
JudgeFixLoop (max 3 loops; default rubric criteria
`["covers-request", "sequenced", "jobspec", "acceptance",
"review-points", "gate-placement"]`, threshold 0.8), holds at
a `gate` trap for the human checkpoint (options approve /
revise / reject; revise = one more JudgeFixLoop pass then a
second gate, max 2 gate rounds), and only then executes the
approved plan — frozen, byte-identical to the approved one.
Execution groups phases into dependency waves (topological
sort over `dependsOn`): phases in a wave run in parallel via
`all([...])`, waves serially. Each executed phase is reviewed
by the phase-review child workflow (§7.7) via the `run` trap,
one child run per executed phase. Commit/push is a
caller-supplied `exec` command, run last. `executeThrough`
bounds the run: phases after it are recorded deferred, never
executed (staged execution — the BRA-110 proof runs the
plan's opening phases this way).

**When to use it.** Any multi-step job with a real human
checkpoint in the middle: the plan is the thing reviewed, the
gate is the decision point, execution follows the approved
plan and nothing else. Prefer it over a hand-rolled sequence
when the plan needs review before work starts and each phase
needs review after it runs. Trivial tasks still skip the
template — the loop costs a plan draft, a review loop, a gate,
and a review per phase.

**v1 limits, stated plainly** (from the file header): the v0
plan-draft sequences and validates a caller-supplied outline —
it does NOT author phases from prose; the caller states the
phases. The v0 plan-phase produces an execution record
(validate + content hash + summary of prior results); real
agent execution arrives with worker agents following the
plan-phase jobspec. Phases are job/exec traps only; a phase
that is itself a sub-workflow is not supported in v1. The
commit/push leg is a caller-supplied exec command, not a
built-in. The production deliver half rides on BRA-110 (the
template's first real consumer). A failed phase stops the run
loudly with the real message (BRA-121 fixed the join slice so
the failure throw journals a lifecycle "failed" event instead
of crashing it; the `sleep(0)` workaround is gone). JudgeFixLoop's
fix is append-only per BRA-44: a criterion the fix does not
know (a custom rubric criterion outside the default six)
stays outstanding and the loop hits the cap honestly instead
of pretending to improve.

**Verified live** (direct adapter, fixture
`tests/fixtures/plan-driven-work/bra110-plan-input.json`,
see §9): the run held at the gate, the plan loop converged in
2 loops at mean 0.98, after the "approve" answer the run
completed with 3 executed / 3 deferred, all 3 phase reviews
converged in 1 loop at 0.98, the commit wrote for real, and
the frozen-vs-executed check passed from the journal (the
approved plan reconstructed after completion equals the
result's plan; exactly 1 exec trap per command phase, exactly
1 plan-phase trap for the agent phase, 0 traps for any deferred
phase). Under the mock adapter the same plan arc holds (2
loops, 0.98), but the mock's phase reviews score 0.55 then
0.70 on the mock's base-score judges and hit the 2-loop cap
honestly — the direct run is the convergence proof.

### 7.7 `phase-review.ts` — phase-review (per-phase review child workflow, BRA-117)

**What it does.** One phase's review, as a child workflow
invoked by the template via the `run` trap (form B). Takes the
phase's evidence text and its acceptance criterion, runs a
JudgeFixLoop over them (one criterion: the acceptance itself,
threshold 0.8, max 2 loops), and returns the loop outcome
(loops, converged, final mean score). It is a separate library
entry because the child carries its own extraction — two
JudgeFixLoop instantiations with different item types in one
workflow would collide on the `job:judge` contract
(one-key-one-contract).

**When to use it.** Only as the template's per-phase review
step. For anything other than a phase's evidence-vs-acceptance
check, use JudgeFixLoop (§7.1) directly.

### 7.8 `rubric-review.ts` — rubric-review (the rubric-rubric workflow)

**What it does.** Judges a rubric against the meta-rubric
(`workflows/rubrics/meta-rubric.md` — 14 criteria with 0/5/10
anchors, organized under four perspective headings) and improves
it through a JudgeFixLoop. Takes the rubric under review (inline
text or a `{ file }` reference — the general inline-or-file
indirection for instruction handoffs), the scope the rubric claims
(in scope / explicitly out / boundaries — generality is judged
against it), the artifact kind, reference examples (REQUIRED: at
least one known-good and one known-mediocre — a rubric cannot be
judged in the abstract), the meta-rubric (default: the checked-in
file), the numeric threshold (default 0.8, separate from the
prose, never parsed out of it), and `maxLoops` (default 3). The
three judges receive rubric + scope + kind + references + the
meta-rubric and return scored criteria (0–10, interpolated, one
line of reason each) PLUS open-ended feedback: answers to the
five guided questions (the missed dimension; the adversarial
probe — construct a bad artifact that would PASS this rubric;
where two careful judges would disagree; what is rewarded or
punished wrongly; free-form) plus free-form text. The fix
receives the rubric and all verdicts INCLUDING all open-ended
feedback. The output carries the revised rubric, the loop
outcome, and the final round's verdicts — the per-criterion
scores and the full open-ended feedback — so a human can read
them in the run result. The aggregate summarizes recurring
open-feedback themes alongside the mean score.

**When to use it.** Before trusting any rubric: run it through
`rubricReview` with a known-good and a known-mediocre reference
example. The first consumer is the morning report rubric
(trial edition = mediocre reference, recent cron edition = good
reference); the plan template's plan rubric gets the same
treatment when it next changes. The meta-rubric itself is
validated separately — self-test (it must pass its own
definition of good) plus a generalization suite (negative
control: the current five-word briefing rubric, which must
score low; positive control: a strong rubric; cross-kind:
code-review, plan, and briefing rubrics) — run by Meroki
operating this workflow, before the meta-rubric is trusted on
anything else.

**v1 limits, stated plainly** (from the file header): the v0
judge/fix workers are deterministic keyword/coverage workers,
not LLM judgement — the judge scores each meta-criterion 10
when the rubric names it and 0 when it does not, and the fix
appends one addressing sentence per missed criterion rather
than rewriting the rubric. A rubric that fails discrimination
needs its criteria rewritten, not its scores argued with; if
three loops do not converge, the rubric needs a human rethink,
not a fourth loop. The meta-rubric file is data, not process:
perspectives, graded questions with anchors, open-ended
questions — no steps, no sequencing in the prose.

**Verified live** (direct + mock adapters,
`tests/test-rubric-review.ts`, see §9): the negative control
(five-word briefing rubric) scores 0 in round 1 and converges
in loop 2 at 1.0; the meta-rubric itself scores 1.0 in round 1
and converges in 1 loop; a mid rubric naming 3 of 14 criteria
scores a 0.22 round-1 aggregate, then converges in loop 2.
Inline vs file resolution agree; missing/empty rubrics fail
loudly; reference-examples enforcement fails loudly; the
rubric-update job returns a text rubric unchanged.

## 8. The run / journal / result model

**Where state lives.** Default state dir is `./.agentts-state` in
the working directory (or `$AGENTTS_STATE_DIR`); the production
state dir is `~/workspace/agentts-state` — never point scratch work
at it. Layout (see `ARCHITECTURE.md` §9):

| Path | Contents |
| --- | --- |
| `journals/<run>.journal` | JSONL, the source of truth, append-only |
| `blobs/<run>.snap` | Snapshot from the last successful suspension, sha256-verified |
| `slices/<run>.{snap,out,log}` | Transient live snapshot, captured stdout, C-host stderr log |
| `runs/<run>.json` | Persisted registry entry (snapshot path, exit code, workflow path, frozen copy, engine version) |
| `runs/<run>.driver.ts`, `runs/<run>.bundle.js(.map)` | Generated driver + pinned bundle and source map |
| `frozen/<hash>/` | Frozen workflow closures, content-addressed |
| `cache/` | Extraction/schema cache keyed by content hash |
| `queue.json` (+ `queue.json.bak`) | The run queue |
| `cost-actuals.jsonl` | Host trap-actual log for the cost model |
| `worker-jobs/` | Pool job store, scheduler log, cost model, quotas |
| `deliveries/` | Delivery outbox records |
| `tick/` | Tick-agent liveness state (`state.json`) |
| `driver.lock/` | Driver lock (`holder.json` + heartbeat) |
| `corruption.log` | Append-only quarantined-corruption records |

**Frozen workflow copies + engine version (BRA-71).** At submit,
the host freezes the workflow's closure — entry file plus transitive
relative imports plus the agentts module — into
`stateDir/frozen/<closureHash>/`. A resumed run executes and
validates against the frozen copy, never the live file: editing (or
deleting) the workflow mid-run cannot change what the run executes.
Each run also records an engine version,
`dquickts-<pin12>+durablets-<hash16>` (provenance), and a snapshot
format identity, `snapfmt-<sig8hex>:<pin>:<native names>` — the
build signature from the snapshot blob's header, the dquickts pin,
and the ordered host native names — stamped after each suspension.
A resume under a different format identity is refused loudly
(`engine-version-mismatch` journal event; the blob stays on disk
so restoring the matching engine and re-queueing can still resume
it). A release that changed only durablets.c logic resumes parked
runs; a dquickts pin change, a native add, or a native rename
still refuses. Runs recorded before BRA-71 carry no version and
proceed unchecked; runs recorded before BRA-132 carry no format
identity and are gated on the blob-header signature plus the
recorded pin.

**How to read a journal.** One JSONL file per run,
`stateDir/journals/<run>.journal` (branch runs get
`<run>_fork-<n>_branch-<m>.journal`). Every event is JSON-clean.
Journal format v2 (BRA-57): every event carries `wallTs` (ISO wall
time); trap results carry `adapter`, `worker` (when the adapter
named one), and `wallMs` (host-measured dispatch wall time). Events:
`lifecycle` (`started | suspended | resumed | completed | failed`),
`trap` (with `trapId`, ordinal, type, full `arg`, call `site`),
`fork` / `join`, `branch-start` / `branch-done`, `cancel`,
`trap-result` / `trap-error`; host-side: `trap-dispatch` and
`trap-dispatched` (the dispatch split — what makes crash recovery
exact: a trap that already dispatched is re-answered from its
recorded result, never re-executed), `clock-advance`, `queue-started`,
`host-crash` / `host-crash-resumed`, `drive-cap`,
`engine-version-mismatch`, `sleep-deadline`, `quota-blocked`,
`gate-held`. The run-start `lifecycle`-`started` event carries
`workflowHash`, `workflowPath`, `submittedAt`, and the pinned
`bundlePath` / `bundleMapPath`.

The trap event's `arg` is journaled **in full** — that is where you
look when you need to see exactly what a trap was asked. `status`
prints the last 8 journal events; `profile` renders the whole tree
as a timeline with counters (per-trap-type counts, fork/join/branch
counts, gate holds, clock-advances, per-trap results matched by
trapId) — but the profiler shows a **summary** of each arg
(`spec=<name>` for jobs, the question truncated to 120 chars for
gate/decide), not the full arg. For the full arg, read the journal
file itself. The timeline axis is event order, not time; wall
durations are real where the journal carries them (a gate's hold is
result.wallTs − gate-held.wallTs; a trap's wallMs is its result
event's measured field). A 2h sleep advances the virtual clock 2h
with ~0ms of wall time and is shown on the virtual track only, never
as a 2h stall.

**How to get a result.** `agentts result <runId>` fetches the
validated output once the run is done. The output is read from the
result file and validated against the extracted output schema before
it is returned — a result that does not match the entry's declared
output is a failure, not a result. Statuses: `pending | running |
held | done | failed`. A done run's delivery is recorded with
`agentts deliver-result <runId>`; a failed run delivers its error
with `needsAttention: true` — that *is* the escalation for a
terminal failure. A non-terminal run is a loud error.

**Deliver proof (BRA-110).** `tests/test-bra110.ts` proves drive +
deliver end to end on the production path: the tick standin drives
a direct-adapter run with a real exec trap over HTTP and delivers
it; the outbox record's output is the run's validated result; two
concurrent deliveries plus a re-delivery leave exactly one record
file (the BRA-61 idempotency guard — the append-only
`deliveries.log` records one line per attempt, audit, not a
duplicate); a failed run delivers with `needsAttention: true`.
The proof runs on a scratch server — the live production outbox
still awaits its first real delivery.

**Drive integrity (what can stop a run).** Drive cap
(`MAX_DRIVE_ROUNDS = 50`): hitting it fails the run loudly with the
blob intact; the remedy is to split the workflow into fewer traps
per drive — a failed queue entry is never retried. Driver lock: one
driver per state dir; a second driver refuses loudly. Crash
recovery: a C-host crash mid-slice resumes from the last intact
blob; after a crash the host checks the journal before dispatching
a trap, so an already-dispatched trap is re-answered, never
re-executed. The one honest exception: a crash *during* an `exec`
dispatch re-runs the command — its output was lost — but the
journal shows two `trap-dispatch` events (the second marked
`redispatched: true`), so the duplicate is visible, not silent.

## 9. Verification log (this skill)

Every command or workflow example in this skill was either run live
for this skill (scratch state dir `/tmp/bra69-70-skills/state`,
2026-11-16) or cited to the BRA-64 quickstart verification where
the same command was already proven (README quickstart: `version`,
`check` on hello, `run --wait`, `result` — re-run here as
`run-hello-verify` with the same outputs). New examples run live:

| Example | Command | Result |
| --- | --- | --- |
| Gate failure, type-check | `check workflows/bra69-bad-gate.ts` | Exit 1, `TS2322: Type 'unknown' is not assignable to type 'BadResult'` (expected BadResult, actual unknown) |
| Gate failure, extraction | `check workflows/bra69-bad-gate2.ts` | Exit 1, `EXTRACTION: job(...) has 0 type argument(s)` |
| Gate failure, `--json` | `check workflows/bra69-bad-gate.ts --json` | Exit 1, structured diagnostics (file/line/column/code/message/expected/actual) |
| Gate hold cycle | `run workflows/bra69-gate-demo.ts --gates hold --wait` → `status` → `deliver-gate '{"answer":"yes"}'` → `queue run` → `result` | Exit 2 (GATE PENDING), status `suspended` with `gate-held` event, delivered, `done`, `{ "topic": "briefing", "answer": "yes" }`; profile: 18 events, 2 traps, hold 8.55s |
| `decide` signals | `run workflows/bra69-decide-demo.ts --adapter direct --wait` | Signal question → `{ choice: "keep", confidence: 0.65 }`; no-signal question → `{ choice: "blue", confidence: 0.5 }` |
| Reference by hash | `run workflows/bra69-ref-demo.ts --adapter direct --wait` | `{ verified: true, chars: 45, location: "/tmp/bra69-70-skills/doc.txt" }` (sha256 verified with `sha256sum` before the run) |
| JudgeFixLoop, mock | `run tests/workflows/workflow-judge-fix-loop.ts --adapter mock --wait` (fixture `judge-fix-loop-input.json`) | Converged, 5 loops, mean 0.85, rubric gained `"concrete example"`; profile: 287 events across 16 journals, 34 traps (23 job, 11 decide), 5 forks, 351ms wall |
| Improve-loop, mock | `run workflows/library/improve-loop.ts --adapter mock --wait` (fixture `improve-loop/input-inline.json`) | Converged after 2 rounds, 2 changes, final mean score 1, outstanding empty |
| Submit-only | `run workflows/library/hello.ts --run-id run-hello-verify` (no `--wait`) | `RUN run-hello-verify`, exit 0; `queue list` showed it `queued`, then `done` after `queue run`; `result` → `{ "greeting": "Hello, world!" }` |
| Jobspec hash | `worker serve --port 18799` + `GET /jobspec?spec=judge` | Returned hash `14ee7811…` identical to `sha256sum plugins/muse/jobspecs/judge.md`; unknown spec → `{"error":"no jobspec file for \"nonexistent-spec\""}` |

Scratch workflows used for verification (`workflows/bra69-*.ts`,
`workflows/library/hello.ts`) were deleted after the runs; the only files
this skill adds to the repo are the two skill files (plus the two
README link lines — see the report). The daily-ai-briefing run
command in §7.3 is quoted from that workflow's header and was not
re-run for this skill.

## Sources read for each section

- §1–2: `packages/durablets/src/agentts.ts` (canonical module),
  `packages/durablets/agentts.md`, `ARCHITECTURE.md` §2/§8.
- §2.1: `apps/agentts/src/decision-model.ts`,
  `apps/agentts/plugins/direct/src/direct-adapter.ts`,
  `apps/agentts/plugins/muse/src/muse-adapter.ts`,
  `apps/agentts/plugins/mock/src/mock-adapter.ts`, `src/cli.ts`
  (BRA-54 `setCanned` wiring), `workflows/dogfood/bugfix-worker.ts`
  (why the bare mock decide stays canned).
- §3: `packages/durablets/src/agentts.ts` (combinator re-exports),
  `ARCHITECTURE.md` §2, `workflows/library/judge-fix-loop.ts`,
  `workflows/library/improve-loop.ts` (unwrap idiom).
- §4: `apps/agentts/src/gate.ts`, `src/extract.ts`,
  `src/checker.ts`, `ARCHITECTURE.md` §8.
- §5: `apps/agentts/plugins/mock/src/mock-adapter.ts`,
  `apps/agentts/plugins/direct/src/direct-adapter.ts`,
  `apps/agentts/README.md` (BRA-56 fix).
- §6: `apps/agentts/src/cli.ts` (header comment, authoritative),
  `ARCHITECTURE.md` §11, `apps/agentts/src/host.ts`
  (`driveStepOnce`, `deliverGate`, `repairQueue`).
- §7: `apps/agentts/workflows/library/judge-fix-loop.ts`,
  `workflows/library/improve-loop.ts`, `workflows/dogfood/daily-ai-briefing.ts`,
  `workflows/dogfood/workflow-bugfix-bra54.ts`,
  `tests/workflows/workflow-judge-fix-loop.ts`,
  `tests/fixtures/judge-fix-loop-input.json`,
  `tests/fixtures/improve-loop/input-inline.json`.
- §8: `ARCHITECTURE.md` §3/§7/§9, `apps/agentts/src/profiler.ts`
  (`summarizeArg`/`summarizeResult`), `apps/agentts/src/host.ts`
  (journal events, frozen copy, drive cap, crash recovery).
- §10: `apps/agentts/run.sh` (header comment, authoritative),
  `~/workspace/tmp/tier-measure/timings.tsv` (Nov 19 section
  timings), `apps/agentts/bench/heartbeat.sh`.

## 10. Test tiers: `run.sh` (BRA-137)

A 30-minute suite on every change is a terrible design, so
`apps/agentts/run.sh` runs in tiers (BRA-137, Nov 19). The
script's header comment is authoritative; `./run.sh --list`
prints the current section inventory with tiers and measured
times. Run it from `apps/agentts/` (staged tree — host and mock
sources are copied to scratch and deps installed there) or from
the working dir `~/workspace/agentts-host` (runs in place).
Set `DQUICKTS=$HOME/workspace/dquickts-build-minimal` in both
cases. The script never writes into the tree it runs from.

| Tier | Invocation | When | Contents |
| --- | --- | --- | --- |
| 1 (default) | `./run.sh` | Every change | Fast unit tests + the most important integration test + a small e2e subset. Measured 228 s wall (221 s of sections + setup), Nov 19. |
| 2 | `./run.sh --tier 2` | Complex/risky changes | Tier 1 + broader integration + more e2e. Everything except the bench alarms. |
| 3 / full | `./run.sh --full` | Before a release or ~once a day, NOT on every change | Everything, including the bench regression alarms (BRA-93). |

**A tier-1 PASS is not a full PASS.** The final line names the
tier and what was skipped (`PASS tier 1 (quick) — … skipped N by
tier/selection`). Never report a tier-1 PASS as a full pass.

**The 10–15 minute budget (Brandon, Nov 19).** Most minor bug
fixes should land in main in 10–15 min from pickup: implement
(~5 min) + targeted test (~1 min) + tier 1 (228 s wall measured
Nov 19) + Meroki re-run (~1 min) + close + push (~2–3 min
mechanical). That totals ~12.8–13.8 min — it fits with ~1.5–2 min
of slack. The mock suite alone is 65 s uncontended and is the
cost: it is the integration anchor (284 checks across every trap
type plus the first-run gate pipeline), so it stays in tier 1 by
design, and the 3-minute tier-1 target is not reachable with it
included. (A contended run took 128 s for the mock suite alone —
the shared 1.5 CPUs punish parallel suite runs; do not run two
suites at once.)
What else breaks the budget: engine changes (tier 2 by design),
slow issue tests that wait real time (bra67's cron wait, bra83's
big sleep), and the GitHub approval card for the push
(human-gated — landing waits on the card, not on the harness).

**Targeted tests — what to run for what you changed** (before
tier 1, or with `--only`). Obvious from the change; no guessing:

| Changed | Run |
| --- | --- |
| Fix for issue BRA-NNN | `tests/test-braNNN.ts`, then tier 1 |
| `workflows/library/<x>.ts` | Its test (improve-loop / bra117 / bra126 / rubric-review), then tier 1 |
| `src/host.ts`, `cli.ts`, `src/adapter.ts` | Tier 1 + the issue test (tier 1's sampled integration is the coverage) |
| `src/checker.ts`, `extract.ts`, `src/gate.ts` | Tier 1 + `test-checker.ts` (the gate) |
| `workflows/README.md`, `workflows/library/` | `test-bra52.ts` (manifest, 84 s — slow and narrow, so targeted, not tier 1) |
| Worker/jobspec/decision-model/adapter/exec-script | `test-bra89.ts` (trap-code pin, 58 s — targeted, not tier 1) |
| `packages/durablets/src/durablets.c` | Tier 2 — an engine change is risky by definition, NOT a 10–15 min fix |
| `run.sh`, `bench/` | Tier 2 + one full pass |
| New workflow file | Its new test + tier 1 |

**Resume (BRA-137).** Long runs get SIGTERM-killed by runtime
VM replacement (~117-min cycle; a 30-min run has ~26% kill odds),
so a run must survive being killed. Each section writes a marker
on success (`$RESUME_DIR/.done/<slug>`, with its OK count) and
progress appends to `$RESUME_DIR/progress.jsonl`, so re-invoking
`./run.sh` skips completed sections automatically. The default
resume dir is `~/workspace/tmp/agentts-run-resume/<tree-fingerprint>/`.
`--resume-dir <dir>` reuses an explicit dir but **refuses to
resume if the tree changed** — resuming across a tree change
would mix results from two trees, and unexplained concurrent
modification (BRA-136) is live. `--only <section,…>` runs exactly
the named sections (forcing re-run) — for the unproven tail after
a kill, or one area. The C host build is cached under the resume
base keyed by `sha256(durablets.c)` + the dquickts pin, so a warm
run pays no build (~1.5 s cold). The bench section runs with
`--no-ratchet` on a resumed run (observations from a resumed pass
mix two process lifetimes and must not ratchet baselines); a fresh
full run records history so green runs count toward the ratchet.
Per-section logs live in `$RESUME_DIR/logs/<slug>.log`.

**Per-attempt logs + exit-code capture.** Never write two attempts
to the same path: `braXXX-<tier>-attemptN-YYYYMMDD-HHMM.log`. After
each `run.sh` invocation the driver records `$?` (143 = SIGTERM,
137 = SIGKILL — this settles the signal question) and the boot ID
(`stat -c %Y /proc/1`) into the resume dir's `progress.jsonl`.
A run killed by a signal records its kill before exiting (the
TERM/INT trap records it; the EXIT trap alone never runs when the
shell is killed by a signal).

**Heartbeat logger (diagnostic instrument).**
`apps/agentts/bench/heartbeat.sh` writes a 1-minute line
(timestamp + kernel boot_id + PID 1 start epoch + load) to
`~/workspace/agentts-runs/heartbeat.log`, so the next kill's last
heartbeat vs. the next boot time gives the replacement correlation
with zero ambiguity. It is NOT started durably — durable operation
needs a cron or a supervised process, and no such cron was
invented for this. Start it that way when the mechanism exists.

## Known disagreements (code wins)

- **`ARCHITECTURE.md` §4 says the mock adapter answers decide "via
  the local decision model."** That is true only on the CLI path
  (where `cli.ts` wires `decideLocal` via `setCanned`) and for the
  direct/muse adapters (which call `decideLocal` directly). The
  bare `MockAdapter`'s own switch returns canned `{ choice: "a",
  confidence: 0.9 }` — deliberate, because the swap test requires
  the host mock adapter to match the mock plugin byte-identically
  (`workflows/dogfood/bugfix-worker.ts` documents the reason). This skill
  follows the code and names the distinction.
- **The host README's CLI list is stale** (`ARCHITECTURE.md` §14):
  it omits `result`, `deliver-result`, `deliveries`, `escalate`,
  `watchdog`, `queue repair`, and `worker get-job` /
  `complete-job`. `src/cli.ts` is authoritative; §6 follows it.
- **The daily-ai-briefing header cites a sample input — RESOLVED
  (BRA-87, 2026-11-17).** The fixture now exists at
  `tests/fixtures/briefing-input.json`, so the header's pointer is
  true. (At skill-writing time no such file existed anywhere in the
  repo.)
- **The top-level README quickstart's `workflows/library/hello.ts` is a
  committed file** — it ships in the repo as the hello quickstart
  (a library entry, gate-checked). At skill-writing time it was not
  committed, so it was written fresh for verification and deleted
  afterwards; that is no longer the case.
