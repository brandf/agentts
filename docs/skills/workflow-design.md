# Workflow-design skill — best practices from our own learning and intent

**Status:** 2026-11-16, grounded in the code in this repo and the
design record in Linear. This is the JUDGMENT skill — the companion
to the HOW-TO skill, [`agentts-usage.md`](agentts-usage.md)
(BRA-69). The usage skill teaches what each trap does and how to run
one; this skill teaches what belongs where, and why, from what we
actually built and learned. It is not generic advice: every rule
below traces to a mechanism in the code, a real run, or a recorded
decision. Where a rule is design intent rather than built behavior,
it is labeled **INTENT — NOT BUILT** in the first sentence, with the
source issue named. Where the code and an older write-up disagree,
the code wins — see "Known disagreements" at the end.

**Rule of this skill:** if you cannot verify a practice against the
design record or a real run, leave it out or label it unverified.
Do not invent practices we have not learned.

## 1. Trap inputs/outputs — inline vs. by reference

### The rule

- **Inline** (directly in a trap arg/result): small structured data
  the workflow branches on or validates. It is JSON,
  schema-validated, and journaled in full.
- **By reference**: bulk or slowly-changing content, as
  **(location + hash/version) — never a bare path**. The trap arg
  stays small, the journal stays lean, and the worker reads the
  referenced content once.

### Why inline is small — the mechanisms

Three mechanisms enforce it, and each is in the code:

1. **The JSON boundary.** Every trap arg passes through
   `toJsonValue()` (`packages/durablets/src/agentts.ts`) before it
   dispatches. Only clean JSON crosses; a `Date` crosses as its ISO
   string and nothing else gets converted. There is no streaming or
   lazy channel past a trap — what you put in the arg is what
   crosses, in full, every time.
2. **The journal holds the full arg.** Every `trap` event journals
   its arg in full (`apps/agentts/src/host.ts`; verified live
   2026-11-16 in the JudgeFixLoop branch journals — the `judge`
   trap event carries the complete `{ spec, input: { item, rubric,
   judge } }`). A 50 KB document pasted into a job input is 50 KB
   in the journal, on every trap that carries it, forever. The
   journal is append-only and is the source of truth; it never gets
   compacted.
3. **The profiler shows a summary, not the full arg — correction to
   the issue text.** BRA-70's description says inline data is
   "journaled in full — the profiler shows it." That is half right:
   the journal holds it in full, but the profiler (`src/profiler.ts`,
   `summarizeArg`) shows only `spec=<name>` for a job, the question
   truncated to 120 characters for a gate/decide, `ms=<n>` for a
   sleep. So: put in the arg only what you need the workflow to
   branch on or validate, and what you are willing to have
   permanently in the journal. The profiler will not rescue you
   from a bloated arg — it hides the bloat; the journal keeps it.

### What goes inline — with real examples

- **The numbers a decision branches on.** The JudgeFixLoop decide
  questions carry `mean score X threshold Y` and `misses: N …
  if misses >= M` inline in the question string
  (`workflows/library/judge-fix-loop.ts`, `workflows/dogfood/daily-ai-briefing.ts`).
  That is not decoration: the local decision model
  (`src/decision-model.ts`) can only parse signals that are in the
  question text. A decide question without its numbers inline is a
  question the model cannot answer — it falls back to the first
  option at confidence 0.5 (verified live; see the usage skill
  §2.1).
- **Small verdicts and scorecards the workflow reduces.** The
  aggregate steps take `verdicts: JudgeVerdict[]` / `scorecards:
  Scorecard[]` inline (`workflows/library/judge-fix-loop.ts`,
  `workflows/library/improve-loop.ts`) because the workflow itself counts,
  averages, and dedupes them. The aggregate input is bounded (3
  judges, 2 scorecards) and structured — exactly the shape inline
  is for.
- **Small control fields:** loop counters, round numbers, judge
  indices, thresholds, flags like `failed: number`. The improve-loop
  `FixInput` carries the decision and the aggregated feedback inline
  because the fix worker needs both to act, and both are small.
- **The output contract's scalar summary.** A job result should
  carry its verdict as structured fields (`score`, `label`,
  `meanScore`, `approved`, `failed`, `converged`), not only as
  prose — the workflow branches on those fields, and the profiler's
  `summarizeResult` surfaces exactly those scalars (`choice=` /
  `conf=` for decide, `mean=` / `approved=` / `failed=` /
  `score=` / `label=` / `loops=` / `converged=`).

### What goes by reference — and the shape of a reference

Bulk content (a document's full text, a rubric file, a seen list,
a PR, a commit) goes by reference as **(location + hash/version)**.
Two built examples:

- **Rubric by file.** `improve-loop.ts` accepts a rubric as
  `Rubric | { file: string }` and resolves it with
  `resolveRubric()`: one `exec` `cat` trap reads the file, parses
  the JSON, validates the shape (`criteria` array + numeric
  `threshold`), and throws loudly on a malformed file rather than
  judging against a rubric that is not there. The workflow reads
  the referenced content once, at the point of use, and carries the
  small parsed rubric inline from then on.
- **Seen list by copy.** The briefing workflow (`workflows/dogfood/
  daily-ai-briefing.ts`) dedupes against a **copy** of the seen list
  in scratch (`SEEN_COPY = ${SCRATCH}/seen-copy.md`, made by the
  prep exec step) — not the live list. The copy is the version pin:
  the run's dedupe set cannot change mid-run because the live list
  is only ever read, never the input.

**Never a bare path.** A reference without a hash is ambiguous:
the content can change mid-run. That is the same hazard as the G9
no-frozen-copy gap — and G9 is the right analogy, with one update:
**G9 itself is closed for workflow source** (BRA-71 froze the
workflow closure, so editing a workflow mid-run cannot change what
the run executes — see `ARCHITECTURE.md` §3.2). But there is **no
frozen copy for referenced work-item content**. The host freezes
your workflow; it does not freeze the file your workflow points
at. So the discipline G9 taught — freeze what a run depends on —
is one you must apply yourself to references: carry the hash in the
input, verify it at read time, fail loudly on mismatch.

Verified live 2026-11-16 (scratch workflow `ref-demo.ts`, direct
adapter — see the usage skill §9):

```ts
export interface DocRef { location: string; sha256: string; }
export interface RefDemoInput { doc: DocRef; }

// in the workflow: read the file, hash it, compare, throw on mismatch
const content = exec({ cmd: "cat", args: [input.doc.location] });
const sum = exec({ cmd: "sha256sum", args: [input.doc.location] });
if (sum.stdout.split(" ")[0] !== input.doc.sha256)
  throw new Error(`hash mismatch for ${input.doc.location}`);
// → { verified: true, chars: 45, location: "/tmp/bra69-70-skills/doc.txt" }
```

The pattern to copy: **reference = `{ location, sha256 }`** (or
`{ location, version }` for a versioned store — a commit SHA, a PR
number plus its head SHA, a content hash, never a bare path or a
bare "latest"). Read it once at the point of use, verify the hash,
throw on mismatch. If the content is small enough to inline and the
workflow branches on it, inline it instead — a reference that is
read, verified, and then inlined as parsed data is the normal shape
(the rubric above is exactly that).

### Checklist for a trap arg

1. Can the workflow branch on or validate every field? If a field
   is only ever passed through to the worker, it is a candidate for
   a reference.
2. Is any field bulk text, a file, or slowly-changing content? Move
   it to a `(location + hash)` reference.
3. Does the reference carry its hash/version? A bare path is a bug
   — the content can change mid-run and nothing will tell you.
4. Does the worker read the referenced content once? If two traps
   need the same bulk content, read it once and pass the small
   parsed result between them — do not re-pass the bulk content
   through a second trap arg.

## 2. Jobspecs vs. work-item info — the reusable how vs. the specific what

### The rule

**If it is true for every item the job processes, it belongs in the
jobspec. If it is specific to one item, it belongs in the input.**

### What a jobspec is (built behavior)

A jobspec is a prose file, one per spec, named `<spec>.md` in
`apps/agentts/plugins/muse/jobspecs/` (see `_template.md` and
`judge.md`). It is the reusable **how**: what one instance of the
job produces from its input, what "done" looks like, the input
shape field-by-field, numbered steps a competent worker can follow
without asking, the exact rules, thresholds, and edge cases, and
the exact output shape. It is prose about the work, not about the
tools — the worker adapts it to its own environment.

The built mechanisms that make a jobspec stable, versioned, and
institutional:

- **Hash-cached, read once per worker session (on change).** The
  pool server resolves the jobspec prose file at enqueue and
  records its path + sha256 (`specPath`, `specHash`) on the job
  (`src/worker-server.ts`, `specMeta()`; `src/worker-protocol.ts`).
  A job with no spec file proceeds from spec name + input — the
  spec file is authoritative when present, not required. Workers
  fetch the spec only when its hash changed since they last cached
  it (`plugins/muse/worker-loop.ts`, `ensureSpec()` — content-
  addressed cache under the worker's `.spec-cache/`; `GET
  /jobspec?spec=<spec>` serves text + hash). Verified live
  2026-11-16: `GET /jobspec?spec=judge` returned hash
  `14ee7811…`, identical to `sha256sum` of the file; an unknown
  spec returns `{"error":"no jobspec file for \"nonexistent-spec\""}`.
  Subagent workers follow the same rule by hand (`plugins/muse/
  WORKER.md`: "Read the jobspec **only if its hash changed**").
- **Learnings write back into it — that is how experience becomes
  institutional.** Every jobspec ends with `## Notes (learnings
  from workers — append, don't rewrite)`, and workers post
  learnings with `POST /note {"spec", "workerId", "text"}`,
  which appends to the server's `notes/<spec>.md`
  (`src/worker-server.ts`). `WORKER.md` states it plainly:
  "Your learnings are institutional. … Affinity makes you the
  specialist; notes make the experience [carry over]." A worker
  that learned something and did not write it back has not
  finished the job — the next worker will re-learn it.
- **Idempotency is declared in the spec.** A spec declares
  `<!-- idempotency: non-idempotent -->` when a re-queued attempt
  is NOT safe to re-run (side effects: sent something, published,
  charged, wrote outside its own workspace). On lease expiry such
  a job FAILS instead of re-queuing, so the coordinator/human
  decides. Omit the line (or write `idempotent`) and the job
  re-queues as before — the default is idempotent
  (`worker-server.ts`, `specMeta()`; `_template.md`).
- **The jobspec also carries the quality bar.** `judge.md` does not
  say "score well" — it says per criterion, then averaged
  (weighted), with the exact word lists, the 25-word conciseness
  bound, the +0.05-per-revision-marker rule capped at 0.98, and the
  label rule (`"approved"` when score ≥ threshold). A worker that
  has to guess the input shape or the bar will guess wrong — that
  is why the template insists on naming the shapes and the exact
  rules.

### One honest correction to the issue text

BRA-70's description says the jobspec "carries the output
contract/schema." In the code, the jobspec `.md` carries the output
shape **in prose** (the `## Output` JSON block), but the machine-
enforced output contract is the workflow's extracted TypeScript
type: the host validates each trap result against the extracted
schema and throws a `ValidationError` at the call site on a wrong
shape (`_template.md` says exactly this: "The host validates the
result against the workflow's type for this trap"). So: the jobspec
and the workflow's output type must agree, and when they disagree
the type wins at runtime — the worker did the work, the result was
rejected, and the work is wasted. Keep the two in sync when you
change either; a jobspec edit that changes the output shape without
the matching type change is a latent failure, not an improvement.

### Applying the rule — real examples

- **Judge weighting lives in the jobspec; the item lives in the
  input.** `judge.md`: "Judges differ: each weights one criterion
  double — judge 0 weights 'vivid', judge 1 weights 'concrete',
  judge 2 weights 'concise'." That is true for every item the judge
  scores, so it is in the spec. The item text, the goal, and the
  judge index travel in the input (`{ item, rubric, judge }`).
- **The scoring method lives in the jobspec; the criteria live in
  the input when they vary per run.** The improve-loop rubric
  (criteria + threshold) is per-run **input**
  (`ImproveLoopInput.rubric`), because the rubric varies per run —
  even though it shapes judging. What is stable across runs — how
  to score a criterion once you have it, how to dedupe findings,
  how to filter nits when severe findings exist — lives in the
  improve jobspecs and in the mock/real worker implementations,
  which mirror each other exactly. If you find yourself copying the
  same paragraph into every input, it belongs in the jobspec. If
  you find yourself editing the jobspec for one item, it belongs in
  the input.
- **The fix worker's limits live in the jobspec/worker, not the
  workflow.** The improve-loop fix appends addressing sentences
  rather than rewriting prose, and cannot fix `"concise"` by
  appending — that is a property of the fix job, recorded in the
  workflow header and the jobspecs, and the loop reports it
  honestly as outstanding instead of pretending to improve.

### Checklist for a new job spec

1. Copy `plugins/muse/jobspecs/_template.md`. One file per spec,
   named `<spec>.md`.
2. Write the `## What this job does` paragraph first: one instance,
   one output, what "done" looks like.
3. Name the input shape field-by-field and the exact output shape.
   Then check the workflow's `Input`/`Output` types agree with
   both — the host enforces the types, not the prose.
4. Put every rule, threshold, and edge case in `## How to do it`.
   Deterministic beats clever: the same input should give the same
   output from any worker.
5. Declare idempotency explicitly when the job has side effects.
6. When a worker learns something, append it to `## Notes` via
   `POST /note` — do not rewrite the spec's rules in the note.

## 3. Decisions and the cascade

### 3.1 What is built today — the local decision model

The decision machinery in the code is the `decide` trap plus the
local decision model (`apps/agentts/src/decision-model.ts`,
`decideLocal`) — and, since BRA-47, `decisionCascade` in the
`agentts` module (§3.3), which tiers exec → decide → job → gate.
The model itself is a narrow, rule-based signal parser — neither
Jev nor Strands Decider is wired in — and it returns
`{ choice, confidence }`. Signals, in order: mean/score
vs. threshold; misses vs. threshold; keyword scoring; first option
at confidence 0.5 when there is no parseable signal. The fallback
is journaled visibly (a `trap-result` event like any other), never
silent. Verified live 2026-11-16: a signal question (`mean score
0.9 threshold 0.8`) returned `{ choice: "keep", confidence: 0.65 }`
— 0.55 + the 0.1 margin; a signal-free question returned the first
option at 0.5. See the usage skill §2.1 for the full signal table.

### 3.2 When to use decide vs. job vs. gate (built behavior)

| Tool | Use it when | Do not use it when |
| --- | --- | --- |
| `decide` | The question carries a machine-readable signal inline (a mean score vs. a threshold, a miss count vs. a threshold) and the answer is one of a small set of options. Convergence / keep-or-revise / rubric update-or-keep in JudgeFixLoop; the briefing's must-read ratification. Cheap, deterministic, no agent session. | Anything needs judgment, reading, or weighing. A decide question with no signal returns the first option at 0.5 — a guess wearing a confidence number. |
| `job` | Judgment is needed: reading findings, weighing trade-offs, producing or revising content, multi-step work. The improve-loop's fix-or-stop step is a `job` (`improve-decide`) precisely because the rubric threshold is advisory and the decision must come from the findings. A full agent is a `job`, not a `decide`. | The question is already answered by a number in the workflow. Spawning an agent to compare two numbers is waste; worse, it is non-deterministic where the model is deterministic. |
| `gate` | A human must decide, and the run must wait for them. Human answers are authoritative and terminal (see §3.3). The bug-fix workflow deliberately has **no** runtime gate — its fix is the issue's prescribed option and human review is post-hoc — which is the right call when the decision is already made and the human's job is verification, not choice. | You want a cheap check. A gate holds the run indefinitely (exit 2, `gate-held` in the journal) until a human answers with `deliver-gate`. Never use a gate as a polling mechanism or a default branch. |

Two grounding runs for this table:

- **Briefing must-read (decide, correctly narrow).** The workflow
  ranks papers by a computed score, then asks `decide` with the top
  two paper IDs as options. The ranking is the real decision; the
  decide trap records it. The workflow header is explicit that the
  v0 model "ratifies the score-ordered leader (it cannot reason
  over paper IDs)". If the ranking were wrong, the decide trap
  would not save it — and the journal would show the trap ratified
  a bad ranking, which is the honest record.
- **Bug-fix JFL (advisory, not a gate).** The judging loop's
  outcome is recorded, not enforced: when BRA-54 was live it
  looped 6 times unconverged under mock and converged at loop 1
  under direct; today the reproduce step reports `already-fixed`
  and the run ends before the loop (verified 2026-11-17, mock
  run, `jflLoops: 0`). Acceptance comes from the test and verify
  job results. A loop outcome is not a decision unless you make
  it one — and making it one means writing the branch that acts
  on it.

### 3.3 The cascade — BUILT (BRA-47)

`decisionCascade(spec)` is built and tested (BRA-47,
"Decision shape and decisionCascade helper",
https://linear.app/brandf/issue/BRA-47/decision-shape-and-decisioncascade-helper
— implemented 2026-11-16; `packages/durablets/src/agentts.ts`
and its verbatim host copy `apps/agentts/src/agentts.ts`, §
"decision cascade"; tests `apps/agentts/tests/test-bra47.ts`,
10 scenarios, green in `run.sh`). It is a workflow-side helper
in the `agentts` module, **not** a core builtin or trap —
ordinary code built on traps, testable with the mock plugin.
The plugin journals every attempt, so the escalation path is
visible audit evidence.

- **Canonical Decision shape:** `Decision { choice, confidence
  0–1, tier, question, options, attempts }`, in the `agentts`
  module. It is the shared result shape across exec, decide, job,
  and gate when they are used as decisions. Not all gates/jobs/
  execs are decisions — the shape is a convention for
  decision-use, not a constraint on the trap type. A gate used as
  a decision tier returns confidence 1.0 (a human answer is
  authoritative and terminal).
- **Cascade order (cheap to expensive):** `exec` → `decide` →
  `job` → `gate`. `decisionCascade(spec)` runs one decision spec
  (question, options, optional context, optional exec command)
  through the tiers, with the same inputs at every tier.
- **Stop rule:** stop at the first tier at or above its threshold.
  The threshold lives in the spec, possibly per-tier
  (`spec.thresholds.exec/decide/job`, falling back to
  `spec.threshold`).
- **Escalation:** escalate on low confidence, abstention, or
  error — to the next tier, and ultimately to a human.
- **Per-tier thresholds:** confidence is not comparable across
  tiers. A decision model's 0.8 is calibrated; an agent's
  self-reported 0.8 is less so. Thresholds are therefore per-tier,
  in the spec — there is no single global threshold to tune, and
  **no default threshold anywhere in the code**: a tier with no
  threshold in the spec fails loudly before any trap fires. **No
  threshold numbers exist anywhere in the record.** This skill
  invents none: the only calibrated numbers in the codebase are
  the local model's own self-reported confidences (0.55 + margin
  capped at 0.99 for score signals, 0.8 for misses, 0.55 for
  keyword scoring, 0.5 for the no-signal fallback) — those are
  the model's outputs, not cascade thresholds, and must not be
  quoted as thresholds.
- **Tier contracts.** `exec`: the spec's exec command must print
  exactly one JSON object `{ choice, confidence }` on stdout —
  free text is not a decision (unparseable stdout is an
  abstention); a non-zero exit is an error; the choice must be
  one of the options and confidence in [0, 1]. `decide`: the
  decide trap (the local model), same choice/confidence checks —
  the model never abstains; its no-signal fallback (first option
  at 0.5) escalates by the threshold, not by abstention. `job`:
  always the `"decision"` jobspec (a literal — the extractor
  requires a literal spec, so the cascade takes no
  caller-supplied jobspec name); the agent's answer must carry
  its self-reported confidence as a structured output field
  (`{ choice, confidence, reason? }`), which the cascade reads —
  it never infers a confidence. `gate`: the human's answer maps
  to `{ choice: answer, confidence: 1.0, tier: "gate" }`,
  accepted verbatim even when it is not one of the options.
- **Context reaches only the job tier** (a structured input
  field). `DecideSpec` and `GateSpec` have no context channel, so
  the exec/decide/gate tiers receive the question and options
  exactly as written — fold any context those tiers need into the
  question text.
- **What the result records:** the deciding tier AND the full
  attempt history — one entry per tier evaluated, in order, up to
  and including the deciding tier (a tier with no exec command is
  recorded `skipped`, not omitted), each with its result or its
  escalation reason. A cascade result that names only the winning
  tier hides the escalation path; the audit value is the path.
- **Extraction note:** the extractor excludes the `agentts`
  module, so a `decisionCascade(...)` call in a workflow
  synthesizes the four tier sites from the module's own types
  (`extract.ts`). Consequence of the shared keys: a workflow that
  calls `decisionCascade` AND a direct `decide<Other>` (or a
  direct `job<"decision">` with different types) hits the usual
  one-key-one-contract extraction conflict — keep direct
  decide/job calls in a cascade workflow on the cascade's types
  (`DecideTierResult` / `DecisionJobInput` / `DecisionJobResult`).

### 3.4 What to do now that BRA-47 has landed

Use `decisionCascade` — it is the tiered decision. Hand-roll
tiering in workflow code only when the cascade does not fit (a
different tier order, a tier the cascade does not have, a
decision that is not question + options), and keep it visibly
tiered, following the cascade's own shape (`Decision` with its
attempt history) so the result reads the same way:

1. **Try the cheap tier first in plain code.** An `exec` that can
   answer the question from data already on disk (a computed score,
   a file's existence) is tier one. If it answers, record the
   answer and the tier in your result type and stop.
2. **Then `decide`, with the signal inline** (§1, §3.2). If the
   model returns low confidence (0.5 fallback, or a keyword guess
   at 0.55), treat that as "this tier abstained" and escalate —
   do not branch on a 0.5-confidence choice as if it were a
   decision.
3. **Then `job`.** An agent's answer should carry its own
   confidence in the result type you define — and remember the
   intent: an agent's self-reported 0.8 is less calibrated than the
   model's 0.8, so do not compare them on one scale.
4. **Then `gate`.** A human answer ends the cascade. Do not put a
   gate in a loop that can re-ask it; a held gate blocks the run
   until delivered.
5. **Record the deciding tier + attempt history in your result
   type.** Each trap you call is already journaled with its full
   arg and result, so the attempt history exists in the journal —
   but the *result* should name the deciding tier explicitly (the
   cascade's `Decision` does this: `tier` + `attempts`), because
   the consumer of the result should not have to read the journal
   to learn which tier decided.
6. **Escalation for terminal failure is built, and it is separate
   from the cascade.** A failed run delivers its error with
   `needsAttention: true` (`deliver-result` outbox), and `agentts
   escalate '<json>'` writes an escalation record (`gate-held` |
   `stuck-running` | `other`) for a human. That is the escalation
   path for a failed run; cascade escalation (low confidence →
   next tier) is the cascade's own, in §3.3.

### 3.5 Claims about decisions this skill does NOT make

- No per-tier threshold values (none exist in the record).
- No claim that the cascade has been run beyond its tests: it is
  covered by `tests/test-bra47.ts` (10 scenarios, green in
  `run.sh`), not by a production run.
- No claim about Jev or Strands Decider behavior — neither is
  wired in; the only decision code is the rule-based parser in
  `decision-model.ts` plus the cascade in the `agentts` module.
- No claim that `decide` confidence is comparable to a job's
  self-reported confidence — the record says the opposite.

## Sources read for each section

- §1: `packages/durablets/src/agentts.ts` (`toJsonValue`,
  JSON boundary rule), `apps/agentts/src/host.ts` (journal
  events, full trap arg), `apps/agentts/src/profiler.ts`
  (`summarizeArg`, `summarizeResult`), `workflows/library/judge-fix-loop.ts`,
  `workflows/library/improve-loop.ts` (`resolveRubric`),
  `workflows/dogfood/daily-ai-briefing.ts` (seen-copy), `docs/audits/
  robustness-2026-11-16.md` (G9), `apps/agentts/tests/test-bra71.ts`
  (G9 closed by BRA-71).
- §2: `apps/agentts/plugins/muse/jobspecs/_template.md`,
  `jobspecs/judge.md`, `apps/agentts/src/worker-server.ts`
  (`specMeta`, `POST /note`, `GET /jobspec`),
  `apps/agentts/src/worker-protocol.ts` (`specPath`/`specHash`),
  `apps/agentts/plugins/muse/worker-loop.ts` (`ensureSpec`),
  `apps/agentts/plugins/muse/WORKER.md` (hash-change reads,
  institutional learnings), `workflows/library/worker.ts`
  (improve-* implementations mirroring the jobspecs).
- §3: `apps/agentts/src/decision-model.ts`,
  `packages/durablets/src/agentts.ts` (the `Decision` shape +
  `decisionCascade`, BRA-47 — implemented 2026-11-16),
  `apps/agentts/tests/test-bra47.ts` (10 scenarios, green in
  `run.sh`), Linear BRA-47 (implemented — cascade built behavior,
  §3.3), `workflows/dogfood/daily-ai-briefing.ts` (must-read ratification),
  `workflows/dogfood/workflow-bugfix-bra54.ts` (advisory JFL),
  `workflows/library/improve-loop.ts` (decide-as-job, advisory threshold),
  `apps/agentts/src/host.ts` (`recordDelivery`,
  `needsAttention`).

## Known disagreements (code wins)

- **BRA-70's description says "the profiler shows it" for inline
  data journaled in full.** The profiler shows a truncated summary
  (`spec=<name>`, question ≤ 120 chars); the full arg is in the
  journal file. §1 follows the code and says so.
- **BRA-70's description says the jobspec "carries the output
  contract/schema."** The jobspec carries the output shape in
  prose; machine enforcement is the workflow's extracted TypeScript
  type. §2 follows the code and says so.
- **BRA-70's description frames the G9 no-frozen-copy gap as a
  live hazard.** For workflow source it is closed (BRA-71 froze
  the closure). The live hazard is the *analogous* one for
  referenced work-item content, which has no frozen copy — §1
  follows the code and draws the line there.
- **The two Google Docs were not consulted.** The Skills and Process
  Ideation doc and the Workflow Engine Build Plan live in Google
  Docs, not in this repo, and were not read for this write-up
  (same evidence standard as `ARCHITECTURE.md` §14). Any place
  where those docs describe a different system is a place where
  the docs are out of date, not the code.
