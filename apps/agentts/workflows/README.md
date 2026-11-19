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

**Layout.** `workflows/` has two subdirs. `library/` is the
standard library: reusable, supported control flow (the generic
loop, the improve-loop, the hello quickstart, and the worker
process they run through). `dogfood/` is real consumers proving
the engine: the daily briefing and the one-off bug-fix workflow
plus their worker/helper scripts. Dogfood entries are listed in
§1 because the conformance check covers them too, not because
they are reusable — they are concrete one-off consumers, not
building blocks.

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
| JudgeFixLoop | `library/judge-fix-loop.ts` | library | `judgeFixLoop` | via `tests/workflows/workflow-judge-fix-loop.ts` |
| diagnosis | `library/diagnosis.ts` | library | `diagnosePhaseReview` | via `workflows/library/phase-review.ts` |
| improve-loop | `library/improve-loop.ts` | workflow | `improveLoop` | check |
| presentations | `library/presentations.ts` | workflow | `presentations` | check |
| plan-driven-work | `library/plan-driven-work.ts` | workflow | `planDrivenWork` | check |
| phase-review | `library/phase-review.ts` | workflow | `phaseReview` | check |
| rubric-review | `library/rubric-review.ts` | workflow | `rubricReview` | check |
| daily-ai-briefing | `dogfood/daily-ai-briefing.ts` | workflow | `dailyAiBriefing` | check |
| workflow-bugfix-bra54 | `dogfood/workflow-bugfix-bra54.ts` | workflow | `bugfixBra54` | check |
| decisionCascade | `../src/agentts.ts` | helper | `decisionCascade` | via `tests/workflows/workflow-bra47-cascade.ts` |
| hello | `library/hello.ts` | workflow | `hello` | check |

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

### 1.1 `library/judge-fix-loop.ts` — JudgeFixLoop (generic loop, BRA-44)

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
  `JudgeVerdict { score, label, notes, scores?,
  guidedAnswers?, openFeedback? }`, `AggregateScore {
  approved, failed, meanScore, summary, openFeedbackThemes?
  }`, `LoopDecision {
  choice, confidence }` — ONE decide-result type per workflow,
  by the extractor's one-key-one-contract rule. The optional
  verdict fields carry rubric-review's per-criterion scores
  and open-ended feedback (see §1.9); the result also carries
  `lastVerdicts: JudgeVerdict[]` — the final round's verdicts,
  so the full open-ended feedback escapes the loop into the
  run result.

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

**State.** In use — called by §1.3, §1.4, §1.6, and §1.9, and by the test
consumer `tests/workflows/workflow-judge-fix-loop.ts`.
Tested: the test consumer runs mock (5 loops, converged, mean
0.85, rubric gained `"concrete example"` at loop 3) and direct;
the host suite and the swap test exercise it. Not itself
runnable — it has no default export by design (the trap calls
live in the loop itself, specialized per call site — BRA-106).

### 1.2 `library/improve-loop.ts` — improve-loop (standard-library workflow)

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
the core with fake steps; `library/improve-loop.INTEGRATION-TEST.md`
documents the real-engine end-to-end run. Gate: `CHECK OK`
(6 trap sites), verified 2026-11-16.

### 1.3 `dogfood/daily-ai-briefing.ts` — the daily AI research briefing (BRA-55)

**What it does.** A real edition end to end through the real
engine: arXiv discovery (reads arxiv.org/list past-week pages —
the API 429s on the shared egress IP), parallel full-text reads
(`all`), dedupe against a copy of the seen list, computed
prior-work relations, a must-read selection by `decide` trap,
rendered markdown + meta.json, a JudgeFixLoop structural polish
over the draft, and the weekly HTML page via the existing
builder — all into scratch.

**Morning-report rubric (v0.2).** Step 0 reads
`workflows/rubrics/morning-report-rubric.md` (the reviewed rubric,
v0.2 — see §1.9) with `resolveTextBlob` and passes the text to the
read and render job inputs, so the rubric reaches the draft and read
steps before drafting (meta-rubric criterion 9). The v0
deterministic workers cannot act on prose yet, so in v0 this is
contractual — the text is in the inputs so a real drafter reads it.
Step 7 keeps the five-word structural rubric: the v0 judge checks
the first word of each criterion string and cannot read a text
rubric (question-derived criteria would false-negative and the fix
would append "(revised N)." to the published edition). Edits to the
rubric file take effect the next morning with no code change; a
missing or empty file fails the run loudly at step 0.

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
`bun src/cli.ts run workflows/dogfood/daily-ai-briefing.ts --adapter
briefing --input-file <input.json> --state-dir <scratch> --wait`
(mock mode is the briefing adapter's
`AGENTTS_BRIEFING_MOCK=1`; the workflow's `input.mock` only
marks the edition TEST). A sample input lives at
`tests/fixtures/briefing-input.json` (the 2026-11-16 TEST
edition's shape; `venvPython` is machine-specific — point it at
a venv with the `markdown` module). Gate: `CHECK OK` (11 trap
sites), verified 2026-11-16.

**Production path (BRA-111).** The cutover runs the workflow
with `--adapter direct --workers-config
workflows/dogfood/briefing-workers.json` (checked-in; all five
briefing specs map to `briefing-worker.ts`, paths relative to
`apps/agentts` — run the CLI and the server from there),
driven through the queue by the tick loop and delivered to the
outbox. The server driver honors the config (`worker serve
--workers-config` / `AGENTTS_WORKERS_CONFIG`, read fresh per
drive); before BRA-111 it built a plain DirectAdapter per
request and a briefing run lost its workers at the queue drive.
`tests/test-bra111.ts` proves the mechanism; the Nov 18 trial
ran the real day's inputs on a scratch server and is compared
against the cron's Nov 18 edition in `~/workspace/bra111-comparison.md`.
The live briefing stays on the cron until parity is shown and
Brandon decides the switch.

### 1.4 `dogfood/workflow-bugfix-bra54.ts` — the bug-fix workflow (BRA-54)

**What it does.** Fixes a real bug end to end through the real
engine: reproduce → diagnose → fix → judge the fix
(JudgeFixLoop) → test (full staged `run.sh`) → verify (CLI mock
path converges). Steps are `job` traps (specs `bugfix-*`)
served by `workflows/dogfood/bugfix-worker.ts` — a real worker process
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

### 1.6 `library/presentations.ts` — presentations (standard-library workflow, BRA-109)

**What it does.** Takes a deck outline (title + slides) and a
presentation rubric (inline, a `{ file }` reference to a rubric
JSON file, or the default rubric), builds the deck as a Google
Slides presentation, runs a JudgeFixLoop review/polish step over
the deck, and renders the final deck to files (deck.json +
deck.md). At most `maxLoops` loops (default 3).

**Contract.**

- Input: `PresentationInput { title, slides: SlideDraft[],
  rubric?: PresentationRubric | { file: string }, outDir?,
  maxLoops? }` — `SlideDraft { title, bullets, notes? }`; the
  rubric is `{ criteria: string[], threshold }` (the JudgeFixLoop
  shape, as in the daily briefing). Omitted rubric means the
  default: criteria `["one-idea", "concise", "concrete",
  "complete"]`, threshold 0.8.
- Output: `PresentationResult { deck, deckId, title, slides,
  deckPath, markdownPath, loops, converged, finalMeanScore }` —
  the final deck is in the result (the form-A return-value
  channel), and the deck files are also written (default
  `.agentts-scratch/presentations-out/`).
- Entry: `export default function presentations(input:
  PresentationInput): PresentationResult`.
- Trap contracts (concrete, named types at every call site):
  `slides-create` (`SlidesCreateInput → Deck`),
  `slides-render` (`SlidesRenderInput → SlidesRenderResult`),
  and the JudgeFixLoop step reuses §1.1 with `Deck` /
  `PresentationRubric` and the `judge` / `aggregate` / `fix` /
  `rubric-update` specs. The rubric-file read is an `exec` `cat`
  trap, as in improve-loop.

**When to use it.** Turning an outline into a reviewed deck:
the outline states the content, the rubric states the quality
bar, the loop polishes the deck against it. Prefer it over raw
JudgeFixLoop when the item is a deck and the deliverable is the
deck files.

**v1 limits, stated plainly.** The Slides steps are job traps
served by the deterministic workers — they do NOT call the live
Google Slides API. `slides-create` computes the deck locally
and returns a deterministic deck id (`deck-<sha256[0:12] of
title + slides>`); a live Slides adapter plugs into the same
two specs later. The v0 judge/fix workers are deterministic
keyword/coverage workers, not LLM judgment — the fix edits the
deck structurally (fills empty slides, shortens long bullets,
adds a concrete bullet, trims over-full slides) rather than
rewriting prose, and a criterion the fix does not know (a custom
rubric criterion outside one-idea / concise / concrete /
complete) stays outstanding and the loop hits the cap honestly
instead of pretending to improve.

**State.** Tested. `tests/test-bra109.ts` runs it under the mock
adapter (converging fixture: 2 loops, converged, final mean
score 0.98; weak fixture missing all four criteria: fixed in 2
loops; stubborn fixture with an unfixable custom criterion: 3
loops, not converged; invalid outline and bad rubric file fail
loudly) and the direct adapter (real worker processes, files
actually written). Gate: `CHECK OK` (trap sites: slides-create,
slides-render, exec, plus the JudgeFixLoop sites specialized to
Deck / PresentationRubric).

### 1.7 `library/plan-driven-work.ts` — plan-driven-work (the plan → review → execute → review template, BRA-117)

**What it does.** The reusable codification of Brandon's own
6-step loop (plan, review, execute, review, commit, push).
Takes a request + a phase outline + a plan rubric, drafts a
plan (`plan-draft` job trap), improves it through a
JudgeFixLoop (max 3 loops, default rubric: covers-request,
sequenced, jobspec, acceptance, review-points, gate-placement;
threshold 0.8), holds at a `gate` trap for the human checkpoint
(options approve / revise / reject; revise = one more
JudgeFixLoop pass then a second gate, max 2 gate rounds), and
only then executes the approved plan — frozen, byte-identical
to the approved one (the frozen-vs-executed check is a
journal read: the plan reconstructed from the journal after
completion equals the result's plan, and no trap executed a
deferred phase). **The gate only holds when the driver passes
`--gates hold` on BOTH the submit (`run`) and the drive
(`queue run`)** — the two commands build separate Hosts, so a
flag passed to only one does nothing (BRA-119). The direct and
muse adapters always hold; under the mock adapter (the default
outside the production state dir) the gate auto-answers "yes"
otherwise, logging `GATE AUTO-ANSWERED` and marking the journal
events `auto: true` — and the plan executes unreviewed.
Execution groups phases into dependency waves
(Kahn's topological sort over `dependsOn`): phases in a wave
run in parallel via `all([...])`, waves serially. Each executed
phase is reviewed by the phase-review child workflow (§1.8)
via the `run` trap (form B), one child run per executed phase.
A review that fails to converge carries a root-cause
diagnosis (BRA-126: work / workflow / rubric, with a reason
and a fix routing per level) in its summary — the template
asks the question every time instead of depending on anyone
remembering to.
Commit/push is a caller-supplied `exec` command, run last.
`executeThrough` bounds the run: phases after it are recorded
deferred, never executed (staged execution).

**Contract.**

- Input: `PlanDrivenWorkInput { request, phases: PhaseOutline[],
  planRubric?, executeThrough?, commit? }` — `PhaseOutline {
  name, kind: "agent" | "command", description, acceptance,
  command?, dependsOn? }`; agent phases carry a jobspec +
  testable acceptance; command phases carry a shell command.
  The rubric is `{ criteria: string[], threshold }` (the
  JudgeFixLoop shape); omitted rubric means the default 6
  criteria, threshold 0.8.
- Output: `PlanDrivenWorkResult { done, plan, planLoops,
  planConverged, planFinalMeanScore, gateRounds, executed:
  PhaseRecord[], deferred: string[], phaseReviews:
  PhaseReviewResult[], committed }` — `PhaseRecord { phase,
  kind, evidence, contentHash, priorSummary }`.
- Entry: `export default function planDrivenWork(input:
  PlanDrivenWorkInput): PlanDrivenWorkResult`.
- Trap contracts: `plan-draft` (`PlanDraftInput → Plan`),
  `plan-phase` (`PhaseExecutionInput → PhaseRecord`), the
  JudgeFixLoop step reuses §1.1 with `Plan` / `PlanRubric`
  and the `judge` / `aggregate` / `fix` / `rubric-update`
  specs, `gate` (options approve / revise / reject),
  `run` (the phase-review child, §1.8), `exec` (command
  phases + the commit command).

**When to use it.** Any multi-step job with a real human
checkpoint in the middle: the plan is the thing reviewed, the
gate is the decision point, execution follows the approved
plan and nothing else. Prefer it over a hand-rolled sequence
when the plan needs review before work starts and each phase
needs review after it runs. Trivial tasks still skip the
template — the loop costs a plan draft, a review loop, a gate,
and a review per phase.

**v1 limits, stated plainly.** The v0 plan-draft sequences
and validates a caller-supplied outline — it does NOT author
phases from prose; the caller states the phases. The v0
plan-phase produces an execution record (validate + content
hash + summary of prior results); real agent execution arrives
with worker agents following the plan-phase jobspec — the
record is honest about what ran, not a claim of agent work.
Phases are job/exec traps only; a phase that is itself a
sub-workflow is not supported in v1. The commit/push leg is a
caller-supplied exec command, not a built-in. The production
deliver half rides on BRA-110 (the template's first real
consumer). A failed phase stops the run loudly with the real
message (BRA-121 fixed the join slice so the failure throw
journals a lifecycle "failed" event instead of crashing it;
the `sleep(0)` workaround is gone). JudgeFixLoop's fix is
append-only per BRA-44: a criterion the fix does not know
(a custom rubric criterion outside the default six) stays
outstanding and the loop hits the cap honestly instead of
pretending to improve.

**State.** Tested. `tests/test-bra117.ts` runs the BRA-110
plan (6 phases: survey-outbox, record-baseline,
summarize-baseline, submit-production-run,
drive-and-verify-delivery, record-delivery;
`executeThrough: "summarize-baseline"`) under the direct
adapter: the run held at the gate, the plan loop converged
in 2 loops at mean 0.98, after the "approve" answer the run
completed with 3 executed / 3 deferred, all 3 phase reviews
converged in 1 loop at 0.98, the commit wrote for real, and
the frozen-vs-executed check passed from the journal (the
approved plan reconstructed after completion equals the
result's plan; exactly 1 exec trap per command phase, exactly
1 plan-phase trap for the agent phase, 0 traps for any
deferred phase; the gate trap precedes the phase reviews
and the commit). The same test covers the mock adapter
(agent-only plan: same 2-loop / 0.98 plan arc; mock phase
reviews score 0.55 then 0.70 on the mock's base-score judges
and hit the 2-loop cap honestly — the mock's generic judges
are stand-ins, not the real worker's containment scoring,
so the direct run is the convergence proof), a stubborn
plan (3 unknown criteria: 3 loops, not converged, 1
rubric-update, plan revised once), 6 invalid inputs that
fail loudly, and a failing phase (`false` command: the run
fails with the phase named and the later wave unexecuted).
Gate: `CHECK OK` (trap sites: plan-draft, plan-phase, exec,
gate, run, sleep, plus the JudgeFixLoop sites specialized to
Plan / PlanRubric).

### 1.8 `library/phase-review.ts` — phase-review (per-phase review child workflow, BRA-117)

**What it does.** One phase's review, as a child workflow
invoked by the template via the `run` trap (form B) — the
child carries its own extraction, so it is a separate library
entry, not a second JudgeFixLoop instantiation inside the
template (two instantiations with different item types in one
workflow would collide on the `job:judge` contract —
one-key-one-contract). Takes the phase's evidence text and its
acceptance criterion, runs a JudgeFixLoop over them (one
criterion: the acceptance itself, threshold 0.8, max 2
loops), and returns the loop outcome. When the review fails
to converge it also diagnoses the root-cause level itself
(BRA-126): work / workflow / rubric, possibly several at
once, via the deterministic `diagnosePhaseReview`
(`library/diagnosis.ts`) — work is the default (a failing
review means the work did not satisfy the acceptance),
workflow fires when the evidence shares no content word with
the acceptance, rubric fires when the criterion as written
cannot be checked (empty, single-word, or stopword-first).
The diagnosis (levels + a reason and a fix routing per
level) rides in the result; a converged review gets no
diagnosis (null). The template carries it into
`PhaseReviewSummary` (§1.7).

**Contract.**

- Input: `PhaseReviewInput { phase, evidence, acceptance }`.
- Output: `PhaseReviewResult { phase, loops, converged,
  finalMeanScore, diagnosis: Diagnosis | null }` — the
  diagnosis (BRA-126) is null on a converged review, otherwise
  `{ levels: ("work" | "workflow" | "rubric")[], reasons:
  string[], fixRouting: string[] }` with the three arrays
  parallel, in the order work, workflow, rubric.
- Entry: `export default function phaseReview(input:
  PhaseReviewInput): PhaseReviewResult`.
- The shared shapes (PhaseEvidence, the rubric) are
  deliberately re-declared in the child, NOT imported from the
  template — importing would pull the template's trap sites
  into the child's extraction.

**When to use it.** Only as the template's per-phase review
step. It is not a general review workflow — for anything
other than a phase's evidence-vs-acceptance check, use
JudgeFixLoop (§1.1) directly.

**State.** Tested through `tests/test-bra117.ts` (3 child
runs in the direct BRA-110 proof, each converging in 1 loop
at 0.98; the mock mirror's reviews hit the cap honestly —
see §1.7) and `tests/test-bra126.ts` (direct: a work-only
failure, a work+workflow failure, a three-level failure
diagnosed as all three, and a converged review with no
diagnosis; mock: the template flow carries the diagnosis
into `PhaseReviewSummary`). Gate: `CHECK OK` (trap sites: the JudgeFixLoop
sites specialized to PhaseEvidence / PhaseReviewRubric).

### 1.9 `library/rubric-review.ts` — rubric-review (the rubric-rubric workflow)

**What it does.** Judges a rubric against the meta-rubric
(`workflows/rubrics/meta-rubric.md` — 14 criteria with 0/5/10
anchors, organized under four perspective headings:
discrimination, clarity, usefulness, robustness) and improves
it through a JudgeFixLoop. The meta-rubric judges the rubric,
not the artifact: would this rubric, applied honestly,
separate good work from bad work, and would it tell the fixer
what to change?

**Contract.**

- Input: `RubricReviewInput { rubric: TextRubricInput,
  threshold?, scope: ScopeDefinition, artifactKind: string,
  referenceExamples: ReferenceExample[], metaRubric?:
  TextRubricInput, maxLoops? }` — `TextRubricInput = string |
  { file: string }` (a text rubric inline or as a file
  reference — the general inline-or-file indirection for
  instruction handoffs; resolved by `resolveTextRubric` in
  §1.1's library, file refs read with an `exec` `cat` trap, a
  missing or empty source failing loudly); `TextRubric {
  text, threshold }` (the threshold stays a separate numeric
  input alongside the text, never parsed out of the prose);
  `ScopeDefinition { inScope, outOfScope, boundaries }`;
  `ReferenceExample { label: "good" | "mediocre", text?,
  file? }` — at least one of each, REQUIRED, validated before
  any judging runs (a rubric cannot be judged in the
  abstract). Omitted `metaRubric` means the checked-in
  `workflows/rubrics/meta-rubric.md` (the path resolves against
  the process cwd — run the CLI from `apps/agentts`); omitted
  `threshold` means 0.8; omitted `maxLoops` means 3.
- Output: `RubricReviewResult { rubric: string, loops,
  converged, finalMeanScore, lastVerdicts: JudgeVerdict[] }`
  — the revised rubric text, the loop outcome, and the final
  round's verdicts: the per-criterion scores and the full
  open-ended feedback, recorded in the run result so a human
  can read them.
- Entry: `export default function rubricReview(input:
  RubricReviewInput): RubricReviewResult`.
- The JudgeFixLoop step reuses §1.1 with `RubricText { text,
  kind: "rubric", scope, artifactKind, references }` /
  `TextRubric` and the `judge` / `aggregate` / `fix` /
  `rubric-update` specs. The judges receive the rubric, the
  scope, the artifact kind, the reference examples, and the
  meta-rubric; each returns scored criteria (0–10,
  interpolated, one-line reason each) PLUS open-ended
  feedback: `scores` (per-criterion number + reason),
  `guidedAnswers` (one per guided question), `openFeedback`
  (free-form). The fix receives the rubric and all verdicts
  INCLUDING all open-ended feedback. The aggregate summarizes
  recurring open-feedback themes (`openFeedbackThemes`)
  alongside the mean score. The five guided open-ended
  questions (asked of every judge, every round): (1) what
  quality dimension does this rubric miss entirely; (2)
  construct a bad artifact that would PASS this rubric — the
  adversarial probe, the strongest discriminator; (3) where
  would two careful judges disagree, and what wording causes
  it; (4) what does this rubric reward that it should not, or
  punish that it should not; (5) free-form.

**When to use it.** Before trusting any rubric: run it
through `rubricReview` with a known-good and a known-mediocre
reference example. The first consumer is the morning report
rubric (trial edition = mediocre reference, recent cron
edition = good reference); the plan template's plan rubric
gets the same treatment when it next changes. The meta-rubric
itself is validated separately — self-test (it must pass its
own definition of good) plus a generalization suite (negative
control: the current five-word briefing rubric, which must
score low; positive control: a strong rubric; cross-kind:
code-review, plan, and briefing rubrics) — run by Meroki
operating this workflow, before the meta-rubric is trusted on
anything else.

**v1 limits, stated plainly.** The v0 judge/fix workers are
deterministic keyword/coverage workers, not LLM judgment —
the judge scores each meta-criterion 10 when the rubric names
it and 0 when it does not, and the fix appends one addressing
sentence per missed criterion rather than rewriting the
rubric. The fix never appends a guided answer verbatim (a Q2
answer quotes the criticism, and quoting it would score the
criterion as addressed for merely being mentioned). The
rubric-update job returns a text rubric unchanged — v0 never
rewrites versioned prose. A rubric that fails discrimination
needs its criteria rewritten, not its scores argued with; if
three loops do not converge, the rubric needs a human rethink,
not a fourth loop. The meta-rubric file is data, not process:
perspectives, graded questions with anchors, open-ended
questions — no steps, no sequencing in the prose.

**State.** Tested. `tests/test-rubric-review.ts` runs it under
the mock adapter (mirrored rubric workers) and the direct
adapter (real worker processes) with the same outcomes: the
negative control (five-word briefing rubric) scores 0 in
round 1 and converges in loop 2 at 1.0; the meta-rubric
itself scores 1.0 in round 1 and converges in 1 loop; a mid
rubric naming 3 of 14 criteria scores a 0.22 round-1
aggregate, then converges in loop 2; inline vs file
resolution agree; missing/empty rubrics and
reference-examples violations fail loudly; the rubric-update
job returns a text rubric unchanged. Gate: `CHECK OK`
(6 trap sites: the JudgeFixLoop sites specialized to
RubricText / TextRubric, plus the `exec` resolver site).

### 1.10 `library/diagnosis.ts` — diagnosis (phase-review root-cause diagnosis, BRA-126)

**What it does.** The deterministic root-cause diagnosis for
a failing phase review: given the review's recorded data (the
evidence, the acceptance criterion, the loop outcome), it
names the level(s) — work, workflow, rubric, possibly
several at once — each with a reason citing the observed
signal and a fix routing naming where the fix belongs.
Work is the default (a failing review means the work did not
satisfy the acceptance); workflow fires when the evidence
shares no content word with the acceptance; rubric fires
when the criterion as written cannot be checked (empty,
single-word, or stopword-first). It is a plain function, not
a job trap: the diagnosis classifies recorded data, and the
v0 workers could only apply the same rules. A converged
review gets no diagnosis (null). Used by phase-review (§1.8);
the template carries the diagnosis into `PhaseReviewSummary`
(§1.7).

**Contract.**

- Input: `{ evidence, acceptance, loops, converged,
  finalMeanScore, threshold }`.
- Output: `Diagnosis | null` — `{ levels: ("work" |
  "workflow" | "rubric")[], reasons: string[], fixRouting:
  string[] }` with the three arrays parallel, in the order
  work, workflow, rubric; null when the review converged.

**State.** Tested by `tests/test-bra126.ts` (direct:
work-only, work+workflow, three-level, and converged cases;
mock: the template flow). Gate: via §1.8 — `phase-review.ts`
passes `agentts check`, and its extraction walks this
module's transitive import.

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
imports — so `dogfood/daily-ai-briefing.ts` importing
`../library/judge-fix-loop` and `./briefing-prior-work`, and
`dogfood/workflow-bugfix-bra54.ts` importing `../library/judge-fix-loop`,
freeze the whole chain. BRA-71 scenario A4 proves it
end-to-end: editing an imported lib file mid-run does not change
the resumed run's output; scenario B3 proves the frozen dir
holds entry + lib + agentts module byte-identical to the
submitted source. So: **editing a library workflow file
(`library/judge-fix-loop.ts`, `library/improve-loop.ts`, etc.) mid-run does not
change what an in-flight run executes or validates against.**

**The freeze is source-only — the gap.** The frozen closure
covers workflow source (control flow + types). It does NOT
cover the code that answers a run's job traps, which is
resolved from the live tree at trap time:

- The direct adapter resolves `workflows/library/worker.ts` and
  `workflows/dogfood/bugfix-worker.ts` relative to its own file
  (`plugins/direct/src/direct-adapter.ts`); the briefing
  adapter resolves `workflows/dogfood/briefing-worker.ts` the same way
  (`plugins/briefing/src/adapter.ts`); the mock adapter imports
  `runBugfix` from the live `workflows/dogfood/bugfix-worker.ts`.
- Jobspec prose (`plugins/muse/jobspecs/*.md`) is fetched live
  per job by the worker pool (re-read when its sha changes) —
  no per-run pin exists.
- `workflows/dogfood/briefing-prep.ts` runs via an exec trap against the live
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
runId, in one journal.** That is the form-A mechanism — a plain
import, no child run. (Form B, the `run` trap for child runs with
their own runIds, is described below.) Three entries do it today:

- `dogfood/workflow-bugfix-bra54.ts` imports `judgeFixLoop` from
  `../library/judge-fix-loop` and calls it inline as step 4 (advisory,
  not a gate).
- `dogfood/daily-ai-briefing.ts` imports `judgeFixLoop` the same way
  and calls it inline as step 7 (structural polish).
- `library/presentations.ts` imports `judgeFixLoop` the same way
  and calls it inline as step 3 (review/polish over the deck).

The called loop's trap calls extract through specialization:
the extractor reads the concrete type arguments at the call
site and re-resolves the loop's inner trap sites under them
(BRA-106). The improve-loop's header notes the related gap
honestly: there is no programmatic return-value channel for a
caller — the result is files + stdout + journal — which is the
Q12 follow-on, not the workflow file.

**Form B — child runs (BRA-105).** Sub-workflows as child runs
with their own runIds DO exist now: `run<Input, Output>({
workflow, input })` in the agentts module calls a sub-workflow
by file path, and the sub-workflow's result IS the trap result.
The mechanics (settled in
[BRA-105](https://linear.app/brandf/issue/BRA-105/sub-workflows-as-child-runs-agentts-runcall-on-top-of-trap-bra-52-q2);
the issue's five mechanics were undecided, so the implementer
decided them — the full rationale lives in the comment block
above `resolveRunTrap` in `src/host.ts`):

- **Trap:** a new trap type, `"run"`. The parent suspends on it
  (ordinary rc-2 trap suspension) and rides the existing trap
  machinery: extractor site `run:<workflow-literal>`, dispatch
  validation against the extracted Output schema, deliver
  resume. The host owns it (like sleep/cron); the adapter never
  sees it. No C core change — `trap()` is generic over the type
  string.
- **Execution:** same process, same host instance, driven inline
  inside the parent's dispatch (the fork-branch pattern). Own
  runId `<trapId>/child`, deterministic from the trap execution,
  so a re-dispatch reuses it and never double-executes the child.
  Own journal, own frozen closure, own checkpoint chain — the
  child does NOT extend the parent's BRA-90 chain (different
  workflow, different heap). Parentage: the parent journal's
  `"run-child"` event (durable) + the child registry entry's
  `parentRunId`/`parentTrapId` (live). Cancellation propagates
  down via `cancelTree`, which walks the parent's run-child
  events deepest-first (BRA-40).
- **Freeze:** the child's closure is pinned like any run (own
  freeze at child start), AND the child file is part of the
  parent's frozen closure (`collectClosureFiles`), so the child
  source is pinned at parent submit — an edit after submit
  cannot change what executes. The child path resolves against
  the parent's FROZEN entry directory at dispatch. The extractor
  fails loudly at first run when the literal names a missing
  file.
- **Return value:** the child's result (validated against the
  child's entry Output schema) becomes the trap result, then
  validated again against the parent's run-site Output schema —
  two validations, both loud. A child failure throws at the call
  site with the child's error name and message preserved
  (catchable by the parent); a child held at a gate holds the
  parent at the run trap (HOLD) until a later drive resumes it.
- **Signature:** `run<Input, Output>({ workflow, input })`. The
  path MUST be a string literal (same rule as job's spec
  literal); relative paths resolve against the parent workflow's
  directory, absolute paths as-is. Both type args concrete,
  named.

**Composition rule (as it works today).** Compose by importing
the library function and calling it with explicit type
arguments; the composed loop runs inside your run, shares your
runId and journal, and its result is an ordinary return value
in your workflow function. If you need isolation (own runId,
own journal, independent retry/suspension), use `run/call`
(form B above): the child runs under its own runId with its
own journal, and its result arrives as the trap result.

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
| `judge` | `plugins/muse/jobspecs/judge.md` | JudgeFixLoop consumers (§1.1, §1.3, §1.4, §1.6, §1.9) | `workflows/library/worker.ts` (direct) + mock adapter |
| `fix` | `plugins/muse/jobspecs/fix.md` | JudgeFixLoop consumers | `workflows/library/worker.ts` (direct) + mock adapter |
| `aggregate` | `plugins/muse/jobspecs/aggregate.md` | JudgeFixLoop consumers | `workflows/library/worker.ts` (direct) + mock adapter |
| `rubric-update` | `plugins/muse/jobspecs/rubric-update.md` | JudgeFixLoop consumers | `workflows/library/worker.ts` (direct) + mock adapter |
| `decision` | `plugins/muse/jobspecs/decision.md` | decisionCascade job tier (§1.5) | muse worker pool |
| `improve-judge` | `plugins/muse/jobspecs/improve-judge.md` | improve-loop (§1.2) | `workflows/library/worker.ts` (direct) + mock adapter |
| `improve-aggregate` | `plugins/muse/jobspecs/improve-aggregate.md` | improve-loop (§1.2) | `workflows/library/worker.ts` (direct) + mock adapter |
| `improve-decide` | `plugins/muse/jobspecs/improve-decide.md` | improve-loop (§1.2) | `workflows/library/worker.ts` (direct) + mock adapter |
| `improve-fix` | `plugins/muse/jobspecs/improve-fix.md` | improve-loop (§1.2) | `workflows/library/worker.ts` (direct) + mock adapter |
| `improve-write` | `plugins/muse/jobspecs/improve-write.md` | improve-loop (§1.2) | `workflows/library/worker.ts` (direct) + mock adapter |
| `slides-create` | `plugins/muse/jobspecs/slides-create.md` | presentations (§1.6) | `workflows/library/worker.ts` (direct) + mock adapter |
| `slides-render` | `plugins/muse/jobspecs/slides-render.md` | presentations (§1.6) | `workflows/library/worker.ts` (direct) + mock adapter |
| `plan-draft` | `plugins/muse/jobspecs/plan-draft.md` | plan-driven-work (§1.7) | `workflows/library/worker.ts` (direct) + mock adapter |
| `plan-phase` | `plugins/muse/jobspecs/plan-phase.md` | plan-driven-work (§1.7) | `workflows/library/worker.ts` (direct) + mock adapter |
| `bugfix-reproduce` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/dogfood/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `bugfix-diagnose` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/dogfood/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `bugfix-fix` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/dogfood/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `bugfix-test` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/dogfood/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `bugfix-verify` | `(none — worker only)` | bug-fix workflow (§1.4) | `workflows/dogfood/bugfix-worker.ts` (direct) + mock adapter (`simulate: true`) |
| `briefing-discover` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/dogfood/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |
| `briefing-read` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/dogfood/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |
| `briefing-relate` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/dogfood/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |
| `briefing-render` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/dogfood/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |
| `briefing-write` | `(none — worker only)` | daily-ai-briefing (§1.3) | `workflows/dogfood/briefing-worker.ts` (briefing adapter) + adapter fixtures (mock) |

Notes on the pairing:

- **The v0 workers are deterministic keyword/coverage
  workers, not LLM judgment** (`workflows/library/worker.ts` header).
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

These live under `workflows/library/` (`worker.ts`,
`improve-loop.INTEGRATION-TEST.md`), `workflows/dogfood/` (the
rest) and `workflows/rubrics/` (the meta-rubric) but are not reusable control flow;
they are the other half of the entries above. Listed so the
inventory is complete and so nobody mistakes them for entries.

| File | What it is | Used by |
|---|---|---|
| `library/worker.ts` | Direct adapter's worker process: genuine computation for the `judge` / `fix` / `aggregate` / `rubric-update` specs and the five `improve-*` specs. One process per job trap; result JSON on the last stdout line. | §1.1 consumers, §1.2 (via direct adapter) |
| `dogfood/bugfix-worker.ts` | Worker process for the five `bugfix-*` specs (reproduce / diagnose / fix / test / verify), real under direct, `simulate: true` under mock (imported by the mock adapter). | §1.4 |
| `dogfood/briefing-worker.ts` | Worker process for the five `briefing-*` specs (live arXiv fetches, real scoring/extraction). | §1.3 (via briefing adapter) |
| `dogfood/briefing-prep.ts` | Scratch setup run via an exec trap: copies the live seen list + HTML builder into the run's scratch dir (read-only; the live files are never written). | §1.3 |
| `dogfood/briefing-prior-work.ts` | Data: the prior-work index (`PRIOR_WORK`) the briefing workflow passes to its relate jobs. Imported by §1.3, so it IS in the frozen closure. | §1.3 |
| `library/improve-loop.INTEGRATION-TEST.md` | Manual runbook for the real-engine improve-loop run (not a workflow). | §1.2 |
| `rubrics/meta-rubric.md` | The meta-rubric (v1.0): the 14-criterion rubric that judges rubrics, under four perspective headings. Data, not process. The default judging rubric for §1.9. | §1.9 |

## 6. Admittance — how a task maps to a library workflow

Admittance (`apps/agentts/src/admittance.ts`, BRA-49) is the
layer-1 scheduler: which backlog tasks run, under a WIP limit
(default 3). The mapping from a task to a library workflow is
**caller-supplied, not a built-in registry**:

1. Explicit map wins: `--map` JSON `{ taskId: workflowPath }`.
2. Then `--workflow PATH`: one workflow for every admitted task.
3. Then a `workflow:<name>` label on the task: a bare name
   resolves under the library dir (`workflows/library/<name>.ts`); a
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
  Google Slides + JudgeFixLoop. Implemented as
  `workflows/library/presentations.ts` ([BRA-109](https://linear.app/brandf/issue/BRA-109/presentations-library-workflow-bra-52-q1-google-slides-judgefixloop),
  2026-11-17).
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
