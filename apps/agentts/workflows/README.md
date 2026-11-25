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
| run-tests | `library/run-tests.ts` | workflow | `runTests` | check |
| verify-fix | `library/verify-fix.ts` | workflow | `verifyFix` | check |
| merge | `library/merge.ts` | workflow | `mergeCopy` | check |
| triage | `library/triage.ts` | workflow | `triageBacklog` | check |
| breakdown | `library/breakdown.ts` | workflow | `breakdownIssue` | check |
| dependency-mapping | `library/dependency-mapping.ts` | workflow | `mapDependencies` | check |
| daily-feed | `library/daily-feed.ts` | workflow | `publishDailyFeed` | check |
| scheduler | `library/scheduler.ts` | workflow | `reassignRun` | check |
| worker-lifecycle | `library/worker-lifecycle.ts` | workflow | `manageWorkers` | check |
| dispatch | `library/dispatch.ts` | workflow | `dispatchTasks` | check |
| gc | `library/gc.ts` | workflow | `collectRuns` | check |
| lead-loop | `library/lead-loop.ts` | workflow | `leadLoop` | check |
| daily-brief | `library/daily-brief.ts` | workflow | `dailyBrief` | check |
| land-queue | `library/land-queue.ts` | workflow | `landQueue` | check |
| rebase | `library/rebase.ts` | workflow | `rebaseCopy` | check |
| test-batching | `library/test-batching.ts` | workflow | `batchTests` | check |
| throughput-report | `library/throughput-report.ts` | workflow | `throughputReport` | check |
| bottleneck-detect | `library/bottleneck-detect.ts` | workflow | `detectBottleneck` | check |
| server-restart | `library/server-restart.ts` | workflow | `restartServer` | check |
| vm-recovery | `library/vm-recovery.ts` | workflow | `recoverVmReplacement` | check |
| push | `library/push.ts` | workflow | `pushToDev` | check |
| dual-report | `library/dual-report.ts` | workflow | `dualReportVerdict` | check |
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
prior-work relations, a deterministic must-read selection (top of
the consequence-led ranking, BRA-130), rendered markdown +
meta.json, a JudgeFixLoop structural polish over the draft, and the
weekly HTML page via the existing builder — all into scratch.

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
deterministic must-read pick — the top of the consequence-led
ranking (BRA-130: the decide trap that used to ratify the leader
was removed — the v0 decision model cannot judge consequence, so
the trap was a fake step; the ranking IS the decision), and
library reuse (JudgeFixLoop as a structural check, not a semantic
judge — its fix step can only append revision markers). No `gate`:
no step here needs a human decision.

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

### 1.11 `library/run-tests.ts` — run-tests (the test-suite runner, BRA-164)

**What it does.** Drives the AgentTS test suite from a workflow
run instead of the bash loop in `run.sh`: given a tier (or an
explicit section list) it runs each section by invoking
`run.sh --bash --only <slug>` through an `exec` trap, counts the ` OK:`
lines the same way the bash loop does, and reports per-section
results. The engine owns the loop, retry, report, and resume;
`run.sh` keeps only the leaf. A section is retried only when it
did not execute — no verdict in its output (no ` OK:` line, no
`PASS ` line, no `FAIL` line); a section whose tests ran and
failed is recorded failed, never retried. Every attempt lands in
the report; a section passing only after retry is flagged
`flaky` — file it, a flaky test is a real defect. The driver in
`run.sh` splits a tier into chunks of at most 32 sections per
workflow run (the drive cap is 50 suspensions; worst case per
chunk is 32 sections + 10 retries + 1 inventory read = 43
rounds) with deterministic runIds (`run-tests-t<T>-c<i>`), so a
re-invocation re-drives a suspended run instead of submitting a
fresh one. One shared `--resume-dir` per tier for the leaf calls.
Unlike the bash loop it runs ALL sections then reports (no
fail-fast). `run.sh --bash` forces the bash loop (the escape
hatch when the engine itself is down).

**Contract.**

- Input: `RunTestsInput` — `{ tier, sections?, inventoryPath?,
  repoRoot, runSh?, resumeDir, maxAttempts?, maxRetriesPerChunk?,
  chunkIndex?, chunkCount? }`. `sections` is the hermetic path:
  the driver supplies `[{slug, label}]` from
  `suite-inventory.json`; without it the workflow reads the
  inventory itself (one `cat` exec, filtered by tier). `runSh`
  defaults to `<repoRoot>/apps/agentts/run.sh`.
- Output: `RunTestsResult` — `{ tier, chunkIndex, chunkCount,
  sections, ran, passed, failed, totalOk, flaky, failedSlugs,
  elapsedMs }`, where `sections` is one `SectionResult` per
  section (`{ slug, label, passed, ok, attempts, elapsedMs,
  flaky }`) and `attempts` is that section's attempt history
  (`SectionAttempt[]`, including retries). A section is failed
  iff `!passed` — there is no `failed` field on a section.
- Shared shapes: `parseSectionOutput(stdout, exitCode)` is the
  exported pure verdict parser, returning `{ ok, executed,
  passed }` — `passed` is the leaf's exit code (authoritative,
  exactly as the bash loop records success iff rc == 0);
  `executed` is whether any verdict line appeared. No `failed`
  field: a nonzero exit with a verdict is a test failure, a
  nonzero exit without one is the only retryable case.

**State.** Tested by `tests/test-bra164.ts` (inventory check,
`agentts check` on this file, `parseSectionOutput` unit checks,
a live 2-section chunk via the CLI, and a bogus-slug retry
probe). Gate: `check` — this file passes `agentts check`.

### 1.12 `library/verify-fix.ts` — verify-fix (the fix verification workflow, BRA-158)

**What it does.** Encodes Meroki's manual fix verify+close loop
as a workflow: given a fix (worker report + diff + log paths, the
same handoff a worker delivers today) it (1) builds a fresh host
and re-runs the new/changed test directly with it, counting the
checks with run.sh's narrow rule (lines containing ` OK:`); (2)
runs the tiered suite (tier 1 by default) and greps the on-disk
section logs for the OK count, the ^PASS count, and the bench
verdict — from the logs, never from the runner's summary line
(the driver's printed PASS line is parsed separately and
compared against the independent counts; a mismatch fails the
verdict); (3) checks the diff is confined to the claimed files;
(4) compares the measured suite counts against the recorded
pre-change baseline and explains any delta (expected growth vs
regression vs unexplained residual); (5) produces a verify
report. It never closes issues, merges code, or decides
acceptance — Meroki reviews the report and closes. A section
that exits 0 with no verdict line at all is a no-verdict pass
and fails verification. ^PASS is evidence, not a gate: two real
tier-1 sections print no line starting with PASS (bra112 ends
"BRA112 PASS: ...", layering ends "LAYERING OK: ...") and one
prints two (bra164) — the Nov 19 tier-1 logs show 34 ^PASS
lines across 35 section logs. Bench is tier 3; tier 1 reports
"not-run" instead of inventing a verdict. Known v0 limit,
carried verbatim in every report: a false pass — a test that
passes for the wrong reason — is NOT diagnosed by this workflow
(same limit as BRA-126).

**Contract.**

- Input: `VerifyFixInput` — `{ fixId, repoRoot, workDir,
  resumeDir, dquicktsPath?, bunPath?, hostPath?, buildHost?,
  typecheck?, tier?, onlySections?, directTests, claimedFiles,
  changedFiles, baseline?, expectedAdditions? }`. `workDir` is
  scratch for the host build (created by the workflow);
  `resumeDir` must be fresh (skippedViaResume > 0 fails the
  verdict). `onlySections` selects scoped mode: those sections
  run via `run.sh --bash --only` and the baseline comparison is
  skipped with a note (a scoped run cannot be compared against
  the full-tier progression). A failed host build throws loudly
  — without a host there is no verification to report.
- Output: `VerifyReport` — `{ fixId, verdict, direct,
  typecheck, suite, confinement, baseline, knownLimit, notes
  }`, where `verdict` is "verified" (the evidence checks out —
  NOT acceptance) or "failed", and `notes` names every
  discrepancy with its counts (empty when verified). `direct`
  is one `DirectTestResult` per re-run (`{ testPath, exitCode,
  ok, expectedChecks, checksMatch, executed, passed, passLines,
  elapsedMs }`); `suite` is one `SuiteResult` (`{ mode, tier,
  sectionsRan, totalOk, passLines, sections, allPassed,
  skippedViaResume, summaryLine, summaryMatchesIndependent,
  elapsedMs }`) with per-section log evidence; `confinement`
  is `{ confined, extras, missing }`; `baseline` is `{ compared,
  baselineLabel, baselineSections, baselineOk, deltaSections,
  deltaOk, expectedSections, expectedOk, explained, explanation }`.
- Shared shapes: `parseDirectTestOutput(stdout, exitCode)`
  (run-tests' `parseSectionOutput` plus a ^PASS-line count),
  `parseTierSummaryLine(stdout)` (the driver's PASS line, null
  when absent), `parseTier1Aggregation(text)` (the line-based
  log-grep output — throws loudly on malformed lines, wrong
  sums, or zero sections), `checkDiffConfinement(changedFiles,
  claimedFiles)`, `compareBaseline(measured, baseline,
  expectedAdditions)`, `buildVerifyReport(args)`. The
  aggregation itself is one `/bin/sh -c` script over the
  on-disk section logs (the big outputs stay on disk; only the
  counts cross the trap boundary).

**State.** Tested by `tests/test-bra158.ts` (inventory check,
`agentts check` on this file, pure unit checks on the real
BRA-132 log lines and file list, and a live scoped run through
the CLI on direct). Acceptance: re-verify BRA-132 end to end
and compare the workflow's report line-by-line against
Meroki's manual verification of the same fix. Gate: `check` —
this file passes `agentts check`.

### 1.13 `library/merge.ts` — merge (the worker-per-copy merge workflow, BRA-159)

**What it does.** Encodes the manual worker-per-copy merge as a
workflow: given a worker copy + the claimed files, it (1) refuses
loudly, writing nothing, when a tier-1 is in flight (a `run.sh`
process running against the live tree — its cwd inside the live
root, or the live root in its command line), when the copy-time manifest is missing or unparsable,
when the diff is not confined to the claimed files, when any file
conflicts, or when the baselines file differs; (2) computes the
three-way diff in-shell (the manifest is read from disk and both
trees are hashed inside one process, and only the SPARSE diff —
the files whose base/copy/live hashes are not all equal — crosses
the trap boundary, because exec-trap stdout caps at ~60KB and a
full manifest or hash listing would crash the host), classifies every
claimed file three-way against the manifest base (the copy made the
change and live did not → apply; both sides changed it differently
→ conflict, the whole merge refuses; live changed it and the copy
did not → left alone; copy and live agree → already applied), then
applies the plan (cp/rm), then re-diffs in-shell and verifies the post-merge diff is
empty except live-only files and live modifications/deletions the
copy never touched; (3) typechecks the merged tree (output capped
at 4000 bytes in-shell);
(4) runs tier 1 (its output redirected
to a file, only the PASS summary line returned — run.sh tees every
section's full output to its stdout) with a fresh `--resume-dir`
by default, or the carried-forward dir on a re-drive (see Tier-1
resume below), and greps the on-disk
section logs for the OK count and the ^PASS count — from the logs,
never from the runner's summary line (the driver's printed PASS
line is parsed separately and compared against the independent
counts; a mismatch fails the verdict) — and compares the measured
counts against the pre-merge baseline, explaining any delta;
(5) produces a merge report. It applies the diff — that is its
job — but it never decides acceptance: Meroki reviews the report
and closes. A live-only file added after the copy was made is
preserved, never deleted. The baselines file is never merged from
a copy (any difference refuses the merge — re-baselining needs a
human decision). A host.ts conflict carries the note that it needs
resolution at merge time by a human. Known v0 limits, carried
verbatim in every report: a partial apply is NOT rolled back
(applied-so-far is reported instead); the tier-1 guard sees only
`run.sh` processes running against the live tree; a false pass is not diagnosed (same limit as
BRA-126).

**Tier-1 resume.** A replacement-killed merge's re-drive carries
the resume dir AND the copy forward: the driver reads the killed
run from the previous probe dir's merge-state `queue.json` + its
`input-<runId>.json` (copyRoot + resumeDir) and passes the same
copyRoot + resumeDir with input `carryForwardResume: true`. Before
the apply, the workflow validates the carried-forward journal
(`resumeJournalScript` / `parseResumeJournalOutput`): a resumed
section counts only when its `progress.jsonl` row + `.done` marker
both exist (strict row↔marker correspondence — a marker without
its row, or a row without its marker, is corrupt). Agreeing
duplicate section rows (same slug, same ok, rc=0 — a run-tests
lost-result retry) are deduplicated and counted once (no section
is counted twice); a conflicting duplicate (different ok, or
rc≠0) is corrupt. The verified
count is report data (`resumedSections`), never a note, and a clean
verified resumed run merges like a fresh one. The verdict rule is
otherwise untouched (any note → "failed"); an unverified resume
(sections skipped via resume, nothing verified) still fails exactly
as before. Reconciliation is resumed + fresh == total, checked
three ways: the summary line (driven chunks + reused chunks), the
log aggregation (markers), and the journal (section rows before vs
after the run, `reconcileResumeCounts`). A missing/corrupt
carried-forward journal, or a run.sh fingerprint refusal (the tree
changed since the resume dir was created — a fresh copy means a
fresh tier-1), falls back to a fresh tier-1, recorded as fresh in
`resumeFallback` — data, never a note. A run that did not ask to
carry a resume forward refuses a non-fresh resume dir loudly
before anything is written. run.sh itself is untouched: its resume
mechanism is proven and the workflow only chooses which dir to
pass. A failed section in a resumed run is named in the report
note with the run kind (`failedSectionLabels`, from run.sh's
`FAILED:` line). The verify-fix parallel (its note rule + flip)
is out of scope. Replay-robustness (fix round): the engine may
re-execute the workflow after the tier-1 has grown the journal, so
the pre-check count and the first invocation's summary are pinned
durably at the resume dir's top level — `resume-pre.json` (the
pre-run journal count) and `resume-tier1-summary.json` (the first
completed invocation's summary counts + PASS line) — each with the
journal lineage (the first `lines` lines of `progress.jsonl`,
verified by sha256; the journal is append-only) and the run key
(mergeId + workDir): a replay of the same run reuses the pin,
while a NEW drive against the same resume dir derives fresh from
the grown journal (its journal has legitimately accumulated since
the last drive). A stale pin (a different journal or a different
run) is overwritten; a torn pin is treated as absent. run.sh never
reads these files (it only writes `fingerprint` at the top
level), so they cannot confuse its resume or the journal
validation.

**Contract.**

- Input: `MergeCopyInput` — `{ mergeId, copyRoot, liveRoot,
  workDir, resumeDir, carryForwardResume?, claimedFiles,
  dquicktsPath?, bunPath?,
  typecheck?, runTier1?, dryRun?, tier?, baseline?,
  expectedAdditions? }`. `copyRoot` is the worker copy;
  `liveRoot` is the live tree the merge writes to. The copy-time
  manifest (`.agentts-copy-manifest.json` at the copy root,
  recorded by `scripts/record-copy-manifest.sh` at copy time) is
  the three-way base; without it the merge refuses. `resumeDir`
  must be fresh by default (an unverified resume — skippedViaResume
  > 0 with nothing verified — fails the verdict); a re-drive sets
  `carryForwardResume: true` and passes the killed run's resume
  dir, which the workflow validates before the apply (see Tier-1
  resume above).
  `runTier1: false` skips the suite step with a note (the test's
  scratch-tree runs use this); `dryRun: true` plans the merge but
  writes nothing and runs no suite. `baseline` /
  `expectedAdditions` reuse verify-fix's `SuiteBaseline` /
  `ExpectedAddition` shapes.
- Output: `MergeReport` — `{ mergeId, verdict, dryRun,
  tier1InFlight, applied, deleted, planned, alreadyApplied,
  liveOnlyPreserved, conflicts, baselinesRefused, confinement,
  typecheck, suite, baseline, resumedSections, resumeFallback,
  manifestCopiedAt, knownLimit, notes
  }`, where `verdict` is "merged" (the evidence checks out — NOT
  acceptance), "dry-run" (the plan is clean, nothing written), or
  "failed", and `notes` names every discrepancy with its counts
  (empty when merged). `resumedSections` is the verified resumed
  count (0 on a fresh run or a fallback to fresh); `resumeFallback`
  names why a requested carry-forward ran fresh instead (null when
  no fallback happened) — both are data, never notes. `suite` /
  `baseline` reuse verify-fix's
  `SuiteResult` / `BaselineResult` shapes.
- Shared shapes: `parseCopyManifest(text)` (throws loudly on a
  malformed manifest), `parseHashOutput(stdout)` (one sha256sum
  listing → path → hash, throws loudly on a malformed line),
  `parseSparseDiff(text)` (the in-shell sparse-diff JSON → copiedAt
  + differing files, throws loudly on malformation),
  `sparseDiffScript(copyRoot, liveRoot, manifestPath)` (the
  in-shell diff; exit 0 = sparse JSON, 2 = manifest missing,
  3 = manifest unparsable), `typecheckScript` / `tier1RunScript`
  (bounded-output wrappers for the tsc and run.sh traps),
  `resumeJournalScript(journalDir)` / `parseResumeJournalOutput`
  (one bounded line: `valid <resumed> <rows>`, `missing`, or
  `invalid: <reason>`), `reconcileResumeCounts` (resumed + fresh
  == total), `failedSectionsScript(outPath)` /
  `parseFailedSectionsOutput` (the slugs run.sh reported failed),
  `computeChangedFiles({ base, copy, live })` (the copy's changes
  vs the base + the live-only files), `classifyMergeFile({ file,
  base?, copy?, live? })` (the three-way rule), `buildMergePlan({
  claimedFiles, base, copy, live })`, `buildMergeReport(args)`.
  The parsers and the aggregation are verify-fix's, imported not
  duplicated (`parseTierSummaryLine`, `parseTier1Aggregation`,
  `checkDiffConfinement`, `compareBaseline`,
  `tier1AggregationScript` — one counting rule and one
  aggregation rule in the repo).

**State.** Tested by `tests/test-bra159.ts` (inventory check,
`agentts check` on this file, pure unit checks on the three-way
classification and the manifest parse, and live runs through the
CLI on direct against scratch trees: apply, dry-run, conflict,
baselines-refusal). Acceptance: one real merge executed by the
workflow with tier 1 green after it. Gate: `check` — this file
passes `agentts check`.

### 1.14 `library/triage.ts` — triage (the backlog triage workflow, BRA-210)

**What it does.** Ranks the Linear backlog from Linear + GOAL.md:
(1) fetches the open list through the `linear` CLI (`call-tool
--name list_issues`, project + limit) — the full JSON is redirected
to a file in-shell and only a `FETCHED <count> <bytes>` line returns,
because exec-trap stdout caps at ~60KB and the list is far larger;
a zero-issue list refuses rather than ranking an empty backlog;
(2) when the run input carries a `runId`, checks the run's cancelled
flag in `stateDir/queue.json` before the write step (check-then-act
— a cancelled run refuses, writing nothing); (3) ranks in a bun
script (`scripts/triage-rank.ts`, run under `bun` from disk — the
script reads the fetched issues JSON + GOAL.md, ranks with this
file's pure helpers, renders the drift note, and writes the outputs
atomically, temp file + rename, then self-verifies by re-reading the
queue) and returns only a one-line JSON summary; (4) produces a
triage report. The ranking is (bucket, GOAL.md position, Linear
priority, id), where the buckets are ready, gated-but-speculable
(decision-gated — flagged, never speculated), blocked (an open
dependency), parked (won't-fix, out-of-r2, or parallel-track — its
own gate, not r2). GOAL.md position reproduces the r2 order WITHIN
each bucket; the drift note flags where bucketing moved an item
relative to GOAL.md. The drift note proposes order changes; it never
makes them — the PM decides. The workflow never files to Linear,
never closes an issue, never merges code, never decides acceptance.
Known v0 limits, carried verbatim in every report: the ranking sees
only what Linear + GOAL.md record — dependencies and code areas not
written in either are unknown, never inferred; GOAL.md parsing is
textual — a GOAL.md rewrite that moves the r2 priority order section
or the parallel-work map breaks the parse loudly (the run refuses)
instead of misranking silently; cancellation is check-then-act before
the write step only — the driver also checks before each drive step,
and a cancel landing mid-slice still finishes that slice's fetch
(read-only); a false pass — a test that passes for the wrong reason —
is NOT diagnosed by this workflow (same limit as BRA-126/verify-fix).

**Contract.**

- Input: `TriageInput` — `{ project, run, launchedBy?, owner }`.
  Two layers: `project` is the project config (`linearProject`,
  `repo`, `stateDir`, `roster`, `thresholds?`); `run` is the run
  input (`triageId`, `goalDir`, `queuePath`, `driftNotePath`,
  `stableQueuePath`, `workDir`, `limit?` (default 200, 1..1000),
  `linearBin?` (default `/opt/hatch/bin/linear`), `bunPath?`,
  `dryRun?`, `wontFix?`, `runId?`). `owner` is required at the top
  level — the driving session, never assumed from the launcher
  (the triage workflow is launched by the Director with owner set to
  the PM lead, and answers decide itself as owner). `workDir` is
  scratch for the fetch output; the queue + drift note go to the
  dated paths in the goal's hidden files plus a stable
  `ranked-queue.json`. `dryRun: true` computes but writes nothing.
- Output: `TriageReport` — `{ triageId, verdict, dryRun, owner,
  launchedBy?, cancelChecked, cancelled, open, counts, queuePath,
  driftNotePath, stableQueuePath, drift, duplicates, wontFix,
  knownLimit, notes }`, where `verdict` is "triaged" (the queue +
  drift note were written — NOT acceptance), "dry-run" (the plan is
  clean, nothing written), or "failed", and `notes` names every
  failure. `counts` is `{ open, ready, gatedButSpeculable, blocked,
  parked, duplicates, wontFix }`; `drift` is the full drift list
  (unslotted, priority-vs-position, stale-state, unknown-code-area)
  — a few KB for the real tree, carried in the report because the
  report is the auditable record.
- Shared shapes: `parseLinearIssues(text)` (the MCP envelope →
  inner issues JSON, throws loudly on any malformation),
  `parseGoalOrder(text)` (the "**r2 priority order" bullet →
  ordered chain + supporting + parallel track + out of r2; throws
  when any part is missing), `parseParallelWorkMap(text)` (the
  parallel-work map bullets → issueId → {area, files}; throws when
  the section is missing), `expandIssueRefs(text)` (ranges
  BRA-148–153, slash lists BRA-134/135/136, plain ids — first
  appearance, deduped), `classifyDependency(description)`
  (sentence-level dependency / blocks / decision-gated),
  `rankIssues({ issues, goal, codeMap, wontFix? })` (the bucket +
  sort + drift rule), `renderDriftNote(args)`, `parseFetchSummary`,
  `parseRankSummary`, `rankErrorMessage`, `parseRunStatus`,
  `linearListScript` / `triageRankScript` / `cancelCheckScript`
  (the three in-shell steps), `buildTriageReport(args)`.

**State.** Tested by `tests/test-bra210a.ts` (inventory check,
`agentts check` on this file, pure unit checks on every exported
helper, and live runs through the CLI on direct against scratch
trees with a stub `linear` CLI: happy path, dry-run, CLI failure,
unparsable output, missing GOAL.md, size regression, owner missing,
cancelled run, duplicates, won't-fix). Acceptance: a triage run on
the live open list reproduces the GOAL.md r2 order and flags the
known drift (BRA-155 unslotted, BRA-157 Urgent low, BRA-212/159
state stale). Gate: `check` — this file passes `agentts check`.

### 1.15 `library/breakdown.ts` — breakdown (the feature-breakdown workflow, BRA-210)

**What it does.** Turns one filed feature issue into filed,
estimated tasks with acceptance criteria and code areas: given a
feature issue (e.g. BRA-167) and a split authored by the launcher
(the PM lead, in `run.plannedTasks`), it (1) validates the input
purely — project config, owner, plan (non-empty, well-formed
tasks, unique titles) — with no side effects before the guards
pass; (2) reads the parent issue via the Linear CLI
(`get_issue`) — a tool error here refuses the run as a wish (a
roadmap item without a filed issue is not planned work), as does
a cancelled or archived parent; (3) lists the parent's existing
children (`list_issues` with `parentId`) — the idempotency read;
(4) plans each task as to-file or already-filed (a dry-run
reports the plan and writes nothing); (5) files each to-file
task, one exec trap per task, in Linear with the parent's full
URL in the description prose and as a link attachment (never a
bare key), `parentId`, estimate, and priority — except a create
refused with Linear's free-plan issue limit, which falls back:
the refused task and every remaining unfiled task go to the
goal's BACKLOG.md (`run.backlogPath`) in the complete form, and
the report records the backlog md as the filing location (the
verdict stays "broken-down", the deviation noted); a non-limit
refusal still fails loudly with nothing half-done; (6) verifies
by re-listing the children and confirming every Linear-filed
task now has a child — a filing that claimed success but left no
child fails loudly — and by reading BACKLOG.md back for the
fallback tasks; (7) rebuilds the parent's `## Breakdown` section
deterministically from the Linear children only when it is
missing or stale, and skips the update when it is already
current, so a re-run is a no-op — and skips it entirely when
the run filed no Linear children at all; (8) produces a
breakdown report with the filed task list and Linear links. It files first: the task list is not delivered
until the issues exist. It never closes an issue, never merges,
and never decides acceptance — the verdict is evidence, not
acceptance; the PM reviews the report and closes.

The split is supplied, not invented: which tasks a feature
splits into, their estimates, and their code areas is the
launcher's judgment; the workflow's job is the procedure. A
workflow that invented estimates from prose would be
fabrication dressed as a procedure. Linear access is the
`/opt/hatch/bin/linear` CLI via exec traps (`call-tool --name
<tool> --arguments-json '<json>'`); every CLI output is bounded
in-shell (`head -c 40000`, `BREAKDOWN_LINEAR_OUTPUT_CAP`),
because exec-trap stdout caps at ~60KB and an unbounded parent
JSON would crash the host — a parent whose JSON exceeds the
bound refuses loudly instead. Owner/launcher (settled,
BRA-211): the workflow takes `owner` in its run input —
launched by the Director with owner set to the PM lead; the
Director never owns; it never assumes launcher == owner, and a
run launched without an owner refuses before any Linear call.
Cancellation is check-then-act at the driver level, not an
in-body check. Known v0 limits, carried verbatim in every
report: a partial filing is NOT rolled back — filed-so-far stays
filed and a re-run picks them up as already-filed; the parent
update is skipped when a run dies before it, and a re-run
repairs it; a parent issue whose JSON exceeds the 40KB bound
refuses loudly; the split is supplied in run input by the
launcher — the workflow files the split, it does not invent it;
cancellation is enforced by the driver between slices, not by
an in-body check; the create-response shape is assumed to
mirror `get_issue`'s.

**Contract.**

- Input: `BreakdownInput` — `{ project, run, launchedBy?,
  owner? }`. `project` is the shared `ProjectConfig` plus
  `linearTeam` (the one field breakdown needs beyond mechanics
  §3, because it files; triage does not need it). `run` carries
  `breakdownId`, `issueId`, `plannedTasks`, `dryRun?`,
  `linearCli?` (default `/opt/hatch/bin/linear`), `backlogPath?`
  (absolute path to the goal's BACKLOG.md — the fallback filing
  location, optional up front), `now?` (ISO date for the fallback
  entry's Recorded line, default today's UTC date). Each
  `PlannedTask` is `{ title, estimate, codeArea, acceptance,
  priority? }` (estimate an integer, priority one of
  Urgent|High|Medium|Low, default Medium). `owner` is required.
- Output: `BreakdownReport` — `{ breakdownId, issueId,
  parentTitle, parentUrl, verdict, dryRun, planned, filed,
  alreadyFiled, filedToBacklog, parentUpdated, knownLimit, notes[] }`, where
  `verdict` is "broken-down" (the evidence checks out — NOT
  acceptance), "dry-run" (the plan is clean, nothing filed), or
  "failed", and `notes` names every discrepancy (empty when
  broken-down). Each `FiledTask` carries `{ issueId, url, title,
  estimate, codeArea, acceptance, status }` with `status`
  "filed" or "already-filed". `filedToBacklog` lists the tasks
  filed to BACKLOG.md by the fallback (each carries `issueId`
  "" — no Linear issue exists — and `url` = the BACKLOG.md
  path); the notes name the deviation when the filing location
  is split.
- Shared shapes: `parseLinearToolResult(text)` (unwraps the
  CLI's `{"ok":...,"result":{"content":[{"text":"<inner
  JSON>"}]}}` envelope, throws loudly on a tool error),
  `parseLinearIssue(text)`, `parseChildList(text)`,
  `priorityNameToValue(name)` (Urgent 1, High 2, Medium 3,
  Low 4), `validateBreakdownInput(input)` (throws with the exact
  refusal reason), `buildChildDescription(parent, task)`,
  `buildBreakdownPlan(planned, children)`,
  `buildParentDescription(current, filed)`,
  `stripBreakdownSection(text)`,
  `renderBreakdownSection(filed)`,
  `orderChildrenByPlan(planned, filed, alreadyFiled)` (plan order,
  so the parent section is deterministic across re-runs),
  `linearGetIssueScript` / `linearListChildrenScript` /
  `linearSaveIssueScript` (the bounded in-shell CLI scripts),
  `buildBreakdownReport(args)`, `isLinearLimitRefusal(message)`
  (the free-plan limit classifier — matches only the stable core
  of the real refusal), `limitRefusalSummary(message)` (the core
  sentence for the entry's Source line),
  `backlogEntryHeading(issueId, breakdownId)`,
  `renderBacklogEntry(args)` (one fallback entry, every task in
  full), `findBacklogEntryTitles(text, issueId, breakdownId)`
  (the idempotency read), `backlogEntryReadScript` /
  `backlogEntryChunkScript` / `backlogAppendScript` (the bounded
  BACKLOG.md read and the dispatch-pattern chunked append).

**State.** Tested by `tests/test-bra210b.ts` (inventory check,
`agentts check` on this file, pure unit checks on the parsers,
the plan builder, the parent-description rebuild, and the
refusal cases, and live runs through the CLI on direct against
a stub `linear` CLI — never the real project: happy-path filing
of BRA-167's four tasks, dry-run, wish refusal, idempotency /
re-run, plan refusal, size-bound refusal, no-owner refusal,
partial filing + recovery), and by `tests/test-bra210c.ts`
(the BACKLOG.md fallback: classifier, entry renderer,
idempotency matcher, script shapes, and live runs — first-create
and mid-filing limit refusals, non-limit refusal, dry-run,
re-run, happy path, missing backlogPath). Acceptance: one real breakdown
executed by the workflow (BRA-167) with filed Linear tasks and
links. Gate: `check` — this file passes `agentts check`.


### 1.16 `library/dependency-mapping.ts` — dependency-mapping (the dependency graph workflow, BRA-251)

**What it does.** Persists triage's ranked queue into the dependency
graph the scheduler reads as its reservation stations: (1) when the
run input carries a `runId`, checks the run's cancelled flag in
`stateDir/queue.json` before the write step (check-then-act — a
cancelled run refuses, writing nothing); (2) builds the graph in a
bun script (`scripts/dependency-graph.ts`, run under `bun` from disk
— the script reads the ranked queue JSON + the GOAL.md release plan,
builds the graph with this file's pure helpers, diffs it against the
previous graph when one is supplied, and writes the outputs
atomically, temp file + rename, then self-verifies by re-reading the
graph and parsing it back) and returns only a one-line JSON summary
— the graph itself never crosses a trap boundary, because exec-trap
stdout caps at ~60KB and the real graph is ~70KB; (3) produces a
mapping report. Nodes are the queue items in queue order (`rank` is
the 0-based queue index). Edges are `dependsOn` (from an item's
`dependencies[]`), `blocks` (from an item's `blocks[]`), and
`conflict` (derived: two nodes in the ready or gated-but-speculable
buckets with the same non-`unknown` codeArea — they cannot run in
parallel; `unknown` areas never conflict, because that would be
guessing). An edge joins only nodes present in the queue: a
dependency or block naming an issue outside the queue, or the item
itself, produces no edge (counted in `droppedEdges`). The graph is
a pure function of the queue — `generatedAt` IS the queue's
`generatedAt`, so the same queue yields the byte-identical graph
(idempotent rebuild, never an incremental merge). GOAL.md is a
presence guard in v0: the workflow verifies the release-plan file
exists but does not parse the r2 order — triage owns the order, and
this workflow must not re-derive it. The workflow never touches
Linear, never closes an issue, never merges code, never decides
acceptance.

- Input: `DependencyMappingInput` — `{ project, run, launchedBy?,
  owner }`, two layers (mechanics §3). `project` is the §3 project
  config (`linearProject`, `repo`, `stateDir`, `roster`,
  `thresholds?`, `workDir`, `resumeDir`); `run` is the run input
  (`mappingId`, `queuePath`, `goalPath`, `graphPath`,
  `datedGraphPath`, `previousGraphPath?`, `bunPath?`, `dryRun?`,
  `runId?`). `owner` is required at the top level — the driving
  session, never assumed from the launcher (the mapping workflow is
  launched by the Director with owner set to the PM lead). `workDir`
  is scratch; the graph goes to the dated path + a stable
  `dependency-graph.json`. `dryRun: true` computes but writes
  nothing.
- Output: `DependencyMappingReport` — `{ mappingId, verdict, dryRun,
  owner, launchedBy?, cancelChecked, cancelled, graphPath,
  datedGraphPath, goalPath, counts, edgesByKind, droppedEdges,
  edgeChanges, sampleNodes, sampleEdges, knownLimit, notes }`, where
  `verdict` is "mapped" (the graph was written — NOT acceptance),
  "dry-run" (the plan is clean, nothing written), or "failed", and
  `notes` names every failure. `counts` is `{ nodes, edges, ready,
  gatedButSpeculable, blocked, parked }`; `edgesByKind` is
  `{ dependsOn, blocks, conflict }`; `edgeChanges` is `{ added,
  removed, addedSample, removedSample }` vs the previous graph
  (empty when none was supplied); `sampleNodes` / `sampleEdges`
  are the first 3 — the full lists live in the graph file, never
  in the report.
- Shared shapes: `parseRankedQueue(text)` (the queue JSON → the
  triage handoff, throws loudly on any malformation; a zero-item
  queue refuses with its own message), `parseDependencyGraph(text)`
  (the graph JSON → the BRA-160 handoff, same strictness — the
  previous-graph diff and the write-back verification both trust
  it), `buildGraph({ queue, queuePath })` (nodes + the three edge
  kinds + `droppedEdges`, deterministic), `compareGraphs(previous,
  current)` (edge-set diff: counts + first-3 samples),
  `renderGraph(graph)` (deterministic 2-space JSON), `parseGraphSummary`,
  `graphErrorMessage`, `parseRunStatus`, `graphScript` /
  `cancelCheckScript` (the two in-shell steps),
  `buildMappingReport(args)`.

**State.** Tested by `tests/test-bra251.ts` (inventory check,
`agentts check` on this file, pure unit checks on every exported
helper, and live runs through the CLI on direct against scratch
trees with fixture queue JSONs: happy path, dry-run, missing queue,
unparsable queue, zero-item queue, missing GOAL.md, owner missing,
cancelled run, previous graph, size regression, refusal after the
cancel check). Acceptance: a mapping run on the live triage queue
produces a graph whose node/edge counts reconcile against the queue,
parsed back with the workflow's own parser. Gate: `check` — this file
passes `agentts check`.

### 1.17 `library/daily-feed.ts` — daily-feed (the daily queue feed workflow, BRA-252)

**What it does.** Publishes the prioritized queue the fleet works
from each day — the third leg of the pipeline (triage sorts, the
dependency graph persists, the feed publishes). Given the triage
ranked queue JSON + the dependency graph JSON + GOAL.md, it (1)
validates the input purely — project config, owner, paths — with
no side effects before the guards pass; (2) checks the run's
cancelled flag in `stateDir/queue.json` when a runId is present
(check-then-act before the write step); (3) builds the feed with
a bun script (`scripts/daily-feed-publish.ts`, run under `bun`
from disk — the queue/graph/feed JSON never cross a trap boundary,
only a one-line JSON summary returns) and writes the dated feed
+ the stable `daily-feed.json` atomically (temp file + rename);
(4) produces a daily-feed report with the counts, the drift list,
and the first-5 ids + first-3 sample items. The feed is the ready
+ gated-but-speculable queue items in queue rank order, each
carrying `conflictsWith` from the graph's conflict edges (both
directions, feed items only, ordered by the other item's rank).
Blocked and parked items are counted, never fed. There is no cap
— the scheduler applies quotas, not the feed. A missing graph
file refuses loudly (the pipeline order is triage → 251 → 252,
so the graph exists when this runs), as does a graph from a
different triage run (triageId mismatch). Feed items whose GOAL.md
position disagrees with their rank carry a drift note, in triage's
categories, feed items only. It never closes an issue, never
merges, and never decides acceptance — the verdict is evidence,
not acceptance; the PM reviews the report and closes.

The graph is the authority, not a suggestion: the feed applies
the graph's conflict edges as given and never re-derives them —
a graph with wrong edges for the same triage run is published
as-is (the known limit says so). What the feed does enforce is
pipeline integrity: a missing graph, an unparsable graph, or a
graph from another triage run refuses loudly, fail-closed, before
any write. No Linear access anywhere — triage already did the
Linear read, and the pipeline's whole point is that this workflow
works from triage's output.

**State.** Tested by `tests/test-bra252.ts` (inventory check,
`agentts check` on this file, pure unit checks on the parsers,
the feed builder, the drift computation, and the refusal cases,
and live runs through the CLI on direct against hand-built queue
+ graph fixtures — never Worker C's output: happy path, dry-run,
each refusal path, idempotent re-run, sentinel preservation, and
a ~1,200-item size regression). Acceptance: one real feed
published from the live queue + the real 251 graph, its order
matching queue rank order for ready+gated items. Gate: `check` —
this file passes `agentts check`.

### 1.18 `library/scheduler.ts` — reassignRun (the dynamic scheduler's lead-facing surface, BRA-160)

**What it does.** Reassigns a run to a new owner — the Director's
supervisor operation for a dead or unresponsive owner, and the
only workflow entry the scheduler carries. The scheduler itself
is engine code, not a workflow: `src/scheduler.ts` holds the
pure selection (owner routing, run queues + work-stealing, the
serial-commit lock, and the pure `detectDeadOwners`), and
`src/worker-server.ts` holds the store and the endpoints (POST
`/reassign-run`, GET `/owners`). This file is the thin workflow
surface over one of those operations. Given the run to reassign
+ the new owner + the server URL, it (1) validates the input
purely — project config, owner, paths — with no side effects
before the guards pass (the owner is required, never assumed
from the launcher; the new owner is a lead session, never the
Director, which does not loop and never owns); (2) checks the
run's cancelled flag in `stateDir/queue.json` when a runId is
present (check-then-act before the reassign step); (3) calls a
bun script (`scripts/scheduler-reassign.ts`, run under `bun`
from disk — the script POSTs `/reassign-run` and writes the
full response to a file in `workDir`, so the response never
crosses a trap boundary; only a one-line JSON summary returns);
(4) produces a reassign report naming the old owner, the new
owner, the retagged counts, and the pending decide explicitly
(`decideRetagged` + `pendingDecideJobId`, null/false when the
run has no pending decide). Dry-run mode validates + cancel
checks and calls nothing. A refusal means nothing was retagged:
the server updates the run record first and retags only after
the record update succeeds. The server is the authority on the
retag — the workflow never edits `queue.json`, `runs/<run>.json`,
or the worker store itself. It never closes an issue, never
merges, and never decides acceptance — the verdict is evidence,
not acceptance; the Director reviews the report and decides the
reassignment stands.

Dead-owner DETECTION has no workflow entry here: detection is a
query, not an operation — the Director's supervision check reads
GET `/owners` (the engine's liveness signals) and applies the
pure `detectDeadOwners` from `scheduler.ts`. The trigger is
Director-settled: primary = lease expiry on the owner's claimed
jobs, secondary = the Director's supervision check; a missed
daily report is a lagging signal, never the trigger. The engine
never reassigns by itself.

**State.** Tested by `tests/test-bra160.ts` (inventory check,
`agentts check` on this file, pure unit checks on the selection,
`detectDeadOwners`, the parsers, the report builder, and the
script builder, and live runs on scratch servers/state only —
never the production port, never the production state dir,
never the real Linear: decide owner-only, owner idle steal,
dedup retag, dead-owner trigger, pending decide retagged,
serial-commit, gate frees the thread, the stdout cap, and the
reassign workflow's happy path, dry-run, owner-missing,
cancelled, and run-not-found cases). Acceptance: the reassign
workflow driven through the CLI on direct, with the queue entry
+ registry entry owner == new on disk. Gate: `check` — this
file passes `agentts check`.

### 1.19 `library/worker-lifecycle.ts` — manageWorkers (the long-lived workers' lead-facing surface, BRA-213)

**What it does.** Manages the worker registry for long-lived
workers — register a worker under an owner, list workers (one
lead's, or all for the PM), close a worker. One file, one default
entry (`manageWorkers`); `run.operation` selects register, list,
or close, because `agentts check` gates one entry per file and the
three operations share the input shape, the server script, and the
cancel/validation guards. The workers themselves are engine state,
not a workflow: the runner (`plugins/muse/worker-loop.ts`, script
mode) loops get-job → execute → submit, and the server owns the
registry (`src/worker-registry.ts` — pure derivation over the
worker store; `src/worker-server.ts` — POST `/register-worker`,
GET `/workers`, POST `/close-worker`). This file is the thin
workflow surface over those three operations. Given the operation
+ the worker (or the owner filter) + the server URL, it (1)
validates the input purely — project config, owner, paths, and
the per-operation fields (register requires workerId +
ownerSession — a worker with no owner is refused here AND by the
server; close requires workerId) — with no side effects before
the guards pass (the owner is required, never assumed from the
launcher); (2) checks the run's cancelled flag in
`stateDir/queue.json` when a runId is present (check-then-act
before the lifecycle step); (3) calls a bun script
(`scripts/worker-lifecycle.ts`, run under `bun` from disk — the
script calls the server endpoint and writes the full response to
a file in `workDir`, so the response never crosses a trap
boundary; only a one-line JSON summary returns); (4) produces a
lifecycle report naming the worker, the owner, the status, and —
for close — whether the worker was already closed or was running
a job; for list, the counts by status + the out-file path (the
full listing rides in the out file, never in the report).
Dry-run mode validates + cancel checks and calls nothing. A
refusal means nothing was registered, listed, or closed.

**Lifetime (the policy this surface manages).** A worker is a
looping sub-agent owned by a lead: it presents a stable worker id
AND its owner session at every get-job (the server records the
owner — last presentation wins — and the scheduler reads it for
owner-routed dispatch; a worker that presents no owner is a
legacy worker). It ends on idle timeout (30 minutes by default,
`DEFAULT_WORKER_IDLE_TIMEOUT_MS` in `src/worker-registry.ts`,
overridable per worker with `--idle-exit-ms`, explicit 0
disables it), lead close, or VM death. Close is finish-then-exit:
the worker completes its in-flight job under its existing lease,
then exits before the next get-job; a closed worker never claims
another job (get-job answers `{ job: null, closed: true }` and
the parked long-poll is woken). A SIGKILL (or VM death) is the
unclean path: the leased job re-queues on lease expiry and
completes on another worker (maxAttempts 3 — existing machinery).
Workers are NOT persisted: no memory file, no chat session, no
durable identity; context accumulates during life and dies with
the worker. Worker-per-copy still applies PER JOB — each job's
work happens in a fresh per-job workspace.

**The registry.** One entry per worker record: owner + spawned-at
+ last-seen + status (alive/idle/closed/dead) + the running job.
Statuses are derived, never self-reported: closed wins (the lead
closed it — terminal), then dead on silence past
`WORKER_DEAD_AFTER_MS` (300s, one lease window, aligned with the
dead-owner silence), then alive (seen + running) vs idle (seen +
running nothing). Closed records persist with status closed —
contract 6's "removes the worker from the registry" is removal
from the ACTIVE pool, not deletion (that is why "closed" is a
status at all). Registration is a record, not a liveness proof: a
registered worker that never calls get-job shows as idle, then
dead after the silence window. The owner filter is a view, not a
permission: the server does not authenticate leads, so any caller
can list any owner's workers; a lead lists its own by convention
and the PM lists all.

**Tests (`tests/test-bra213.ts`).** §A pure unit checks (status
derivation incl. closed-wins and custom dead windows, registry
build + running-job lookup, registration refusal on a missing
owner, the 30-minute idle default, the lifecycle
parsers/report/script-builder); §B `agentts check` (entry
`manageWorkers(WorkerLifecycleInput)`) + `bun build` load checks
for the runner and get-job.ts; §C inventory + run.sh + README +
CHANGELOG wiring; §D live runs on scratch servers/state only —
the kill test (spawn a worker, kill it mid-job with SIGKILL, the
job re-queues after lease expiry and completes on another
worker), ≥2 jobs in sequence on one worker without re-spawn, idle
timeout at the override, lead close after the in-flight job +
prompt close of an idle-parked worker, registry list by lead vs
PM, the no-memory/no-chat absence assertions, and the stdout cap.
Acceptance: the lifecycle workflow driven through the CLI on
direct (register, list, close, refusal, and cancelled cases),
with the registry entries asserted on the server. Gate: `check` —
this file passes `agentts check`.

### 1.20 `library/dispatch.ts` — dispatchTasks (the task-kind router, BRA-176)

**What it does.** Matches task kinds to the workflows that run
them — the router between the queue and the execution mechanism.
One file, one default entry (`dispatchTasks`); the switch key is
the task's triage tag (the bare workflow name, or admittance's
`workflow:<name>` label form — the tag scheme builds on /
subsumes the label, §6 route 3). Given a list of tasks to route,
each carrying its tag + bucket + fields, it (1) validates the
input purely — project config, owner, tasks with unique ids and
valid buckets, assignments an object — with no side effects
before the guards pass (the owner is required, never assumed
from the launcher); (2) checks the run's cancelled flag in
`stateDir/queue.json` when a runId is present (check-then-act
before the write step, exactly as triage does — including the
live `cancelChecked` flag, so a check that cannot complete
reports false and a cancelled status reports true + cancelled);
(3) routes, in input order and never re-sorted: READY tasks only
— a gated, blocked, or parked task is not routed as ready, it
appears in `refused` with the reason named; a task with no
assignment refuses loudly (dispatch never invents an owner);
an assignment naming a session that is not in the project roster
— not a looping session — refuses loudly, never silently
re-derived to the driving session; the switch case constructs
that workflow's run-input JSON from the task's fields (ids derive
from `<dispatchId>-<taskId>`, workDirs from the dispatch work
dir), and a tag naming no workflow — or a workflow whose input
cannot be constructed from the task's fields — refuses as
needs-workflow with the reason named; (4) writes the routing
handoff JSON the scheduler consumes — one entry per task naming
the workflow + the run-input JSON + the owner — atomically
(temp file + rename) with a read-back verify, and returns the
dispatch report (verdict + routed/refused + handoff path +
cancelChecked + known limit). Dry-run mode plans the routing
and writes nothing.

**What it does NOT do.** Dispatch does not submit runs and does
not call sub-workflows in-run (set design §5: "match kind →
workflow + run-input JSON; hand to the scheduler. Output: the
dispatched workflow reference + input."). The scheduler (BRA-160)
owns submission/assignment; dispatch submitting directly would
bypass it and blur the boundary the set design draws. Dispatch
creates no queue entries and enqueues no jobs anywhere — the
§D no-submit check proves it (the queue is byte-identical apart
from the dispatch run's own entry, and the worker-jobs store
holds no jobs). The handoff names the workflow; dispatch does
not verify the workflow file exists — the scheduler refuses
loudly at submit time if it is absent. The switch names SHARED library
workflows only (mechanics §4); project-specific values arrive
through the input. Kind is a property of the task — its triage
tag — supplied per task by the caller (the role-loop, once it
exists; a driver until then); it is NOT derived from a
ranked-queue row, which carries no kind field. Scope of v0:
dispatch routes TASK kinds (the recurring fleet operations); it
does NOT route Linear backlog issues to leads — that is the
role-loop's job, which is unbuilt.

**The chunked handoff write.** The handoff JSON can exceed the
~60KB trap cap (at ~300 tasks the full table approaches it) and
the ~128KB single-argv cap, so it is written in base64 chunks —
one small append trap per chunk (24KB raw → 32KB base64) — and
finalized by a rename + read-back trap that returns one `WROTE
<bytes> <path>` line. The routing table never crosses a trap;
each trap returns one line. The §C size case proves the chunking
on 1,200 dummy tasks (handoff over the cap, every chunk script
far under the argv cap, chunks reassemble exactly); the §D size
case proves it live (1,200 tasks routed, handoff parses with
1,200 routed).

**Tests (`tests/test-bra176.ts`).** §A inventory check; §B
`agentts check` (entry `dispatchTasks(DispatchInput)`); §C pure
unit checks (`resolveWorkflow` for every kind, bare and
`workflow:`-prefixed, plus unknown/malformed tags; the field
helpers; `buildRouting` for every switch case incl.
worker-lifecycle register/list/close and the needs-workflow
refusals; `buildHandoff` determinism; the chunked-write helpers
+ the 1,200-task size case; `buildDispatchReport` verdicts +
known limit verbatim); §D live runs on scratch trees only — D1
routing per kind into the handoff (every routable workflow, right
workflow + input + owner, handoff parses and matches the report)
AND the no-submit check, D2 unknown tag refuses, D3 no
assignment refuses, D4 non-roster owner refuses, D5
gated/blocked/parked not routed, D6 input order preserved
(input order disagrees with priority order), D7 dry-run writes
nothing, D8 cancel refuses before any routing (cancelled runId,
and the no-entry half with cancelChecked false), a live 1,200-task
size case, and the no-owner case (absent owner refused at submit,
empty owner refused by the workflow). Gate: `check` — this file
passes `agentts check`.

### 1.21 `library/gc.ts` — collectRuns (the garbage collector for finished runs, BRA-178)

**What it does.** Sweeps terminal runs, checks age + mark, and
collects the eligible ones, journaling what it did. Given the
state dir to sweep + the retention window (project config,
`project.retentionDays`, default 30 days) + the archive dir, it
(1) validates the input purely — project config, owner, paths,
and a positive retention — with no side effects before the
guards pass (the owner is required, never assumed from the
launcher); (2) sweeps in-shell (an inline-python trap reads
`queue.json` + the ledger + the run entries + the journals + the
archive dir and returns one JSON line of FACTS — status, keep,
finishedAt, frozen hash, work dir, blob paths — never decisions;
the workflow classifies the facts with the pure `classifyRun`
helper); (3) checks the run's cancelled flag in
`stateDir/queue.json` when a runId is present (check-then-act
before any collection); (4) collects, one exec trap per eligible
run: archive first (`cp -a` the journal + run entry into
`<stateDir>/archive/<runId>/`, and a small python step writes
`run.json` there from the queue entry + ledger record + frozen
hash read from disk), then delete the live paths (`rm -rf` the
queue entry's journal + run entry + work dir + per-run blobs),
then verify the paths are gone; (5) appends the run's
`collected` ledger record (one exec trap per collected run, only
after the deletion is verified, and only when no collected
record for the run exists yet — exactly one per run, ever);
(6) rewrites `queue.json` under the enqueue lock (the host's
lock protocol mirrored in-shell, previous good queue backed up
to `queue.json.bak` first, atomic tmp file + rename), removing
the collected entries; (7) produces a GC report naming every
collected run (archive path, finishedAt, age) and every skipped
run with its reason. Dry-run mode plans the collections and
collects nothing. A refusal means nothing was collected.

**The retention clock.** A run is eligible when `now -
finishedAt >= retentionDays` and it is not kept. `finishedAt`
is the ledger record's finishedAt (the wall timestamp of the
terminal event); a cancelled run leaves no ledger entry (a
cancelled run is neither done nor failed), so for a cancelled
run GC dates from the journal's last wallTs — the same source
the ledger builds finishedAt from. A terminal run with neither
a ledger record nor a journal wallTs is undated and is never
collected. A kept run stays forever — there is no longer clock.

**What is collected, and what is not.** Collected: the run's
queue entry, its journal file, its work dir (the `workDir`
recorded in the run's input, when one exists under the state
dir — never the state dir itself, never outside it, never under
the archive dir), and its per-run blobs (the RunEntry snap/out/
log paths). After collection the run is un-resumable by design:
no queue entry, no frozen path, no snapshot. NOT collected: the
ledger record is NEVER deleted — the ledger is append-only by
design (BRA-165), and GC appends a `collected` record naming
the run, the archive path, and the reason; frozen closures are
NEVER deleted — they are content-addressed by hash and shared by
every run with the same workflow source, so deleting one could
break another live run (the §D case with two runs sharing one
frozen hash proves the sharing: collect one, the other still
resumes). Only `done`, `failed`, and `cancelled` queue entries
are candidates; `queued`, `running`, and `held` are never
collected, at any age.

**Failure modes.** A corrupt journal or queue entry in the set
refuses the WHOLE run and nothing is deleted (guards before
writes, fail-closed); ledger lines are corrupt-tolerant per the
ledger's own contract (skipped, never fatal). A sweep whose
summary would exceed ~50KB refuses loudly rather than
truncating (the trap cap is ~60KB). A collect or ledger failure
mid-run stops with verdict `failed` and notes naming what was
already collected — a re-run is idempotent (already-collected
runs skip with that reason; the ledger append sees the duplicate
and writes nothing; the finalize removes the leftover queue
entry). Known limits: frozen closures are never deleted (shared,
content-addressed); the human-mark verb (`queue keep`) is a
follow-up; the archive dir is the operator's to prune.
Migration: none — a state dir with no runs past retention
collects nothing, and `agentts run` without `--keep` submits
exactly as before (the flag defaults to false, absent on the
entry).

### 1.22 `library/lead-loop.ts` — leadLoop (the generic lead-loop skeleton, every lead's main entry point)

**What it does.** One generic workflow, configured per lead by
a dispatch table in the run input (data, not code) — not eight
bespoke loops. Per iteration, in order: (1) cancel check (when
a runId is present): read the run's status from
`stateDir/queue.json` in-shell and refuse, writing nothing,
when it is cancelled — check-then-act before advancing any
run; (2) progress check (pull-only): one inline-python trap
reads `queue.json` + the liveness file's collected-run record
and returns one JSON line of FACTS (never decisions) about the
sub-runs this loop submitted (entries with `launchedBy ==
loopId`): queue depth, each sub-run's status, and for held runs
the pending decide's trap id + question from the run's journal
(the brief's "decide step" is a `gate` trap in engine terms —
the gate is the holdable human checkpoint; a `decide` trap is
answered locally by decideLocal and never holds); (3) collect:
for each done sub-run not yet collected, one exec trap reads
its result via `agentts result` (bounded at 48KB — a result
over the bound is recorded as truncated with a pointer, never
pushed through the ~60KB trap cap), and the collected report
becomes the job's result; a cancelled sub-run is terminal,
recorded as refused with the cancellation named, never waited
on; a collected report carrying a
`fileFirst` field files its items to `backlogPath` in the same
iteration (one BACKLOG.md entry per item, idempotent on
re-run; an item with no title is recorded as skipped with the
reason named, in the job outcome and the report's notes, not
dropped); (4) claim (pure): the next job in input order whose
owner is this loop's owner, whose bucket is ready, that has not
been claimed yet, whose result was not already collected in a
prior loop run, and whose kind is not waiting on a sequential
sub-run (a `parallel: false` kind with a submitted-but-
uncollected sub-run waits); jobs for other owners are counted,
not listed; (5) periodic: entries whose cron is due at this
iteration's `now` and not yet run this loop run become
synthetic jobs through the same dispatch + submit path;
(6) dispatch: for each work item, call `dispatchTasks` IN-RUN
with one task (kind = the job's kind, fields built by the table
entry's `inputBuilder`); dispatch's switch is the single source
of truth for kind → workflow, and the loop checks dispatch's
resolution against the table entry's declared `workflow` and
fails the JOB loudly on a mismatch, so the two can never drift
silently — the loop never invokes a workflow from the table
directly; (7) submit: one exec trap invoking the CLI
(`agentts run <workflow> --adapter direct --run-id <id>
--input-file <routed input> --state-dir <stateDir> --owner
<job owner> --launched-by <loopId>`), creating the queue entry
the scheduler drives — the submit passes `--adapter direct`
because sub-runs are real work and the mock adapter's canned
exec results would silently fake success; the routed input is
extracted from dispatch's handoff file, and the submit is
idempotent on the runId (`<loopId>-<jobId>`); (8) parked: when
an iteration claims nothing and nothing periodic is due, cheap
reads (ledger tail, queue depth, `/health` against `serverUrl`
when supplied) instead of idle-spinning, then a `sleep` of
`parkSeconds` (default 60) before the next iteration;
(9) liveness: after each iteration's work, `<stateDir>/liveness/<loopId>.json`
written atomically (chunked base64 write + rename + read-back),
carrying the heartbeat, last-claim timestamp, last report
summary, the submitted-run records, and the collected-run ids.
The Director's supervision check reads this file by loopId; the
queue server's owner/worker last-seen is the other signal. The file
is also the loop's durable cross-shift state: a later loop run
seeds its submitted-run map + collected-run set + collected-run
map (as placeholders — the result lives in the run that
collected it) from it at start, so it attributes a sub-run's
result to the right job and never re-collects it. The report's
`submitted`/`collected` lists and the liveness counters
(`jobsCompleted`, `jobsPending`) are cumulative across loop runs,
computed from those durable sets — a refused job is marked
claimed so the loop moves on to the next job instead of
re-claiming it every iteration. The file is keyed by loopId, not role —
one loop per role, and a replacement loopId for the same role
must not inherit (and be blocked by) the dead loop's record.
The project config passes through verbatim to dispatch and
from there into every routed sub-workflow's input, so it must
satisfy the routed workflows' project schemas —
dependency-mapping's requires `workDir` + `resumeDir`
(supplied by the launcher), and a routed submit is refused at
the CLI schema gate when they are absent.

**Decisions settled by the builder (the brief's decisions
1–4).** (1) Termination: the loop runs until cancelled — the
Director cancels the loop's run, the loop checks the cancelled
flag before advancing and exits cleanly, reporting its final
status; `maxIterations` caps iterations for scratch/test runs.
(2) Liveness location: `<stateDir>/liveness/<loopId>.json`
(loopId from the run input). Keyed by loopId, not role: the
file is the loop's own cross-shift state, and a replacement
loopId for the same role must not inherit (and be blocked by)
the dead loop's record. The Director's supervision check reads
it by loopId (the stable id it launched the loop with).
(3) The dispatch seam — SETTLED: the loop calls dispatch, never duplicates the kind → workflow
lookup; the loop supplies kind per task in dispatch's input
(the ranked queue carries no kind field — the triage kind gap
is a BACKLOG.md item); the table's `workflow` field is the
lead's declared expectation, checked against dispatch's
resolution; after dispatch resolves, the loop submits the
sub-workflow run through the scheduler (dispatch hands the
routing as a handoff file; it never submits). (4) The dispatch
table at boot covers the workflows that exist today; the
acceptance table covers hello + dependency-mapping (two
routable workflows, one flat-input and one file-driven).

**The v0 claim source.** The loop claims from the
launcher-supplied `run.jobs` list, not from the shared run
queue or the ranked queue: run-queue entries are
already-submitted runs (dispatching one would double-execute
it), ranked-queue items carry no kind field, and worker-server
jobs are trap jobs for worker agents (prose specs), not
workflow kinds. The launcher (Director) reads the shared queue
and hands the loop its jobs with kinds attached. The shared run
queue IS where the loop's submissions land and where its
progress check reads. Claiming directly from the shared queue
is a BACKLOG.md follow-up, for when queue items carry kinds.

**What the loop never does.** It never closes an issue, never
merges code, never decides acceptance. A decide step in a
dispatched sub-workflow is answered by the owning lead, never
delegated — the loop surfaces the pending decide and the owner
answers via `deliver-gate`. The verdict is evidence, NOT
acceptance: `completed` means the loop ran its iterations and
exited cleanly, `dry-run` means the plan is clean and nothing
was written, `failed` means the run was refused or every
claimed job failed. Per-job failures are recorded per job + in
notes; the loop never dies for one bad job.

**A dispatch fix rides with this build.** The loop is the
first consumer that SUBMITS a routed run (BRA-176 tested
routing only — the handoff shape, never the submit), and
submitting flushed out a dispatch defect: every two-layer case
built `runId + workDir` and omitted the target workflow's own
required `<id>` field, so the CLI schema gate refused the
routed input. This build fixes the two cases the loop
exercises — dependency-mapping (`mappingId` added, `workDir`
dropped: MappingRunInput has no workDir) and worker-lifecycle
(`lifecycleId` added) — plus the per-case project pick
(`pickProject`: mapping's case picks the full project with
`workDir` + `resumeDir`, every other two-layer case picks the
base project without them) and the loop's `runId` injection
(the task fields always carry `runId` = the submit run id, so
the sub-workflow's cancel check looks its own queue entry up
by it). Regression checks in test-bra176.ts §C and the
lead-loop test §C. The remaining cases (triage, breakdown,
daily-feed, scheduler, merge, verify-fix, gc) carry the same
defect class and are filed as a BACKLOG.md follow-up; only
hello, dependency-mapping, and worker-lifecycle submit today.

**Failure modes.** A validation failure refuses the run with a
failed report, never a throw; a cancelled runId refuses with
`cancelChecked` true + `cancelled` true; a cancel check that
cannot complete (no queue entry / unparsable queue) refuses
with `cancelChecked` false — the loop never advances blind. A
progress check that cannot complete (missing/unparsable queue,
facts over the 48KB bound) refuses the whole run. A filing
entry over 100KB is recorded unfiled rather than written; with
no `backlogPath`, file-first items are recorded unfiled with
the reason named, never dropped silently. Known limits: the
loop claims from the launcher-supplied job list (see the v0
claim source above); a sub-run result over 48KB is recorded as
truncated with a pointer; file-first files to BACKLOG.md in the
complete form while the Linear limit holds; the liveness file
grows with every submitted sub-run (one record each) — rotation
is a follow-up; periodic entries run once per loop run when due
(a due periodic whose synthetic job was already collected is
skipped, a pending one re-submits idempotently); the dead-owner
drill's Director-side half (reassignment via liveness + lease
expiry) is boot validation, not this build. Support files: none
— every trap is inline python/shell or the CLI, so §5 lists
nothing new for this entry. Gate: `check` — this file passes
`agentts check`.

### 1.23 `library/daily-brief.ts` — dailyBrief (the daily report / exec brief workflow, BRA-274)

**What it does.** One workflow, three phases selected by
`run.phase` — one phase per cron, the crons stay as triggers:
`prompt` (05:30), `aggregate` (06:30), `brief` (07:00). The
workflow sends no messages: the `prompt` phase returns one
prompt payload per roster lead (target chat id from
`project.roster`; the message names the 06:00 deadline, the
schema reminder, the reports-dir path, and the rule that a lead
with nothing to say writes a short status and empty lists,
never nothing) and the `brief` phase's report returns the
delivery payload (dated HTML path + must-know line) for the
launcher to send to main chat at 07:00. The `aggregate` phase
reads every lead's daily report JSON from the reports dir plus
the PM's state (goal notes, ledger tail, predictor record,
backlog headings) and derives the aggregation
deterministically, in roster order: decisions-needed is every
`needs_pm` entry, attributed; must-know is the
Director-supplied `run.mustKnow`, else the program-management
report's optional `mustKnow`, else the first decisions-needed
entry rendered as a sentence (recorded as derived in the
aggregation log); risks are every `solutions[].problem`,
attributed; per-lead sections are status + `numbers` as key/value
pairs with a trend arrow per key vs the prior day's report when
present (never raw JSON, never reflections / predictions /
solutions verbatim); the Director's own report is overall state
(first paragraph of the goal notes), what changed (up to 5
most-recent ledger runs + one line per lead whose status changed
since the prior day), and what is next (first 5 backlog headings
+ up to 5 prediction claims). The `aggregate` phase optionally
reads 247's throughput report (`run.throughputReportPath`, one
new validated input) and renders one Throughput card in the HTML:
present renders the section, absent renders without it,
malformed records missing-with-reason and still renders; the
throughput read never blocks the brief. The `brief` phase renders the
dated HTML exec brief from the aggregation with a pure string
builder carrying the Nov 21 template structure (receipt line,
must-know box, decisions box up top, KPI bar, per-lead sections,
risks, the Director's own report, missing-lead sections when
present, footer). Predictor-record scoring is out of this build:
the aggregate reads the predictor record as part of the PM's
state and logs that it was read, but does not score predictions.

**Validation.** All lead-report fields except `lead` and `date`
are optional — an absent optional field is treated as empty,
NOT invalid. Only `lead`/`date` missing, unparsable JSON, a
wrong date (must equal `run.date`), or a wrong type on a field
that IS present counts as invalid. A missing lead report is
noted as missing with the reason named and never blocks the
brief; the receipt line names the missing leads. A missing PM
report does not block either — must-know falls back to the
first decision, and the brief notes the PM report missing. The
roster must be present and non-empty; an empty roster refuses
the whole run before any write. The `brief` phase validates the
aggregation JSON's date matches `run.date` before rendering,
and refuses loudly on a missing or wrong-date aggregation. The
lead-report schema gains optional `mustKnow?: string`, accepted
by the validator on the program-management report only in use (a
`mustKnow` on another lead's report is accepted at schema level,
ignored in derivation, and logged); the skill's daily-report
schema section lists it as optional. Guards run before writes
and fail closed: a null/absent `run` is refused, never
dereferenced; validation failure refuses the run with a failed
report, never a throw.

**I/O.** Reads and writes go through exec traps in the dispatch
pattern (base64 chunks to a temp file, then move/append), never
trap stdout; each file read is its own bounded trap (generic
48KB; lead JSONs and roster 16KB — a file over the bound is
recorded missing-with-reason, the bound named, never silently
truncated into a wrong parse; goal-notes head 8KB; ledger tail
last 20 lines; backlog first 10 `## ` headings); all writes
atomic (temp + rename) where the path is a file the brief owns,
with read-back verification. Never `Buffer` — the host has no
`Buffer`; the pure base64 helper comes from `./dispatch`
(`splitHandoffChunks` / `appendChunkScript` /
`parseWriteSummary`). Cancel is check-then-act: when
`run.runId` is present, the cancel check runs first and a
cancelled run refuses with `cancelChecked: true`. Dry-run:
`prompt` lists the payloads it would emit; `aggregate` lists
the files it would read and the sections it would derive;
`brief` lists the HTML it would write. None writes anything.
Not a decision-maker: nothing in this workflow closes an issue,
merges code, or decides acceptance. Support files: none — every
trap is inline python/shell, so §5 lists nothing new for this
entry. Gate: `check` — this file passes `agentts check`.

### 1.24 `library/land-queue.ts` — landQueue (the landing queue, BRA-261)

**What it does.** The land queue workflow is the queue file's
single writer — it orders the landing queue from the queue file
(`run.queuePath`), which carries `{items, owner, policy, queue,
throughput, updated}`. One queue, one file; the workflow never
closes, merges, or decides acceptance. Ordering: ready first by
`ready_at` ascending, then blocked, then paused, then `pending_qa`
(in Quality — verification done, the verdict outstanding; never ordered
as ready, never demoted), then landed
(kept as history), each bucket by previous `order` then issue;
`order` is reassigned 1..N, so the file on disk IS the ordered
queue. Readiness: an entry is ready only when status is
"ready" AND verification passed AND `ready_at` is non-null; a
"ready" entry with a failed or missing verification transitions
to "blocked" with the reason named in the notes on disk. A
blocked entry with a passing verification stays blocked until a
caller sets status "ready" in an update — the workflow never
promotes on its own, only demotes. Caller updates
(`run.updates?: {issue, verification?, authorization?, status?,
notesAppend?}[]`) apply to matching entries by issue before
ordering; an update naming an unknown issue refuses the run.
`authorization` is the settled `MergeAuthorization` imported
from merge.ts and validated with `validateMergeAuthorization`
when present — never redefined, never a parallel shape. The
workflow accepts both entry shapes the file actually carries:
orders 1–9 with `copies[]` + `parts[]`, and queue-managed
orders with singular `copy` (string), no `parts`, and flat
`authorized_at` — `copies` wins when both are present,
`parts` is optional, `authorized_at` is preserved as-is, every
top-level key is preserved, and the write does NOT fabricate
`parts` and does NOT convert `copy` to `copies`. On write it
adds `verification` and `authorization` (null when absent) and
updates `updated` to `run.now` (or the clock trap when
`run.now` is absent).

**I/O.** Reads/writes go through exec traps in the dispatch
pattern (base64 chunks + temp + rename + read-back, never trap
stdout, never `Buffer` — the pure base64 helper comes from
`./dispatch`). Each file read is its own bounded trap: the
queue-file read bound is **48KB** (the live file is already
19,577 bytes — past the 16KB the brief first stated; a file
over the bound is refused loudly, never truncated). **Rotation.**
When the file at read time is at or over **36KB** (75% of the
bound — the headroom covers one full merge cycle at the burst
growth rate), the workflow rotates landed entries as part of
the run: the 5 most recent landed entries stay (by
`landed_at` descending, then previous `order` descending; a
null `landed_at` sorts as oldest), all older landed entries
move in full to a dated history file
`land-queue-rotated-<YYYYMMDDTHHMMSSZ>.json` in the same
directory (one file per rotation, named for the run's `now`),
and the run records it in `updated`, a top-level `rotation`
record (`rotated_at`, `rotated_by` = "land-queue workflow",
`archived_to`, `archived_count`, `archived_issues`, `note`)
appended to a `rotations` array (an existing singular
`rotation` seeds the array first), and the report's notes.
The history file is written first, then the live file is
re-read immediately before the live write — if the bytes
differ, the whole run refuses loudly and writes nothing to
the live file (the history file already exists; re-run to
retry). A dry-run plans the rotation and names it in the
notes, writing nothing. A file already over the bound still
refuses before any rotation — the rotation does not rescue
it. Cancel is check-then-act: when `run.runId` is present,
the cancel check runs first and a cancelled run refuses with
`cancelChecked: true`. A null/absent run is refused, never
dereferenced. Dry-run orders and writes nothing — the file is
byte-identical after. Predictor-record scoring is out of this
build. Support files: none — every trap is inline python/shell.
Gate: `check` — this file passes `agentts check`.

### 1.25 `library/rebase.ts` — rebaseCopy (bring a copy onto the latest tree, BRA-262)

**What it does.** The rebase is the step before the merge
workflow, not a second merge path — the merge workflow (BRA-159)
stays the one way a copy lands. Every landing rebases first; no
copy merges stale. The three-way diff comes from the merge
workflow's own sparse-diff script (`sparseDiffScript` +
`parseSparseDiff`) — the manifest is read from disk and both
trees are hashed inside one python process, and only the sparse
diff crosses the trap boundary. The copy's changed files come
from `computeChangedFiles` on the sparse maps, each classified
with `classifyMergeFile`. A file both sides changed differently
(action "conflict") is a rebase conflict: the rebase refuses
loudly before writing anything, the conflicting files named,
the copy's manifest byte-identical. Drift is handled honestly —
a conflict stops the landing; the rebase never silently drops a
change to make it apply. A copy change the merge would refuse
for another reason (the baselines file) is NOT a rebase
conflict — the rebase only asks "does the copy apply cleanly
against current live"; the merge refuses baselines at merge
time. On a clean rebase the new manifest is written in-shell: a
python script hashes the live tree with the SAME exclusion set
as the sparse diff and writes `{copiedAt, root, files:
live-hashes}` to a temp file in the copy root, then renames it
onto the copy's manifest — the same format
`record-copy-manifest.sh` writes, with root = the copy root and
copiedAt = the rebase time. Only one summary line (`REBASED
<count> <copiedAt>`) crosses the trap boundary. The write is
verified by re-running the sparse diff: after a clean rebase
every diff entry must have base == live; any entry with base !=
live throws loudly. The rebase is idempotent: when the manifest
already matches live, the run reports "rebased" with the note
"manifest already current" and writes nothing.

**Validation.** The rebase never writes live and never merges.
No tier-1-in-flight guard: the rebase writes only the copy's
manifest, so a suite running against live is unaffected.
Concurrent rebases of the same copy are not guarded: Landing drives
one landing at a time. A missing or unparsable manifest refuses
the rebase (the sparse diff's exit 2 / 3). Cancel is
check-then-act: when `run.runId` is present, the cancel check
runs first and a cancelled run refuses with `cancelChecked:
true`. A null/absent run is refused, never dereferenced.
Dry-run plans the rebase and writes nothing. Support files:
none — every trap is inline python/shell. Gate: `check` — this
file passes `agentts check`.

### 1.26 `library/test-batching.ts` — batchTests (verify a stack passes together, BRA-263)

**What it does.** The batcher verifies a stack of changes
passes together without re-verifying each change from scratch —
one landing verifies the stack, not N landings each re-running
everything. Input: a list of changes (each naming its copy and
its higher-tier suites — tier-2 and/or full suite) plus
`workDir`/`resumeDir`. Each suite runs as the run.sh leaf:
`run.sh --bash --only <slug> --resume-dir <suite-resume-dir>`,
its output redirected to a per-suite log file under
`workDir/logs/` (never through the trap — a full section log
would blow the ~60KB trap cap). The trap prints only two lines:
`RUNSH rc=<n>` and the progress.jsonl section row
(`{"event":"section","section":...,"ok":...,"rc":...}`), which
is the machine-readable verdict (the OK count comes from the
row; a suite with no section row is failed with the reason
named). Suites run sequentially, one at a time: the VM has 1.5
shared CPUs and two run.sh invocations serialize badly.
Per-suite results are recorded incrementally: after each suite
the state file `<resumeDir>/batch-state.json` (`{batchId,
results}`) is re-written atomically (temp + rename) with the
new result appended. A resumed batch (same batchId, same
resumeDir) reads the state and skips every recorded suite —
pass or fail. A recorded failure is a completed suite (run.sh's
own rule: a section whose tests ran and failed is recorded
failed, never retried); retrying a failure is a new batchId. A
change whose copy has no `apps/agentts/run.sh` records each of
its suites failed with the reason named and the batch continues
— a missing copy is a per-change failure, not a whole-batch
refusal. The report carries per-change results (change, suite,
pass/fail, log path) plus the stack verdict: "passed" only when
every suite of every change passed, "failed" naming the first
failing change + suite. A failed change never rides a passing
stack.

**Validation.** The batcher does not edit the queue file; it
returns per-change results for the caller (Landing) to apply. It
does not decide acceptance. A corrupt prior state file refuses
the batch rather than silently re-running. Cancel is
check-then-act: when `run.runId` is present, the cancel check
runs first and a cancelled run refuses with `cancelChecked:
true`. A null/absent run is refused, never dereferenced.
Dry-run plans the batch (changes + suites listed) and writes
nothing — no state file, no logs, no suite runs. Support files:
none — every trap is inline python/shell. Gate: `check` — this
file passes `agentts check`.

### 1.27 `library/throughput-report.ts` — throughputReport (the throughput report, BRA-247)

**What it does.** The alarms' first half: for one day, report
the throughput numbers the Director's counting rule defines —
a task counts when it is completed verified work (a done run
naming the item in the window + a merge report with verdict
"merged"), landings listed separately, nothing double-counted.
The report carries, per queue item in the window, pickup-to-
landed (the COPY CREATION TIME — the copy's manifest `copiedAt`,
falling back to the copy dir's mtime; an item with several copies
takes the earliest creation time — to its landed time),
verify time (the merge report's `suite.elapsedMs` — the tier-1
wall on the merged tree; `typecheck.passed` rides as a pass/fail
fact, not a time), close time (the land-to-close gap, recognized
only as `closed <ISO timestamp>` in the queue notes, else unknown
with the reason named), and build time (the sum of active wall
over the item's done runs — wall minus gate-hold). The totals
carry items in window, tasks completed, landings, the median
pickup-to-landed and median verify time, the done/failed run
counts, the cost of a kill (failed runs' active wall and tokens;
0 when there are no failed runs, null when failed runs exist but
none has a known wall time; tokens null when no failed run
reported any), the skipped ledger lines, the collected records,
and the undated runs. Stalled steps are numbers, never silence:
an item in status ready/blocked/paused whose last movement
(`ready_at`, else the queue file's `updated`) is older than
`run.stalledAfterMs` (default 2h) before `run.now` is listed
with its status named. The audit section carries one observation
per workflow with done runs in the window — the audit's rule
(median of the last 5 done runs, active wall) against the
baselines file's threshold (baseline x 3.0), with the baseline
status present/no-baseline. Machine-down is a verdict, not a
guess: no new runs in the window AND the production server down
(`run.serverUrl` `/health`) — a quiet window with the server up
is a quiet window, named as one; no serverUrl means the check was
skipped and logged. The workflow never restarts the server.

**Sources and joins.** The ledger tail (last 20 lines, byte-
capped at 16KB, header `BTAIL <printed> <total>` so the report
names tail incompleteness instead of silently undercounting),
the audit baselines file (missing is NO-BASELINE, corrupt is
reported, never parsed past), the land queue file (48KB bound;
missing is reported, invalid refuses the run), and the merge
reports (`run.mergeReportPaths`, caller-supplied, in time order;
a report belongs to an item when its mergeId, normalized,
contains the item's normalized issue key; last match wins; a
missing or malformed report is missing-with-reason, never a
refusal). The run→item join attributes build time and window
membership (NOT pickup — pickup is the copy creation time): a run
names an item when the runId's middle
key equals the item's issue key after normalization (`run-bra210c-
accept-real` names BRA-210c and NOT BRA-210 — one token, never
a prefix). A missing source is reported with the reason named,
never a refusal (except a corrupt queue, which refuses — a
corrupt queue must not be parsed past). The report file is
written atomically (chunked base64 + rename + read-back) to
`run.reportPath`.

**Validation.** Guards run before writes and fail closed: a
null/absent `run` is refused, never dereferenced; validation
failure refuses the run with a failed report, never a throw.
Cancel is check-then-act: when `run.runId` is present, the cancel
check runs first and a cancelled run refuses with `cancelChecked:
true`. Dry-run plans the report (counts named) and writes
nothing. Support files: none — every trap is inline python/shell.
Gate: `check` — this file passes `agentts check`.

### 1.28 `library/bottleneck-detect.ts` — detectBottleneck (bottleneck detection + P0 filing, BRA-248)

**What it does.** The alarms' second half: watch the numbers 247
reports, identify the bottleneck, and file a P0 with numbers when
the machine itself is the bottleneck and the P0 bar is met. 248
reads the same sources 247 reads (the ledger tail, the audit
baselines file, the land queue, the merge reports) PLUS 247's
report — it re-derives the decomposition from the sources and
cross-checks it against 247's report when one is supplied
(`run.throughputReportPath`; a mismatch is logged, never fatal).
Per item, pickup-to-landed decomposes into build (sum of active
wall over the item's done runs), verify (the merge report's
`suite.elapsedMs`), and queue-wait (the residual: pickup minus
build minus verify, clamped at 0, the clamp logged). The
bottleneck is the component with the largest MEDIAN share of
pickup-to-landed across the decomposed items: a share of 0.5 or
more names it; below 0.5 no single stage dominates ("none",
reported, not filed); no complete decomposition means "unknown"
(reported, not filed, the reason named). Machine-down overrides:
no new runs in the window AND the production server down — the
bottleneck IS the machine down, share 1.0, every item in the
window blocked. Kinds: "machine-down", "merge" (merge bandwidth),
"queue-wait" (the serial queue / Landing wait), "build" (build/worker
slowness — the slowest workflow, by median active wall, is named
in the filing), "none", "unknown". The P0 bar is Brandon's bar:
ETA saving = bottleneck share x median pickup-to-landed x items
blocked (wall-clock ms); expected saving = probability x ETA
saving (expected value counts for speculative items); the P0
passes when expected saving beats the fix cost (`run.fixCostMs`,
build + verification, one number; `run.fixProbability`, default
1). No fix cost supplied means the bar cannot be evaluated —
reported, not filed, the reason named. A P0 without numbers is
an opinion, not a filing.

**Filing.** While the Linear free-plan limit holds, the goal's
BACKLOG.md is the filing target — a filing there counts as filed
as long as the record is complete and findable (title, priority
P0, estimate in hours from the fix cost, code area, acceptance
criteria, parent BRA-248, source + the numbers). The filing is
written in the breakdown.ts pattern (rendered by a pure function,
chunked base64 to a temp file, appended, read back to verify).
Idempotency: the entry carries a `fleet-ops-p0:
<bottleneck>/<date>` marker. 248 does not file a second P0 for
the same bottleneck while the first is unanswered, and it does
not quietly drop the first one — "unanswered" means the filing
is still present in BACKLOG.md with no `- **Resolved:**` line
recorded under its entry (a human answers a P0 by adding that
line under the entry; the filing itself says so). A filed P0
stops the pass until it is answered — 248 returns the filed/open
P0 in its report; the workflow itself halts nothing — it reports
the stop. 248 never fixes the bottleneck, never takes
implementation work, never sits in the critical path of a build,
never closes, never merges, never decides acceptance. Cancel is
check-then-act: when `run.runId` is present, the cancel check
runs first and a cancelled run refuses with `cancelChecked:
true`. A null/absent run is refused, never dereferenced. Dry-run
plans the filing (would file / would not file + reason) and
writes nothing. Support files: none — every trap is inline
python/shell. Gate: `check` — this file passes `agentts check`.

### 1.29 `library/server-restart.ts` — restartServer (server auto-restart, BRA-245)

**What it does.** The machine stops. The production worker
server goes down, the tick/heartbeat loop stops — and today the
recovery is a person. This workflow makes it automatic: detect
what is down, restart it, verify `/health` answers `ok:true`,
report back. Detection: down = the health check fails (GET
`/health` refused, or answers with `ok` not `true`) OR the tick
is stale (last tick older than `staleMinutes`, default 15, with
pending work — the watchdog's `needsRestart` shape: a dead tick
with nothing pending needs no restart). The workflow reads the
tick state file and the health endpoint directly; it never
constructs a Host for the check. Restart: the standing command
(`bun src/cli.ts worker serve --state-dir <dir> --port <N>`,
detached via nohup, log to `<runs-dir>/server-restart-N.log`),
from the run input's server command / state dir / port (never
hardcoded to production). The spawn is one bounded exec trap;
the trap returns once the process is detached, not once the
server is up. The server's stdout and stderr go to the log file
(not the trap's pipe), so the trap returns promptly. Verify: a
bounded poll of GET `/health` — 30 attempts one second apart
(30s total). Verified = `ok === true` within the budget. Not
verified = reported as not-verified, never as up. One run makes
at most one restart attempt per target; a down server that won't
restart is reported as a failure, loudly — not looped silently,
not reported as up.

Already up: if the server is already up, the workflow verifies
`/health`, reports that it is up, and does NOT restart a running
server. The tick-stale case is governed by the same rule: the
tick-stale trigger fires when `/health` is OK but the tick is
stale with pending work — the server is UP, so no restart
happens. Restarting the server cannot revive the tick agent
anyway: the tick agent beats the server via POST `/tick-beat`
and the server only records `tick/state.json`, so a dead beater
stays dead across a server restart. The tick agent itself is
restarted by its own watchdog cron; the report names that, and
the Director + affected leads are notified (their work is
stuck). The tick-stale restart applies only when the server is
also down — which is already the health-down trigger.

**Trigger.** The workflow runs on a 15-minute cron — the fleet's
cron mechanism drives it, one fresh run-id per invocation (the
exact CLI command is in the workflow header). The cron is
installed by the lead (one-time setup), not by the workflow — a
workflow does not install crons. 15 minutes matches the
`staleMinutes` default: a dead tick is caught within ~15 minutes
of going stale (plus the cron interval).

**Inputs.** `run.serverUrl` (never guessed), `run.stateDir`
(the tick state + queue live under it), `run.engineDir`, `run.
serverCommand` (the full server argv), `run.runsDir`,
`run.staleMinutes?` (default 15), `run.verifyAttempts?`
(default 30), `run.verifyIntervalMs?` (default 1000).
`project.stateDir` is the state dir the run's queue entry lives
in (the cancel check reads it); `run.stateDir` is the monitored
dir — in tests they differ. Reads go through exec traps in the
dispatch pattern, never trap stdout, never `Buffer`. Per-file
read bounds: 48KB generic, 16KB for the tick state. An
over-bound file is recorded missing-with-reason, never truncated
into a wrong parse. The health check is a bounded curl (the
lead-loop's shape), never an unbounded wait.

**Report.** Verdicts: `restarted` (down → restarted →
verified), `verified-up` (already up, verified only — also the
tick-stale verdict, with the trigger named), `no-restart-needed`
(tick dead with nothing pending), `not-verified` (restarted but
`/health` never answered `ok:true`), `failed` (spawn failure,
validation refusal, cancellation), `dry-run`. The report
carries the health state before/after, the tick classification
(alive, lastTickAt, ageMs, pending count, needsRestart), the
restart log path, the verify attempts spent, and the delivery
payloads for the launcher — the Director when a restart
happened or failed (or the tick is stale), one per affected lead
(owner of a pending run) when a restart happened or the tick is
stale. A routine verified-up / no-restart-needed check emits no
payload. The workflow sends no messages. It never closes,
merges, or decides acceptance. Cancel is check-then-act: when
`run.runId` is present, the cancel check runs first and a
cancelled run refuses with `cancelChecked: true`. A null/absent
run is refused, never dereferenced. Dry-run plans the restart
and writes nothing — this workflow writes nothing to disk
itself (the server writes its own log). Gate: `check` — this
file passes `agentts check`.

### 1.30 `library/vm-recovery.ts` — recoverVmReplacement (VM-replacement recovery, BRA-246)

**What it does.** A VM replacement kills the production worker
server mid-run: runs are stranded at "running" in the queue,
journals stop mid-slice, the tick goes dead. This workflow
makes the recovery automatic: detect the replacement, restart
the server, name every interrupted run with its resume point,
and tell the affected leads which of their runs resumed and
which could not. Detection: the workflow keeps a boot-id record
at `<stateDir>/boot-id` — the kernel's boot id
(`/proc/sys/kernel/random/boot_id`), written by this workflow
on real runs. The first run with no record ESTABLISHES it (not
a replacement). A later run whose current boot id differs from
the recorded one IS a replacement. A run whose boot id matches
reports no-replacement and exits (a down server with no
replacement is 245's job). A corrupt recorded id refuses loudly
rather than re-establishing silently. Restart: on a replacement
the workflow restarts the server with 245's helpers (the same
standing command, the same spawn + verify budget) and verifies
`/health` answers `ok:true`. The boot-id record is updated on
DETECTION, before the restart — so a failed restart does not
re-fire detection on the same boot. Resume: the workflow does
NOT drive the queue itself (the driver lock is held by its own
drive) and does NOT execute a full tier-1 inside an exec trap.
It CLASSIFIES each interrupted run and names the resume dir +
resume point; the launcher drives the resumes. The
classification mirrors the engine's `classifyStrandedEntry`
(src/host.ts): journal lifecycle "completed" → finished;
lifecycle "failed" → failed (the error named); registry rc 2/3
+ snapshot blob → resumable via the queue drive; rc 2/3 without
a blob → could-not-resume; rc 0 → finished; rc 1 + blob →
resumable (C-host crash mid-slice); rc 1 without a blob →
could-not-resume; other rc → failed; no registry + trap activity
→ could-not-resume (left for a human — re-driving could
double-execute the dispatched trap); no registry + no trap
activity → resumable (never started). Candidates are the queue
entries stranded at "running". A suite run is one with a
caller-supplied `run.resumeDirs` mapping (runId → resume dir);
its resume point is the first tier-1 section without a `.done/`
marker (from suite-inventory.json + a bounded `.done/`
listing), resumed via `run.sh --resume-dir`. A run with no
resume dir recorded is reported as could-not-resume and its lead
notified, never silently dropped.

**Trigger.** The workflow runs at boot from a systemd user unit
— the unit file is DELIVERED by the workflow to
`<stateDir>/vm-recovery.service` on real runs (idempotent
content, written with the dispatch chunked-write pattern); the
lead enables it once by hand (the workflow never installs
systemd units itself — the exact commands are in the workflow
header and in every report's `trigger` field). The unit runs at
boot: it starts the worker server, waits 2s, runs the 246
recovery workflow via the CLI with the input file
`<stateDir>/vm-recovery-input.json` (written once by the lead),
then drives the queue. The run-id uses the boot id's first 8
characters (unique per boot, no `%` — systemd would try to
expand a date format's specifiers). The 245 watchdog cron
(every 15 min) is the second half of the trigger: a replacement
the unit misses is still caught whenever 246 next runs, because
the boot-id record persists.

**Inputs.** `run.serverUrl`, `run.stateDir`, `run.engineDir`,
`run.serverCommand`, `run.runsDir`, `run.resumeDirs?` (runId →
resume dir, for suite runs), `run.verifyAttempts?` (default
30), `run.verifyIntervalMs?` (default 1000). Reads go through
exec traps in the dispatch pattern, never trap stdout, never
`Buffer`. Per-file read bounds: 48KB generic (queue, suite
inventory), 16KB for the registry entries + boot-id record. The
journal is never read whole: a scan script walks it and prints
one bounded summary line. An over-bound file is recorded
missing-with-reason, never truncated into a wrong parse.

**Report.** Verdicts: `recovered` (replacement + server
verified), `no-replacement`, `established` (first run),
`failed` (including a classification that could not run — the
runs were never named, so a human must look — even when the
server came up), `dry-run`. The report carries the old/new boot
ids, the server block (restarted, verified, health before/after,
restart log path), the resumed / could-not-resume / finished /
failed runs (each with owner, lead, kind, resume dir, resume
point, mechanism, reason), the delivery payloads for the
launcher (the Director when a replacement was detected or the
trigger established; one per affected lead with their runs,
resumed vs could-not-resume vs failed), and the trigger info
(unit path, whether it is enabled, the enable commands, the 245
cron, the input file path). The workflow sends no messages. It
never closes, merges, or decides acceptance. Cancel is
check-then-act: when `run.runId` is present, the cancel check
runs first and a cancelled run refuses with `cancelChecked:
true`. A null/absent run is refused, never dereferenced.
Dry-run writes nothing — not the boot-id record, not the unit
file, and it does not start the server; it still computes the
classification (reads only) and reports what would resume.
Gate: `check` — this file passes `agentts check`.

### 1.31 `library/push.ts` — pushToDev (push manifest + push, BRA-260)

**What it does.** Merges land to the live tree, but the push to
dev is still done by hand — twice so far (post-r1 push,
skill-move push), by the same procedure, each time a person
rebuilding the manifest, verifying files against origin, pushing,
verifying via the GitHub API. This workflow makes it repeatable
and machine-driven: rebuild the push manifest from the dev
baseline, verify every file against origin, push to dev, verify
what landed via the GitHub API, report back with the commit.
Manifest: rebuilt fresh from the dev baseline on every run, never
carried forward — the input is the land queue's order (the queue
entry named by `run.queueIssue`, its `copies` + `order`), the
file list comes from the merge report (`run.mergeReportPath`,
applied + alreadyApplied), the content comes from the live tree
(`run.liveRoot`). One row per file: path, sha256, git blob sha,
status `to-push` / `already-on-dev` (a file whose blob sha
already matches dev's tree is already on dev and is not
re-pushed). The dev baseline is the state of origin's `dev`
branch at manifest-build time — the dev tip commit plus the
(path → blob sha) map from `git ls-tree -r origin/dev`, read
live from the checkout's origin remote after a bounded `git
fetch`, recorded in the manifest as `devTip`; it is not a file
on disk. Verify against origin, before pushing: every file is
read from the live tree and hashed, copied into the checkout,
re-read and re-hashed there — a mismatch (or a missing /
unreadable file) refuses loudly, naming the file, and nothing is
pushed. Push: the to-push files are committed in the checkout
and pushed to origin's `dev` branch. The push runs under Landing's
landing authorization — the merge authorization for the
landing, from the queue entry's `authorization` field else
`run.authorization` — never under a per-push approval from
Brandon. A real push without an authorization refuses before the
push step; a dry-run without one is fine. Verify what landed:
the dev tip must equal the pushed commit, and every file's blob
sha on dev must equal the manifest's — via the GitHub API (`gh
api` first, `curl` with GH_TOKEN / GITHUB_TOKEN from the
environment as fallback; the credential never comes from the
input, is never logged, never in the report), or via the
remote's refs when `verifyViaRefs` is set (fixtures: a local
bare repo as origin — `git ls-remote` for the tip, `git
--git-dir=<remote> show dev:<path>` hashed per file). A push
the API can't confirm is reported as not-verified, never as
landed. Interrupted push: before any push attempt the workflow
re-reads the dev baseline and compares every manifest file's
blob sha against dev's tree — if every file already matches,
the push already landed and the workflow reports already-pushed
(verified) instead of pushing twice; a retry after an
interrupted push runs the same check first, never blind-retry.
Hold: `run.holdPush` reports the hold and stops, checked right
after validation + the cancel check, before any read or write —
a held push pushes nothing and writes nothing. A blocked queue
entry refuses with the failure named (the entry stays in the
file with the failure named — the verdict route carries it).
The queue file is never rewritten by this workflow.

**Trigger.** The workflow runs as the last step of the land
path, after the merge — driven by Landing (the launcher) with the
merge report + the queue entry + a prepared checkout. The
checkout is a git clone of brandf/agentts checked out at `dev`,
prepared by the launcher before driving the workflow: the
workflow validates it (a git work tree, remote origin as
expected, checked out at the branch) and refuses loudly
otherwise. It never clones origin itself and never handles
credentials — the push uses the checkout's own remote /
credential configuration as prepared by the launcher. (There is
no git checkout of agentts on the build VM and `gh` is not
logged in there, so the workflow cannot assume a checkout
exists; in tests the fixture checkout is prepared by the test.)

**Inputs.** `run.pushId`, `run.queuePath`, `run.queueIssue`,
`run.mergeReportPath`, `run.liveRoot`, `run.checkoutPath`,
`run.branch?` (default `dev`), `run.workDir` (the manifest
lives here), `run.holdPush?`, `run.verifyViaRefs?`,
`run.remoteUrl?` (overrides the checkout's origin — fixtures),
`run.authorization?`, `run.commitAuthor?`, `run.dryRun?`,
`run.runId?`, `run.now?`. Reads go through exec traps in the
dispatch pattern, never trap stdout, never `Buffer`. Per-file
read bounds: 48KB generic; the queue entry is extracted by a
script that prints one entry only (the queue file itself is
46KB and growing, so it is never read whole); the dev tree is
read with pathspecs for exactly the manifest files, never the
whole tree. An over-bound file is recorded missing-with-reason,
never truncated into a wrong parse. The GitHub API check is a
bounded `gh` / `curl` call per file, never an unbounded wait.

**Report.** Verdicts: `pushed` (pushed + verified), `already-
pushed` (every file already on dev, verified, nothing pushed),
`held`, `not-verified` (pushed but the API couldn't confirm
what landed), `failed` (validation refusal, blocked entry,
missing authorization, checkout / fetch / commit / push
failure, cancellation), `dry-run`. The report carries the
manifest (path + entries with hashes + statuses), the commit,
the dev tip, the verification (route, tip confirmed, per-file
confirmation), the authorization carried verbatim, and the
delivery payloads for the launcher (Landing + the Director — a
dry-run emits none). The workflow sends no messages. It never
merges, never closes, never decides acceptance. Cancel is
check-then-act: when `run.runId` is present, the cancel check
runs first and a cancelled run refuses with `cancelChecked:
true`. A null/absent run is refused, never dereferenced.
Dry-run plans the push and writes nothing — no manifest, no
commit, no push, no delivery payloads. Gate: `check` — this
file passes `agentts check`.

### 1.32 `library/dual-report.ts` — dualReportVerdict (dual-report verification, BRA-256)

**What it does.** On Nov 20 a FAIL verdict sat unrouted ~5 hours
because routing was a chat message. This workflow is the verdict
route in the commit mechanism: re-verify a fixed item end to end
and dual-report the verdict to the owning lead's chat AND to the
Director in the same run — never only in Quality's own chat, never by
a chat message that can sit unrouted. Re-verification: the
test-batching workflow (BRA-263) driven in-run as a child run
via the `run` trap (one BatchChange per item — changeId the item
key, copyRoot the scratch tree containing the fix, suites the
item's tier-1 section slugs; the child's workDir/resumeDir live
under the parent's workDir). The verdict is taken from the
child's report: stackPassed → PASS; a failing suite → FAIL with
the suite + the failure named (from the child's failingSuite +
the suite log's tail, last 20 lines, bounded); a child-run throw
(the batch itself couldn't run) → unable-to-verify with the
reason named. The report carries the item, the verdict (PASS /
FAIL / unable-to-verify), the per-suite results (suite, passed,
ok, logPath, note), the failing suite when one failed, the
failing log's tail, and the batch id. A FAIL names the failure
so the owning lead can act on it without asking Quality for the
detail. No owning lead: a verdict for an item with no owning
lead (run.owningLead absent, or absent from the roster) still
goes to the Director — never only to Quality's own chat; the
Director is the fallback recipient, and the report records that
the owning-lead payload was not produced and why. Unable to
verify: a re-verification that can't run (the tree is absent, a
suite is not a registered tier-1 section in the tree) is still
reported — as unable-to-verify with the reason named — not
silently dropped; the payloads are still produced, because the
verdict IS the report. The workflow never files a bug (257) and
never packages a handoff (253) — it reports the verdict; the
filing and the handoff are separate workflows.

**Trigger.** The workflow runs when Quality re-verifies a fixed item
— driven by Quality (the launcher) with the item key, the owning
lead's role, the suites to run, and a scratch tree containing
the fix. The tree is a scratch copy, never the live tree.

**Inputs.** `run.reportId`, `run.itemKey`, `run.itemTitle?`,
`run.owningLead?` (a roster role, e.g. `implementation`),
`run.suites` (tier-1 section slugs, in run order), `run.copyRoot`
(the scratch tree containing the fix), `run.workDir` (the child
batch lives under it), `run.dquicktsPath?`, `run.dryRun?`,
`run.runId?`, `run.now?`. Reads go through exec traps in the
dispatch pattern, never trap stdout, never `Buffer`. Per-file
read bounds: 48KB generic; the suite inventory is read by an
extraction script that prints the tier-1 slugs only; the
failing log's tail is the last 20 lines only. An over-bound
file is recorded missing-with-reason, never truncated into a
wrong parse.

**Report.** Verdicts: `PASS`, `FAIL`, `unable-to-verify`,
`dry-run`, `failed` (validation refusal, cancellation). The
report carries the item, the verdict, the per-suite results,
the failing suite + failing log tail when one failed, the
reason when unable-to-verify, the batch id, the delivery
payloads for the launcher (the owning lead's chat + the
Director — Director-only when there is no owning lead, recorded;
a dry-run emits none), and whether the owning-lead payload was
produced. The workflow sends no messages. It never merges,
never closes, never decides acceptance. Cancel is
check-then-act: when `run.runId` is present, the cancel check
runs first and a cancelled run refuses with `cancelChecked:
true`. A null/absent run is refused, never dereferenced.
Dry-run plans the re-verification and writes nothing — no
batch, no payloads. Gate: `check` — this file passes `agentts
check`.

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
| `library/consequence-rank.ts` | Consequence-led ranking for the briefing judge: `combinedScore = consequence*10 + topicScore`, `rankByConsequence`; must-read ranking for read papers: `rankReads` / `compareReads` (combined orders; numbers, then fullText, then id are tiebreaks only; an unjudged read throws loudly). Pure functions; the judge's verdicts are combined with keyword topic scores here. | §1.3 (briefing workflow, judge step + must-read) |
| `library/pool-promotion.ts` | Abstract-informed pooling supplement for briefing discovery (BRA-124 remaining): `selectAbstractFetch` (most recent 150 title-low fresh candidates, most recent first) and `selectSupplement` (top 8 by abstract score ≥ 7, never a pool paper). Pure functions; the supplement adds to the judge's input and displaces nobody — displacement was measured to eject three judged-top-8 papers on the real Nov 18 data. Known limit: TPHC (ascore 7, rank #21) and Gemma (ascore 4, rank #67) are NOT promoted. | §1.3 (briefing workflow, discover second pass + judge step) |
| `dogfood/bugfix-worker.ts` | Worker process for the five `bugfix-*` specs (reproduce / diagnose / fix / test / verify), real under direct, `simulate: true` under mock (imported by the mock adapter). | §1.4 |
| `dogfood/briefing-worker.ts` | Worker process for the five `briefing-*` specs (live arXiv fetches, real scoring/extraction). | §1.3 (via briefing adapter) |
| `dogfood/briefing-prep.ts` | Scratch setup run via an exec trap: copies the live seen list + HTML builder into the run's scratch dir (read-only; the live files are never written). | §1.3 |
| `dogfood/briefing-prior-work.ts` | Data: the prior-work index (`PRIOR_WORK`) the briefing workflow passes to its relate jobs. Imported by §1.3, so it IS in the frozen closure. | §1.3 |
| `library/improve-loop.INTEGRATION-TEST.md` | Manual runbook for the real-engine improve-loop run (not a workflow). | §1.2 |
| `scripts/triage-rank.ts` | The triage workflow's rank step (BRA-210): reads the fetched Linear issues JSON + GOAL.md from disk, ranks with `library/triage.ts`'s pure helpers, renders the drift note, writes the dated queue + stable queue + drift note atomically (temp file + rename), self-verifies by re-reading the queue, and prints a one-line JSON summary. Lives under `scripts/`, not `workflows/`, because it is invoked by path from the workflow's rank trap. | §1.14 |
| `scripts/daily-feed-publish.ts` | The daily-feed workflow's publish step (BRA-252): reads the ranked queue JSON + the dependency graph JSON + GOAL.md from disk, builds the feed with `library/daily-feed.ts`'s pure helpers, writes the dated feed + stable feed atomically (temp file + rename), self-verifies by re-reading the feed, and prints a one-line JSON summary. Lives under `scripts/`, not `workflows/`, because it is invoked by path from the workflow's publish trap. | §1.17 |
| `scripts/scheduler-reassign.ts` | The scheduler workflow's reassign step (BRA-160): POSTs `/reassign-run` to the worker-server URL, writes the full response to a file atomically (temp file + rename), and prints a one-line JSON summary. The response itself never crosses a trap boundary. Exit 0 = the server answered ok, 1 = the server refused, 2 = unreachable or malformed. Lives under `scripts/`, not `workflows/`, because it is invoked by path from the workflow's reassign trap. | §1.18 |
| `scripts/worker-lifecycle.ts` | The worker-lifecycle workflow's lifecycle step (BRA-213): calls the worker-server endpoint for the operation (POST `/register-worker`, GET `/workers`, POST `/close-worker`), writes the full response to a file atomically (temp file + rename), and prints a one-line JSON summary. The response itself never crosses a trap boundary. Exit 0 = the server answered ok, 1 = the server refused, 2 = unreachable or malformed. Lives under `scripts/`, not `workflows/`, because it is invoked by path from the workflow's lifecycle trap. | §1.19 |
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
