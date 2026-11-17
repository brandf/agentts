# Workflow library — canonical inventory

The library of reusable workflow code for AgentTS (Linear
[BRA-52](https://linear.app/brandf/issue/BRA-52/workflow-library):
"Workflow library"). This file is the canonical inventory: every
library entry, its file, its input/output contract, when to use it,
how it is versioned, and its current state. The usage skill
(`docs/skills/agentts-usage.md` §7) is the how-to for these entries;
it points here and does not duplicate this inventory.

**The one pattern they all share:** the library owns the loop
logic and its trap calls; the concrete workflow calls the
library function with explicit type arguments, and the extractor
specializes the library's generic trap contracts per
instantiation (BRA-106), so a generic library workflow calls
traps directly like any concrete workflow. A workflow is a
function with a trap-like signature — ONE JSON-capable input in,
ONE JSON-capable output out — and its default export IS the
workflow.

**What counts as a library entry.** A reusable control-flow
building block (a loop, a whole workflow) that a coordinator
composes from rather than writing from scratch. One-off test
workflows under `tests/workflows/` are not entries — except where
one is the runnable consumer that gates a library entry (noted
below). Support files (worker scripts, data, prep scripts) are
listed in §5 for completeness; they are not library entries, but
they are half of each entry's implementation, so the inventory
names them.

**Conformance.** `tests/test-bra52.ts` (wired into `run.sh`)
parses the tables in §1 and §4 and checks every row: the file
exists, the entry symbol is in it, every runnable entry passes
the first-run gate (`agentts check`), and every jobspec a workflow
uses is served by its worker. If you add, rename, or remove a
library entry, update the tables here or the suite goes red.
(Keep the table format exactly as it is — the parser reads
backticked file paths and the `Gate` column.)

## 1. The entries

| Name | File | Kind | Entry symbol | Gate |
|---|---|---|---|---|
| JudgeFixLoop | `judge-fix-loop.ts` | library | `judgeFixLoop` | via `tests/workflows/workflow-judge-fix-loop.ts` |
| improve-loop | `improve-loop.ts` | workflow | `improveLoop` | check |
| daily-ai-briefing | `daily-ai-briefing.ts` | workflow | `dailyAiBriefing` | check |
| workflow-bugfix-bra54 | `workflow-bugfix-bra54.ts` | workflow | `bugfixBra54` | check |
| decisionCascade | `../src/agentts.ts` | helper | `decisionCascade` | via `tests/workflows/workflow-bra47-cascade.ts` |
| hello | `hello.ts` | workflow | `hello` | check |

Kinds: `library` = a generic function a workflow imports and
calls (no default export, not runnable on its own); `workflow` =
a runnable workflow (default export, ONE input in / ONE output
out); `helper` = workflow-side code in the agentts module that
synthesizes trap sites (not a file under `workflows/`).

Gate: `check` means the entry itself passes `agentts check`
(first-run gate + extraction + M2 checker — verified
2026-11-16, TypeScript 5.9.3, checker bra29.3). `via <file>`
means the entry has no default export so the gate cannot run on
it directly; it is gated through the named consumer, whose
extraction walks the entry's transitive imports.

### 1.1 `judge-fix-loop.ts` — JudgeFixLoop (generic loop, BRA-44)

**What it does.** Sends work item `X` + rubric `R` to 3
independent judge agents in parallel (the `all` combinator,
collect-all: a failed judge is an outcome, not a loop failure),
reduces the verdicts into an aggregate score, decides whether
to change `X` (a `decide` trap), loops; every 3 loops considers
whether `R` itself needs updating; if `R` improves, at least 2
more loops must pass before convergence can be declared.

**Contract.**

- Input: `judgeFixLoop<X, R extends { threshold: number
  }>(initial: X, rubric: R, maxLoops: number)` — the caller
  supplies explicit type arguments (`judgeFixLoop<WorkItem,
  Rubric>(...)`); the loop calls `job`/`decide` directly with
  contracts parameterized by X and R: `JudgeInput<X, R> →
  JudgeVerdict` (spec `judge`, 3 in parallel), `AggregateInput →
  AggregateScore` (spec `aggregate`), `FixInput<X, R> → X`
  (spec `fix`), `RubricUpdateInput<R> → R` (spec
  `rubric-update`), and `LoopDecision` for all three `decide`
  calls. The threshold the loop's questions and aggregate input
  carry comes from the rubric itself (`rub.threshold`), which is
  why R is constrained to `{ threshold: number }`. The extractor
  specializes those contracts per call site (BRA-106): at each
  `judgeFixLoop<X, R>` call it reads the concrete type arguments
  and re-resolves the loop's inner trap sites under them. The
  item and rubric types must be exported from the caller's file —
  the specialization alias imports them by name. An inferred
  call (no explicit type arguments) or a never-called generic
  library fails extraction loudly.
- Output: `JudgeFixLoopResult<X, R>` — `{ item, rubric, loops,
  converged, lastAggregate }`.
- Shared shapes (defined here, imported by consumers):
  `JudgeVerdict { score, label, notes }`, `AggregateScore {
  approved, failed, meanScore, summary }`, `LoopDecision {
  choice, confidence }` — ONE decide-result type per workflow,
  by the extractor's one-key-one-contract rule.

**When to use it.** Any item that improves by critique-and-
revise against a stable rubric: a draft, a fix, a plan. Use it
when the quality bar can be stated as a rubric with a numeric
threshold and the fix step can actually address the judges'
findings. Prefer `improve-loop` (§1.2) when the item is a
document-like artifact, the rubric varies per run, and you want
a bounded loop with a change report as the deliverable.

**Convergence rule (settled).** A `decide` each loop asks
whether the run has converged; the answer only counts once at
least 2 loops have passed since the last rubric improvement
(`loopsSinceRubricChange >= 2`). A rubric update resets the
counter to 0.

**State.** In use — called by §1.3 and §1.4, and by the test
consumer `tests/workflows/workflow-judge-fix-loop.ts`.
Tested: the test consumer runs mock (5 loops, converged, mean
0.85, rubric gained `"concrete example"` at loop 3) and direct;
the host suite and the swap test exercise it. Not itself
runnable — it has no default export by design (the trap calls
live in the loop itself, specialized per call site — BRA-106).

### 1.2 `improve-loop.ts` — improve-loop (standard-library workflow)

**What it does.** Takes a work item (almost anything: a
document, a presentation, a pull request) and a rubric (inline,
or a `{ file }` reference to a rubric JSON file, read with an
`exec` `cat` trap and parsed as JSON — a malformed file fails
loudly rather than judging against a rubric that is not there),
and runs an improvement loop: two parallel judges critique the
item against the rubric and return a scorecard each; a job
aggregates, de-duplicates and filters the two scorecards; a
**job** decides if/what fixes are needed; if fixes are needed
they are applied before looping back. At most **three** rounds;
then the workflow completes with the improved item plus a change
report.

**Contract.**

- Input: `ImproveLoopInput { workItem: WorkItem, rubric:
  RubricInput, outDir?: string }` — `WorkItem { kind,
  description, content, ref? }`; `Rubric { criteria:
  RubricCriterion[], threshold }`; `RubricInput = Rubric |
  { file: string }`.
- Output: `ImproveLoopResult { item: WorkItem, report:
  ChangeReport, improvedPath, reportPath }` — `ChangeReport {
  rounds, converged, changes, outstanding, finalMeanScore,
  summary }`. The improved item and the report are also written
  as files (default `.agentts-scratch/improve-loop-out/`).
- Entry: `export default function improveLoop(input:
  ImproveLoopInput): ImproveLoopResult`. The loop logic lives in
  `improveLoopCore(input, steps)` (generic core, trap-calling
  steps injected as callbacks) so tests can drive it with fake
  steps without the engine. That callback seam is deliberate
  here — a test seam for the core — and is NOT the JudgeFixLoop
  shape: JudgeFixLoop used injected callbacks before BRA-106
  and now calls its traps directly.
- Trap contracts (concrete, named types at every call site):
  `improve-judge` (`JudgeInput → Scorecard`), `improve-
  aggregate` (`AggregateInput → AggregatedFeedback`), `improve-
  decide` (`DecideInput → FixDecision`), `improve-fix`
  (`FixInput → FixApplication`), `improve-write` (`WriteInput →
  WriteResult`).

**When to use it.** Improving a concrete artifact against a
per-run rubric, when you want a bounded loop (3 rounds max) and
a change report as the deliverable. Note the deliberate
difference from JudgeFixLoop: the fix-or-stop step is a `job`
(`improve-decide`), not a `decide` — because it needs judgment
over findings, and the rubric threshold is advisory (the decide
job drives fix-or-stop from the findings, not the threshold).

**v1 limits, stated plainly.** The v0 judge/fix workers are
deterministic keyword/coverage workers (see §4), not LLM
judgment — the fix appends addressing sentences rather than
rewriting prose. A criterion the fix cannot address by
appending (notably `"concise"`: appending makes text longer)
stays outstanding and the loop hits the 3-round cap honestly
instead of pretending to improve.

**State.** Tested, no live production consumer yet.
`tests/test-improve-loop.ts` runs it under the mock adapter
(converging fixture: 2 rounds, converged, 3 changes, final mean
score 1.0) and the direct adapter (real worker processes), plus
the core with fake steps; `improve-loop.INTEGRATION-TEST.md`
documents the real-engine end-to-end run. Gate: `CHECK OK`
(6 trap sites), verified 2026-11-16.

### 1.3 `daily-ai-briefing.ts` — the daily AI research briefing (BRA-55)

**What it does.** A real edition end to end through the real
engine: arXiv discovery (reads arxiv.org/list past-week pages —
the API 429s on the shared egress IP), parallel full-text reads
(`all`), dedupe against a copy of the seen list, computed
prior-work relations, a must-read selection by `decide` trap,
rendered markdown + meta.json, a JudgeFixLoop structural polish
over the draft, and the weekly HTML page via the existing
builder — all into scratch.

**Contract.**

- Input: `BriefingInput { editionDate, dateLabel, scratchDir,
  windowDays, readCount, selectCount, venvPython, mock }`.
- Output: `BriefingResult { editionDate, mustReadId,
  selectedIds, markdownPath, metaPath, htmlPath, indexPath,
  paperCount, polishLoops, polishConverged }`.
- Entry: `export default function dailyAiBriefing(input:
  BriefingInput): BriefingResult`.
- Trap contracts are local interfaces in the file
  (`DiscoveryInput/Result`, `ReadInput`/`PaperRead`,
  `RelateInput/Result`, `RenderInput/Result`, `WriteInput/
  Result`); the JudgeFixLoop polish reuses §1.1 with
  `WorkItem { text, goal }` / `Rubric { criteria: string[],
  threshold }` and the `judge` / `aggregate` / `fix` /
  `rubric-update` specs.

**When to use it.** As the worked example of a full
production-style workflow: fan-out reads, computed ranking, a
decide trap that ratifies a score-ordered leader (the ranking is
the real decision; the v0 decision model cannot reason over
paper IDs), and library reuse (JudgeFixLoop as a structural
check, not a semantic judge — its fix step can only append
revision markers). No `gate`: no step here needs a human
decision.

**State.** Proof run only, not the live briefing. The edition
it produces is dated 2026-11-16 and marked TEST in its scope
note; every output lands under
`.agentts-scratch/briefing-test-2026-11-16`. The live daily
briefing is still the 06:15 cron, not this workflow. Run:
`bun src/cli.ts run workflows/daily-ai-briefing.ts --adapter
briefing --input-file <input.json> --state-dir <scratch> --wait`
(mock mode is the briefing adapter's
`AGENTTS_BRIEFING_MOCK=1`; the workflow's `input.mock` only
marks the edition TEST). Note: the file header cites
`tests/fixtures/briefing-input.json` as a sample input — that
file does not exist in the repo; the input shape is
`BriefingInput` in the file itself. Gate: `CHECK OK` (11 trap
sites), verified 2026-11-16.

### 1.4 `workflow-bugfix-bra54.ts` — the bug-fix workflow (BRA-54)

**What it does.** Fixes a real bug end to end through the real
engine: reproduce → diagnose → fix → judge the fix
(JudgeFixLoop) → test (full staged `run.sh`) → verify (CLI mock
path converges). Steps are `job` traps (specs `bugfix-*`)
served by `workflows/bugfix-worker.ts` — a real worker process
with fs + exec access under the direct adapter, and the same
code in-process with `simulate: true` under the mock adapter
(simulated results always carry `simulated: true`).

**Contract.**

- Input: `BugfixInput { repoRoot, workflow, targetFile }`.
- Output: `BugfixResult { status, reproduced,
  reproduceSimulated, fixApplied, fixSimulated, jflLoops,
  jflConverged, jflMean, suitePassed, suiteSimulated,
  cliConverged, cliLoops, cliMean, verifySimulated }` —
  `status` is one of `fixed`, `failed-reproduce`,
  `failed-diagnose`, `failed-fix`, `failed-test`,
  `failed-verify`, `already-fixed`.
- Entry: `export default function bugfixBra54(input:
  BugfixInput): BugfixResult`.
- Trap contracts are local interfaces in the file
  (`ReproduceInput/Result`, `DiagnoseInput/Result`,
  `FixInput/Result`, `TestInput/Result`, `VerifyInput/Result`);
  the JudgeFixLoop step reuses §1.1 with `FixItem { text, goal
  }` / `FixRubric { criteria: string[], threshold }`.

**When to use it.** As the template for a fix-a-bug workflow,
and as the worked example of two design points: (1) the JFL
judging step is **advisory, not a gate** — when BRA-54 was live
it looped 6 times unconverged under `--adapter mock` (the mock
adapter's canned decide was the very bug being fixed) and
converged at loop 1 under `--adapter direct` via the local
decision model; today the reproduce step reports
`already-fixed` and the run ends before the loop (verified
2026-11-17: mock run, status `already-fixed`, `jflLoops: 0`).
Acceptance comes from the test and verify job results, not from
the JFL outcome. (2) Job traps, not exec traps, for multi-step
work — each step is multi-step work a single exec cannot do,
and job traps let the mock adapter simulate deterministically
for fast iteration. No runtime `gate` trap: the fix is the
issue's prescribed option, and human review is post-hoc (the
coordinator verifies and closes the issue after the run), not
in-loop. The first-run type-check gate still runs.

**State.** One-shot, completed — it fixed BRA-54 (the CLI mock
path now wires the local decision model in). Retained as the
bug-fix template, not as a recurring workflow. The target is the
staged repo; the workers build runnable scratch copies for the
CLI/suite runs, so no run output lands in the staged tree.
Gate: `CHECK OK` (10 trap sites), verified 2026-11-16.

### 1.5 `decisionCascade` — the decision helper (BRA-47)

**What it does.** Runs one decision spec — question, options,
optional context, optional exec command — through the tiers
cheap to expensive (exec → decide → job → gate), with the SAME
inputs at every tier, stopping at the first tier at or above its
threshold. It escalates on low confidence, abstention, or error,
and ultimately to a human. It is ordinary workflow-side code
built on the trap wrappers — NOT a core builtin or trap — so it
is testable with the mock plugin, and the plugin journals every
attempt, so the escalation path is visible audit evidence.

**Contract.**

- Input: `DecisionSpec { question, options, context?,
  exec?, threshold?, thresholds? }` (`src/agentts.ts`).
- Output: `Decision` — the deciding tier AND the full attempt
  history (one entry per tier evaluated, in order, up to and
  including the deciding tier; a tier with no exec command is
  recorded `"skipped"`).
- Entry: `decisionCascade(spec: DecisionSpec): Decision`,
  imported from `../src/agentts` (the agentts module, not a
  file under `workflows/`).
- Rules that matter: there is NO default threshold anywhere — a
  tier with no threshold in the spec fails loudly before any
  trap fires. The job tier always uses the `"decision"` jobspec
  (a string literal — the extractor requires a literal spec).
  The gate tier returns confidence 1.0 and accepts the human's
  answer verbatim even when it is not one of the options. A
  workflow that calls `decisionCascade` AND a direct
  `decide<Other>` (or a direct `job<"decision">` with different
  types) hits the one-key-one-contract extraction conflict —
  keep direct decide/job calls in a cascade workflow on the
  cascade's types (`DecideTierResult` / `DecisionJobInput` /
  `DecisionJobResult`).

**When to use it.** When a workflow step is a decision that
should be answered as cheaply as possible but escalated as far
as necessary — a computed answer first, a cheap model second,
an agent session third, a human last — with the whole
escalation path in the journal as audit evidence.

**State.** Tested (`tests/test-bra47.ts`: full attempt history,
per-tier thresholds, exec → decide → job → gate), but **no
library workflow uses it yet** — the only caller in the tree
is the test workflow `tests/workflows/workflow-bra47-cascade.ts`.
It is in the library because it is the decided way to make
decisions inside a workflow (BRA-47), not because a workflow
already calls it. Gate: via the test consumer (`CHECK OK`,
verified by the bra47 suite in `run.sh`).

## 2. Versioning and pinning

**There is no version number on any library file.** No semver,
no version field, no changelog per file. A library entry's
version today is its content hash, and a run pins the exact
source it was submitted with in two places:

1. **The frozen copy (BRA-71).** At submit, `Host.freezeWorkflow`
   (`apps/agentts/src/host.ts`) copies the workflow entry + its
   transitive relative imports + the agentts module it imports
   into `stateDir/frozen/<sha256>/`, preserving their relative
   layout. The queue entry records `frozenHash`, `frozenPath`,
   and `engineVersion` (`dquickts-<pin>+durablets-<hash>`). A
   resumed run executes and validates against the frozen copy,
   never the live file. The extraction cache is keyed by content
   hash (+ `depHash` over the relative imports), so a library
   edit invalidates the gate cache too.
2. **The engine version (BRA-71, G10).** A snapshot is
   same-engine-only: resuming under a different engine build is
   refused loudly (run marked failed, `engine-version-mismatch`
   journal event, blob left on disk).

**Verified for library workflows specifically (BRA-52
inventory work, 2026-11-16):** transitive imports ARE in the
frozen closure. `collectWorkflowFiles`
(`apps/agentts/src/extract.ts`) walks relative imports
recursively, skipping only the agentts module (added separately
via `resolveAgenttsModule`) and non-relative / `node_modules`
imports — so `daily-ai-briefing.ts` importing
`./judge-fix-loop` and `./briefing-prior-work`, and
`workflow-bugfix-bra54.ts` importing `./judge-fix-loop`,
freeze the whole chain. BRA-71 scenario A4 proves it
end-to-end: editing an imported lib file mid-run does not change
the resumed run's output; scenario B3 proves the frozen dir
holds entry + lib + agentts module byte-identical to the
submitted source. So: **editing a library workflow file
(`judge-fix-loop.ts`, `improve-loop.ts`, etc.) mid-run does not
change what an in-flight run executes or validates against.**

**The freeze is source-only — the gap.** The frozen closure
covers workflow source (control flow + types). It does NOT
cover the code that answers a run's job traps, which is
resolved from the live tree at trap time:

- The direct adapter resolves `workflows/worker.ts` and
  `workflows/bugfix-worker.ts` relative to its own file
  (`plugins/direct/src/direct-adapter.ts`); the briefing
  adapter resolves `workflows/briefing-worker.ts` the same way
  (`plugins/briefing/src/adapter.ts`); the mock adapter imports
  `runBugfix` from the live `workflows/bugfix-worker.ts`.
- Jobspec prose (`plugins/muse/jobspecs/*.md`) is fetched live
  per job by the worker pool (re-read when its sha changes) —
  no per-run pin exists.
- `briefing-prep.ts` runs via an exec trap against the live
  file; `decide` answers come from host TS source
  (`src/decision-model.ts`), which the engine version does not
  pin (it pins only the C host source + the dquickts pin).

So **editing a worker script or a jobspec mid-run CAN change
what an in-flight run's later job traps compute**, even though
the run records a frozen hash. Until that is fixed, the safe
rule is: do not edit a worker script or a jobspec while runs
using it are in flight. Tracked as Linear
[BRA-89](https://linear.app/brandf/issue/BRA-89/frozen-copy-does-not-cover-job-workers-or-jobspecs-a-library-update)
("Frozen copy does not cover job workers or jobspecs — a library
update can change in-flight runs").

**Legacy runs.** Runs submitted before BRA-71 carry no frozen
copy or engine version, so they resume from the live file with
no version check (grandfathered — there is nothing to compare
against).

## 3. Composition

**How a library workflow calls another one today: a plain
TypeScript import + function call, inside one run, under one
runId, in one journal.** That is the whole mechanism — there is
no sub-workflow trap, no child-run API, no way for a workflow to
submit or enqueue another workflow (the trap types are job /
exec / gate / sleep / cron / decide). Two entries do it today:

- `workflow-bugfix-bra54.ts` imports `judgeFixLoop` from
  `./judge-fix-loop` and calls it inline as step 4 (advisory,
  not a gate).
- `daily-ai-briefing.ts` imports `judgeFixLoop` the same way
  and calls it inline as step 7 (structural polish).

The called loop's trap calls extract through specialization:
the extractor reads the concrete type arguments at the call
site and re-resolves the loop's inner trap sites under them
(BRA-106). The improve-loop's header notes the related gap
honestly: there is no programmatic return-value channel for a
caller — the result is files + stdout + journal — which is the
Q12 follow-on, not the workflow file.

**What is NOT built.** Sub-workflows as child runs with their
own runIds (the Q12 decision recorded on BRA-52) do not exist
in code: no library workflow spawns a child run, and nothing in
the host supports it yet. So the BRA-52 line "a bug-fix workflow
can call the judge/improve loop as a sub-workflow" is true
today only in the in-process sense above, not in the child-run
sense. The child-run form is decided as the direction (BRA-52
Q2, 2026-11-17): form A (import, same process/journal) is the
MVP form; form B (run/call on top of trap, sub-workflow result
= trap result) is post-MVP, filed as
[BRA-105](https://linear.app/brandf/issue/BRA-105/sub-workflows-as-child-runs-agentts-runcall-on-top-of-trap-bra-52-q2).
It is not built yet.

**Composition rule (as it works today).** Compose by importing
the library function and calling it with explicit type
arguments; the composed loop runs inside your run, shares your
runId and journal, and its result is an ordinary return value
in your workflow function. If you need isolation (own runId,
own journal, independent retry/suspension), that does not exist
yet — see BRA-52.

## 4. Jobspecs — the second library

Workflows are control flow; jobspecs are work descriptions.
The two libraries grow together: every `job` trap in a library
workflow names a spec, and the spec is either prose a pool
worker reads (`plugins/muse/jobspecs/<spec>.md`, served by the
worker server at GET /jobspec, sha-checked) or a worker-script
implementation with no prose file. The pairing, as it exists
today:

| Jobspec | Prose file | Used by | Served by |
|---|---|---|---|
| `judge` | `plugins/muse/jobspecs/judge.md` | JudgeFixLoop consumers (§1.1, §1.3, §1.4) | `workflows/worker.ts` (direct) + mock adapter |
| `fix` | `plugins/muse/jobspecs/fix.md` | JudgeFixLoop consumers | `workflows/worker.ts` (direct) + mock adapter |
| `aggregate` | `plugins/muse/jobspecs/aggregate.md` | JudgeFixLoop consumers | `workflows/worker.ts` (direct) + mock adapter |
| `rubric-update` | `plugins/muse/jobspecs/rubric-update.md` | JudgeFixLoop consumers | `workflows/worker.ts` (direct) + mock adapter |
| `decision` | `plugins/muse/jobspecs/decision.md` | decisionCascade job tier (§1.5) | muse worker pool |
| `improve-judge` | `plugins/muse/jobspecs/improve-judge.md` | improve-loop (§1.2) | `workflows/worker.ts` (direct) + mock adapter |
| `improve-aggregate` | `plugins/muse/jobspecs/improve-aggregate.md` | improve-loop (§1.2) | `workflows/worker.ts` (direct) + mock adapter |
| `improve-decide` | `plugins/muse/jobspecs/improve-decide.md` | improve-loop (§1.2) | `workflows/worker.ts` (direct) + mock adapter |
| `improve-fix` | `plugins/muse/jobspecs/improve-fix.md` | improve-loop (§1.2) | `workflows/worker.ts` (direct) + mock adapter |
| `improve-write` | `plugins/muse/jobspecs/improve-write.md` | improve-loop (§1.2) | `workflows/worker.ts` (direct) + mock adapter |
| `bugfix-reproduce` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `bugfix-diagnose` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `bugfix-fix` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `bugfix-test` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `bugfix-verify` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `briefing-discover` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |
| `briefing-read` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |
| `briefing-relate` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |
| `briefing-render` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |
| `briefing-write` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |

Notes on the pairing:

- **The v0 workers are deterministic keyword/coverage
  workers, not LLM judgment** (`workflows/worker.ts` header).
  The jobspec prose describes the real rules; the worker is a
  mechanical implementation of them. The mock adapter mirrors
  the same logic (input-dependent mock judges), so mock runs
  show a real improving arc.
- **`bugfix-*` and `briefing-*` have no prose jobspec.**
  Their work is described only in the worker code (and the
  workflow file's header). Under the muse worker pool, a job
  whose spec has no `.md` file gets a warning and proceeds
  "from spec name" only (`plugins/muse/worker-loop.ts`) — so
  those two workflows effectively cannot run their jobs through
  the pool today; they run through the direct / briefing
  adapters instead. Whether every library workflow's specs
  should get a prose jobspec is an open question on BRA-52.
- **One spec, two shapes.** The `aggregate` spec serves two
  input shapes (JudgeVerdicts `{score}` → mean; Outcome
  objects `{ok}` → count) — the spec tells them apart by input
  shape, and so does the worker. New specs should not copy
  this; it is a documented wart, not a pattern.
- **`_template.md`** (`plugins/muse/jobspecs/_template.md`)
  is the template for a new prose jobspec, including the
  idempotency declaration line (BRA-61). `decision.md` is the
  only spec in this table that carries the explicit
  `idempotent` marker; the JFL / improve specs predate the
  convention — worth a cleanup pass, not a redesign.

## 5. Support files (not library entries)

These live in `workflows/` but are not reusable control flow;
they are the other half of the entries above. Listed so the
inventory is complete and so nobody mistakes them for entries.

| File | What it is | Used by |
|---|---|---|
| `worker.ts` | Direct adapter's worker process: genuine computation for the `judge` / `fix` / `aggregate` / `rubric-update` specs and the five `improve-*` specs. One process per job trap; result JSON on the last stdout line. | §1.1 consumers, §1.2 (via direct adapter) |
| `bugfix-worker.ts` | Worker process for the five `bugfix-*` specs (reproduce / diagnose / fix / test / verify), real under direct, `simulate: true` under mock (imported by the mock adapter). | §1.4 |
| `briefing-worker.ts` | Worker process for the five `briefing-*` specs (live arXiv fetches, real scoring/extraction). | §1.3 (via briefing adapter) |
| `briefing-prep.ts` | Scratch setup run via an exec trap: copies the live seen list + HTML builder into the run's scratch dir (read-only; the live files are never written). | §1.3 |
| `briefing-prior-work.ts` | Data: the prior-work index (`PRIOR_WORK`) the briefing workflow passes to its relate jobs. Imported by §1.3, so it IS in the frozen closure. | §1.3 |
| `improve-loop.INTEGRATION-TEST.md` | Manual runbook for the real-engine improve-loop run (not a workflow). | §1.2 |

## 6. Admittance — how a task maps to a library workflow

Admittance (`apps/agentts/src/admittance.ts`, BRA-49) is the
layer-1 scheduler: which backlog tasks run, under a WIP limit
(default 3). The mapping from a task to a library workflow is
**caller-supplied, not a built-in registry**:

1. Explicit map wins: `--map` JSON `{ taskId: workflowPath }`.
2. Then `--workflow PATH`: one workflow for every admitted task.
3. Then a `workflow:<name>` label on the task: a bare name
   resolves under the workflows dir (`workflows/<name>.ts`); a
   path is used as-is.
4. Otherwise the task is skipped with reason
   `needs-workflow` — it needs AgentTS code written for it
   first.

So "admittance maps a task to a library workflow or writes a
new one" is a mechanism with three caller-supplied mapping
routes, not a table of task kinds → library workflows. There is
no built-in rule that says "a bug task maps to the bug-fix
workflow" — a coordinator (or the CLI caller) supplies that.
Whether the library should grow such a registry (task kind →
workflow, with a default per kind) is an open direction
question on BRA-52.

## 7. Open direction questions

Recorded on Linear
[BRA-52](https://linear.app/brandf/issue/BRA-52/workflow-library)
as a comment (2026-11-16), not decided here unless noted:

- **Q1 — which workflows belong in the library next: DECIDED
  2026-11-17.** Presentations next after the MVP push, on
  Google Slides + JudgeFixLoop. No implementation issue filed
  yet.
- **Q2 — whether sub-workflows should become child runs:
  DECIDED 2026-11-17.** Form A (import, same process/journal)
  is the MVP form and works today; form B (run/call on top of
  trap, child runs with own runIds) is post-MVP, filed as
  [BRA-105](https://linear.app/brandf/issue/BRA-105/sub-workflows-as-child-runs-agentts-runcall-on-top-of-trap-bra-52-q2).
- **Q3 — whether every library workflow's specs need prose
  jobspecs so the muse pool can run them: OPEN.** Meroki's
  recommendation (2026-11-17): yes, post-push, folded into the
  deliver-half proof — not yet decided by Brandon.
- **Q4 — whether the library needs explicit version numbers on
  top of content-hash pinning: OPEN.** Meroki's recommendation
  (2026-11-17): no version numbers — not yet decided.
- **Q5 — whether admittance should grow a built-in task-kind →
  workflow registry: OPEN.** Meroki's recommendation
  (2026-11-17): no registry yet — not yet decided.

The freeze gap tracked as
[BRA-89](https://linear.app/brandf/issue/BRA-89/frozen-copy-does-not-cover-job-workers-or-jobspecs-a-library-update)
is CLOSED (2026-11-17): the frozen copy now hash-pins job
workers and jobspecs and refuses loudly on mismatch.
