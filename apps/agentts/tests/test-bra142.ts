#!/usr/bin/env bun
/**
 * Unit tests for workflow-library pure functions (Linear BRA-142).
 *
 * The unit layer for the workflow library was empty — every function
 * below was tested only through a workflow run. These are direct
 * in-process calls: no engine, no adapter, no clock, no CLI, no
 * server. Exit 0 on PASS, 1 on any mismatch.
 *
 * Two honest boundaries, pinned here rather than papered over:
 *  - resolveTextBlob's FILE form calls an `exec` trap, so it cannot
 *    run in-process: outside a run it throws `ReferenceError: trap
 *    is not defined` before `cat` ever runs. The file form's success
 *    path (cat reads for real) and its missing-file path ("could not
 *    read rubric file ... (exit N)") are covered only through
 *    workflow runs (tests/test-rubric-review.ts). The unit layer
 *    pins the boundary: inline works in-process, file needs a run.
 *  - workflows/library/worker.ts is a worker PROCESS, not an
 *    importable module: its scoring functions close over the
 *    module-level argv payload, and importing it would run the
 *    top-level dispatch (unknown spec -> exit 2). The direct call
 *    surface for its scoring IS the process entry point — `bun
 *    worker.ts '<json {spec, input}>'` — which is exactly how the
 *    direct adapter invokes it. Section E calls that entry point
 *    directly (no adapter, no engine, no workflow run) and asserts
 *    on the JSON it prints. No refactor was made to worker.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { diagnosePhaseReview } from "../workflows/library/diagnosis";
import { decideLocal } from "../src/decision-model";
import { resolveTextBlob, resolveTextRubric } from "../workflows/library/judge-fix-loop";
import { planWaves, splitExecuted, type PlanPhase } from "../workflows/library/plan-driven-work";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKER = path.join(ROOT, "workflows", "library", "worker.ts");

const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}
function ok(msg: string): void {
  console.log(msg);
}
function check(cond: boolean, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function throwsWith(fn: () => unknown, re: RegExp, msg: string): void {
  try {
    fn();
    fail(`${msg} — expected a throw, got none`);
  } catch (e: any) {
    check(re.test(e?.message ?? String(e)), `${msg} (got: ${e?.message ?? String(e)})`);
  }
}

function close(a: number, b: number, msg: string): void {
  check(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, expected ${b})`);
}

// ------------------------------------------------------- §A diagnosePhaseReview
console.log("\n=== §A diagnosePhaseReview ===");

{
  // Converged: no diagnosis — including a false pass, where a
  // vacuous criterion approves evidence that does not satisfy it.
  // The loop cannot see a false pass (v0 limit, documented in
  // diagnosis.ts); catching vacuous criteria is the rubric side's
  // job, not this module's.
  const d = diagnosePhaseReview({
    evidence: "fox",
    acceptance: "the",
    loops: 1,
    converged: true,
    finalMeanScore: 0.98,
    threshold: 0.8,
  });
  check(d === null, "A CONVERGED OK: a converged review gets no diagnosis (null) — even a false pass");
}
{
  const d = diagnosePhaseReview({
    evidence: "",
    acceptance: "Write the quarterly report",
    loops: 2,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work"]) && (d?.reasons[0] ?? "").includes("no evidence at all"),
    "A NO-EVIDENCE OK: no evidence -> work only, reason names the absence",
  );
}
{
  // Thin AND on-subject: the evidence shares the acceptance's
  // content word "write", so only the work level fires.
  const d = diagnosePhaseReview({
    evidence: "Write fox crossed",
    acceptance: "Write the quarterly report",
    loops: 1,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work"]) && (d?.reasons[0] ?? "").includes("(3 word(s))"),
    "A THIN OK: 3 words of evidence -> work only, reason cites the word count",
  );
}
{
  const d = diagnosePhaseReview({
    evidence: "The quarterly report is ready for review today",
    acceptance: "Write the quarterly report",
    loops: 1,
    converged: false,
    finalMeanScore: 0.5,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work"]) && (d?.reasons[0] ?? "").includes('key term "write"'),
    "A MISSING-KEY-TERM OK: evidence without the acceptance's first word -> work only, reason names the term",
  );
}
{
  const d = diagnosePhaseReview({
    evidence: "Write the quarterly report with all numbers checked",
    acceptance: "Write the quarterly report",
    loops: 2,
    converged: false,
    finalMeanScore: 0.7,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work"]) &&
      (d?.reasons[0] ?? "").includes("final mean 0.7 < threshold 0.8 after 2 loop(s)"),
    "A BELOW-THRESHOLD OK: evidence addresses the key term but the score stays below threshold -> work only, reason cites mean/threshold/loops",
  );
}
{
  const d = diagnosePhaseReview({
    evidence: "The quarterback threw a touchdown pass on Sunday",
    acceptance: "Write the quarterly report",
    loops: 1,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work", "workflow"]) &&
      (d?.reasons[1] ?? "").includes("write, quarterly, report"),
    "A WRONG-SUBJECT OK: evidence shares no content word with the acceptance -> work + workflow, reason names the acceptance's content words",
  );
}
{
  const d = diagnosePhaseReview({
    evidence: "The quarterly report is ready for review today",
    acceptance: "",
    loops: 1,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    (d?.levels ?? []).includes("rubric") && (d?.reasons[d.levels.indexOf("rubric")] ?? "").includes("empty"),
    "A EMPTY-CRITERION OK: empty acceptance -> rubric fires, reason names the emptiness",
  );
}
{
  const d = diagnosePhaseReview({
    evidence: "The quarterly report is ready for review today",
    acceptance: "Report",
    loops: 1,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    (d?.levels ?? []).includes("rubric") &&
      (d?.reasons[d.levels.indexOf("rubric")] ?? "").includes('single word ("Report")'),
    "A SINGLE-WORD OK: single-word acceptance -> rubric fires, reason names the word",
  );
}
{
  const d = diagnosePhaseReview({
    evidence: "The quarterly report is ready for review today",
    acceptance: "The report is complete",
    loops: 1,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    (d?.levels ?? []).includes("rubric") &&
      (d?.reasons[d.levels.indexOf("rubric")] ?? "").includes('stopword "the"'),
    "A STOPWORD-FIRST OK: stopword-first acceptance -> rubric fires, reason names the stopword",
  );
}
{
  // All three at once: wrong subject AND uncheckable criterion.
  const d = diagnosePhaseReview({
    evidence: "The quarterback threw a touchdown pass on Sunday",
    acceptance: "the quarterly report",
    loops: 2,
    converged: false,
    finalMeanScore: 0.5,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work", "workflow", "rubric"]) &&
      d!.reasons.length === 3 &&
      d!.fixRouting.length === 3,
    "A THREE-LEVEL OK: wrong subject + stopword-first criterion -> all three levels, in fixed order, with one reason and one fix routing per level",
  );
}
{
  // "(revised N)." markers are loop artifacts, not work product —
  // stripped before measuring thinness, or a one-word evidence
  // would read as five words after two loops. The one real word is
  // the acceptance's key term, so only the work level fires.
  const d = diagnosePhaseReview({
    evidence: "(revised 1). (revised 2). write",
    acceptance: "Write the quarterly report",
    loops: 2,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work"]) && (d?.reasons[0] ?? "").includes("(1 word(s))"),
    "A REVISED-MARKERS OK: '(revised N).' markers are stripped before measuring thinness (1 real word, not 5)",
  );
}
{
  // Empty evidence is a work failure, not a wrong-subject failure:
  // the workflow level needs non-empty evidence.
  const d = diagnosePhaseReview({
    evidence: "",
    acceptance: "Write the quarterly report",
    loops: 1,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work"]),
    "A EMPTY-NO-WORKFLOW OK: empty evidence -> work only, never workflow",
  );
}
{
  // An acceptance with no content words at all ("the fix": a
  // stopword + a 3-letter word) cannot trigger the workflow level —
  // there is no content word to share — but the rubric level fires.
  const d = diagnosePhaseReview({
    evidence: "The quarterly report is ready for review today",
    acceptance: "the fix",
    loops: 1,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    same(d?.levels, ["work", "rubric"]),
    "A NO-CONTENT-WORDS OK: acceptance with no content words -> rubric, never workflow",
  );
}
{
  // fixRouting is parallel to levels: each level carries where its
  // fix belongs.
  const d = diagnosePhaseReview({
    evidence: "The quarterback threw a touchdown pass on Sunday",
    acceptance: "Write the quarterly report",
    loops: 1,
    converged: false,
    finalMeanScore: 0.4,
    threshold: 0.8,
  });
  check(
    (d?.fixRouting[0] ?? "").includes("re-execute or deepen") &&
      (d?.fixRouting[1] ?? "").includes("fix the step that produced the evidence"),
    "A FIX-ROUTING OK: work routes to re-executing the phase, workflow routes to the step that produced the evidence",
  );
}

// ------------------------------------------------------- §B decideLocal
console.log("\n=== §B decideLocal ===");

{
  const r = decideLocal("loop 1: mean score 0.9 threshold 0.8; 3 of 3 approved. Should the work item be revised or kept?", [
    "revise",
    "keep",
  ]);
  check(r.choice === "keep", "B ABOVE-THRESHOLD OK: mean 0.9 >= threshold 0.8 -> keep");
  close(r.confidence, 0.65, "B ABOVE-THRESHOLD-CONF OK: confidence 0.55 + 0.1 margin = 0.65");
}
{
  const r = decideLocal("loop 1: mean score 0.6 threshold 0.8; 1 of 3 approved. Should the work item be revised or kept?", [
    "revise",
    "keep",
  ]);
  check(r.choice === "revise", "B BELOW-THRESHOLD OK: mean 0.6 < threshold 0.8 -> revise");
  close(r.confidence, 0.75, "B BELOW-THRESHOLD-CONF OK: confidence 0.55 + 0.2 margin = 0.75");
}
{
  const r = decideLocal("loop 1: mean score 0.8 threshold 0.8; 2 of 3 approved. Converged?", ["converged", "continue"]);
  check(
    r.choice === "converged" && r.confidence === 0.55,
    "B BOUNDARY OK: mean == threshold counts as at threshold -> converge side, confidence 0.55 (zero margin)",
  );
}
{
  const r = decideLocal("score 0.9 threshold 0.8 — accept or revise?", ["accept", "revise"]);
  check(
    r.choice === "accept",
    "B GENERIC-SCORE OK: the bare 'score X threshold Y' form follows the same rule as 'mean score'",
  );
}
{
  const r = decideLocal("loop 3: misses: 3 missed criteria across judges; update the rubric if misses >= 2. Should the rubric be updated or kept?", [
    "update",
    "keep",
  ]);
  check(
    r.choice === "update" && r.confidence === 0.8,
    "B MISSES-ABOVE OK: misses 3 >= 2 -> update, confidence 0.8",
  );
}
{
  const r = decideLocal("loop 3: misses: 1 missed criteria across judges; update the rubric if misses >= 2. Should the rubric be updated or kept?", [
    "update",
    "keep",
  ]);
  check(
    r.choice === "keep" && r.confidence === 0.8,
    "B MISSES-BELOW OK: misses 1 < 2 -> keep, confidence 0.8",
  );
}
{
  const r = decideLocal("The draft is good and ready to pass review.", ["ship it", "hold it"]);
  check(
    r.choice === "ship it" && r.confidence === 0.55,
    "B KEYWORD-POSITIVE OK: positive keywords (good, ready, pass) -> the affirmative-side option at confidence 0.55 (a guess, and the confidence says so)",
  );
}
{
  const r = decideLocal("The draft is bad with missing sections and weak evidence.", ["ship it", "hold it"]);
  check(
    r.choice === "hold it" && r.confidence === 0.55,
    "B KEYWORD-NEGATIVE OK: negative keywords (bad, missing, weak) -> the negative-side option at confidence 0.55",
  );
}
{
  const r = decideLocal("What should we do about the widget?", ["alpha", "beta"]);
  check(
    r.choice === "alpha" && r.confidence === 0.5,
    "B NO-SIGNAL OK: a question with no parseable signal falls back to the first option at confidence 0.5",
  );
}
{
  const r = decideLocal("Is this good?");
  check(
    r.choice === "yes" && r.confidence === 0.55,
    "B DEFAULT-OPTIONS OK: no options given -> [yes, no], and the positive keyword picks yes",
  );
}
{
  const r = decideLocal("loop 1: mean score 0.9 threshold 0.8. Pick one.", ["alpha", "beta"]);
  check(
    r.choice === "alpha",
    "B NO-MATCH-ABOVE OK: no option matches the converge pattern -> falls back to the first option",
  );
}
{
  const r = decideLocal("loop 1: mean score 0.6 threshold 0.8. Pick one.", ["alpha", "beta"]);
  check(
    r.choice === "beta",
    "B NO-MATCH-BELOW OK: no option matches the revise pattern -> falls back to the last option",
  );
}

// ------------------------------------------------------- §C resolveTextBlob / resolveTextRubric
console.log("\n=== §C resolveTextBlob / resolveTextRubric ===");

{
  check(
    resolveTextBlob("hello rubric") === "hello rubric",
    "C INLINE OK: an inline string passes through unchanged",
  );
}
{
  throwsWith(
    () => resolveTextBlob(""),
    /rubric text is empty \(inline rubric\)/,
    "C EMPTY-INLINE OK: an empty inline rubric throws loudly",
  );
}
{
  throwsWith(
    () => resolveTextBlob("   "),
    /rubric text is empty \(inline rubric\)/,
    "C WHITESPACE-INLINE OK: a whitespace-only inline rubric throws loudly",
  );
}
{
  const r = resolveTextRubric("some text", 0.8);
  check(
    r.text === "some text" && r.threshold === 0.8,
    "C RUBRIC-INLINE OK: resolveTextRubric returns the text with the threshold alongside it",
  );
}
{
  // The threshold is a separate numeric input, never parsed from
  // the prose — even when the prose mentions a number.
  const r = resolveTextRubric("threshold 0.9 in the prose", 0.8);
  check(
    r.threshold === 0.8,
    "C THRESHOLD-SEPARATE OK: a number in the prose does not change the threshold (0.8, not 0.9)",
  );
}
{
  // The file form calls an exec trap: outside a run there is no
  // host to suspend to, so the trap call itself throws before cat
  // ever runs. Pin the boundary, not the success path.
  try {
    resolveTextBlob({ file: "/tmp/bra142-does-not-exist.md" });
    fail("C FILE-NEEDS-RUN OK: a file reference outside a run should throw, got none");
  } catch (e: any) {
    check(
      e instanceof ReferenceError && /trap/.test(e?.message ?? ""),
      `C FILE-NEEDS-RUN OK: a file reference outside a run throws ReferenceError naming the trap (got: ${e?.message ?? String(e)})`,
    );
  }
}
{
  try {
    resolveTextRubric({ file: "/tmp/bra142-does-not-exist.md" }, 0.8);
    fail("C RUBRIC-FILE-NEEDS-RUN OK: a file rubric outside a run should throw, got none");
  } catch (e: any) {
    check(
      e instanceof ReferenceError && /trap/.test(e?.message ?? ""),
      "C RUBRIC-FILE-NEEDS-RUN OK: resolveTextRubric delegates to resolveTextBlob, so its file form throws the same way",
    );
  }
}

// ------------------------------------------------------- §D planWaves / splitExecuted
console.log("\n=== §D planWaves / splitExecuted ===");

function ph(name: string, dependsOn: string[] = []): PlanPhase {
  return { name, description: `Do ${name}`, acceptance: `${name} is done`, kind: "agent", dependsOn };
}
function waveNames(waves: PlanPhase[][]): string[][] {
  return waves.map((w) => w.map((p) => p.name));
}

{
  check(same(planWaves([]), []), "D WAVES-EMPTY OK: no phases -> no waves");
}
{
  check(
    same(waveNames(planWaves([ph("a")])), [["a"]]),
    "D WAVES-SINGLE OK: one phase with no dependencies -> one wave",
  );
}
{
  check(
    same(
      waveNames(planWaves([ph("a"), ph("b", ["a"]), ph("c", ["b"])])),
      [["a"], ["b"], ["c"]],
    ),
    "D WAVES-CHAIN OK: a linear chain -> one phase per wave, in dependency order",
  );
}
{
  check(
    same(
      waveNames(planWaves([ph("a"), ph("b", ["a"]), ph("c", ["a"]), ph("d", ["b", "c"])])),
      [["a"], ["b", "c"], ["d"]],
    ),
    "D WAVES-DIAMOND OK: a diamond -> the middle two share one wave",
  );
}
{
  // Independent phases run in one wave, in plan order (stable).
  check(
    same(waveNames(planWaves([ph("c"), ph("a"), ph("b")])), [["c", "a", "b"]]),
    "D WAVES-PARALLEL OK: independent phases share one wave, in plan order",
  );
}
{
  throwsWith(
    () => planWaves([ph("a"), ph("a")]),
    /duplicate phase name "a"/,
    "D WAVES-DUPLICATE OK: a duplicate phase name fails loudly",
  );
}
{
  throwsWith(
    () => planWaves([ph("a", ["a"])]),
    /phase "a" depends on itself/,
    "D WAVES-SELF OK: a self-dependency fails loudly",
  );
}
{
  throwsWith(
    () => planWaves([ph("a", ["z"])]),
    /phase "a" depends on unknown phase "z"/,
    "D WAVES-UNKNOWN OK: a dependency on an unknown phase fails loudly",
  );
}
{
  throwsWith(
    () => planWaves([ph("a", ["b"]), ph("b", ["a"])]),
    /contain a cycle among: a, b/,
    "D WAVES-CYCLE OK: a dependency cycle fails loudly, naming the phases in it",
  );
}
{
  const r = splitExecuted([ph("a"), ph("b", ["a"]), ph("c", ["b"])], undefined);
  check(
    same(r.executed.map((p) => p.name), ["a", "b", "c"]) && same(r.deferred, []),
    "D SPLIT-ALL OK: no executeThrough -> everything executes, nothing deferred",
  );
}
{
  const r = splitExecuted([ph("a"), ph("b", ["a"]), ph("c", ["b"])], "b");
  check(
    same(r.executed.map((p) => p.name), ["a", "b"]) && same(r.deferred, ["c"]),
    "D SPLIT-MID OK: executeThrough 'b' -> [a, b] execute, ['c'] deferred",
  );
}
{
  const r = splitExecuted([ph("a"), ph("b", ["a"]), ph("c", ["b"])], "c");
  check(
    same(r.executed.map((p) => p.name), ["a", "b", "c"]) && same(r.deferred, []),
    "D SPLIT-LAST OK: executeThrough the last phase -> everything executes",
  );
}
{
  throwsWith(
    () => splitExecuted([ph("a"), ph("b", ["a"])], "z"),
    /executeThrough names unknown phase "z"/,
    "D SPLIT-UNKNOWN OK: executeThrough naming an unknown phase fails loudly",
  );
}
{
  // An executed phase may only depend on executed phases — a phase
  // whose dependency is deferred could never run.
  throwsWith(
    () => splitExecuted([ph("b", ["a"]), ph("a")], "b"),
    /executed phase "b" depends on deferred phase "a"/,
    "D SPLIT-DEFERRED-DEP OK: an executed phase depending on a deferred phase fails loudly",
  );
}

// ------------------------------------------------------- §E worker scoring (direct process calls)
console.log("\n=== §E worker scoring (direct process calls) ===");

/** Run the worker process directly — `bun worker.ts '<json>'` —
 * exactly how the direct adapter invokes it, minus the adapter.
 * Returns the parsed JSON from the last stdout line plus the exit
 * code and stderr. */
function workerRun(spec: string, input: unknown): { out: any; err: string; code: number } {
  const res = Bun.spawnSync(["bun", WORKER, JSON.stringify({ spec, input })]);
  const stdout = res.stdout.toString().trim();
  const last = stdout.split("\n").filter(Boolean).pop() ?? "";
  return { out: last ? JSON.parse(last) : null, err: res.stderr.toString(), code: res.exitCode };
}

const JFL_RUBRIC = { criteria: ["vivid", "concrete", "concise"], threshold: 0.8 };
const ALL_ADDRESSED = "The fox crossed the stone road in the bright morning light.";
const VIVID_MISSING = "The fox crossed.";

{
  const { out } = workerRun("judge", { item: { text: ALL_ADDRESSED, goal: "" }, rubric: JFL_RUBRIC, judge: 0 });
  check(
    out.score === 0.98 && out.label === "approved" && out.notes === "vivid: addressed; concrete: addressed; concise: addressed",
    "E JUDGE-ALL OK: all three criteria addressed -> score 0.98 (the cap, never 1.0), approved",
  );
}
{
  const { out } = workerRun("judge", { item: { text: VIVID_MISSING, goal: "" }, rubric: JFL_RUBRIC, judge: 0 });
  check(
    out.score === 0.5 && out.label === "weak" && out.notes === "vivid: missing; concrete: addressed; concise: addressed",
    "E JUDGE-PARTIAL OK: vivid missing, the rest addressed -> 0.5 (judge 0 doubles vivid: 2 of 4), weak",
  );
}
{
  const { out } = workerRun("judge", {
    item: { text: "The fox crossed. (revised 1).", goal: "" },
    rubric: JFL_RUBRIC,
    judge: 0,
  });
  check(
    out.score === 0.55,
    "E JUDGE-NUDGE OK: one revision marker nudges the score +0.05 (0.5 -> 0.55) — revisions genuinely improve the text",
  );
}
{
  // Judges differ: each weights one criterion double. The same
  // text scores 0.5 from judge 0 (vivid doubled) and 0.75 from
  // judge 1 (concrete doubled) — independent judges, not identical
  // copies.
  const j0 = workerRun("judge", {
    item: { text: "The fox crossed the stone road.", goal: "" },
    rubric: JFL_RUBRIC,
    judge: 0,
  }).out;
  const j1 = workerRun("judge", {
    item: { text: "The fox crossed the stone road.", goal: "" },
    rubric: JFL_RUBRIC,
    judge: 1,
  }).out;
  check(
    j0.score === 0.5 && j1.score === 0.75,
    "E JUDGE-WEIGHTS OK: judge 0 scores 0.5 and judge 1 scores 0.75 on the same text — each doubles a different criterion",
  );
}
{
  const { out } = workerRun("fix", {
    item: { text: "A plain sentence here.", goal: "g" },
    rubric: JFL_RUBRIC,
    verdicts: [{ score: 0.33, label: "weak", notes: "vivid: missing; concrete: missing; concise: addressed" }],
  });
  check(
    out.text ===
      "A plain sentence here. (revised 1). The fox's russet coat flashed golden in the morning light. It was the third morning the fox had crossed the stone road." &&
      out.goal === "g",
    "E FIX-MISSED OK: the fix appends one sentence per missed criterion (vivid, concrete) plus the revision marker, and keeps the goal",
  );
}
{
  // Concision comes from tightening, not adding — a concise-only
  // miss gets the marker and nothing else.
  const { out } = workerRun("fix", {
    item: { text: "A plain sentence here.", goal: "g" },
    rubric: JFL_RUBRIC,
    verdicts: [{ score: 0.66, label: "weak", notes: "vivid: addressed; concrete: addressed; concise: missing" }],
  });
  check(
    out.text === "A plain sentence here. (revised 1).",
    "E FIX-CONCISE OK: a concise-only miss gets the revision marker and no appended sentence",
  );
}
{
  const { out } = workerRun("aggregate", { verdicts: [{ score: 0.5 }, { score: 0.9 }], failed: 0, threshold: 0.8 });
  check(
    out.approved === 1 && out.failed === 0 && out.meanScore === 0.7 && out.summary === "1 approved, 0 failed, mean 0.7",
    "E AGG-SCORES OK: score verdicts reduce to a mean (0.7) with the count above threshold (1 approved)",
  );
}
{
  const { out } = workerRun("aggregate", {
    verdicts: [{ ok: true }, { ok: false }, { ok: true }],
    failed: 0,
    threshold: 0.8,
  });
  check(
    out.approved === 2 && out.failed === 1 && out.summary === "2 approved, 1 failed" && out.meanScore === undefined,
    "E AGG-OUTCOMES OK: outcome-shaped verdicts ({ok}) count ok/failed instead of reducing to a mean",
  );
}
{
  const { out } = workerRun("aggregate", { verdicts: [], failed: 0, threshold: 0.8 });
  check(
    out.approved === 0 && out.meanScore === 0 && out.summary === "0 approved, 0 failed, mean 0",
    "E AGG-EMPTY OK: no verdicts -> mean 0, nothing approved",
  );
}
{
  const { out } = workerRun("aggregate", {
    verdicts: [
      {
        score: 0.5,
        guidedAnswers: [
          { question: 2, answer: "theme A" },
          { question: 1, answer: "ignored Q1" },
        ],
        openFeedback: "free one",
      },
      {
        score: 0.9,
        guidedAnswers: [
          { question: 2, answer: "theme A" },
          { question: 2, answer: "theme B" },
        ],
        openFeedback: "free two",
      },
    ],
    failed: 0,
    threshold: 0.8,
  });
  check(
    same(out.openFeedbackThemes, ["theme A", "free one", "theme B", "free two"]),
    "E AGG-THEMES OK: open-feedback themes are the Q2 answers plus free-form feedback, deduped first-seen (Q1 ignored, the repeated theme A appears once)",
  );
}

const IMPROVE_RUBRIC = {
  criteria: [
    { name: "vivid", description: "Use vivid language." },
    { name: "concrete", description: "Give concrete details." },
  ],
  threshold: 0.8,
};
const IMPROVE_ITEM = { content: "A vivid, golden example brings the point to life." };

{
  const { out } = workerRun("improve-judge", { item: IMPROVE_ITEM, rubric: IMPROVE_RUBRIC, judge: 0 });
  check(
    out.summary === "judge 0: 1 of 2 axes addressed (weighted mean 0.67)" &&
      same(out.axisScores, [
        { criterion: "vivid", score: 1, note: "addressed" },
        { criterion: "concrete", score: 0, note: "not addressed" },
      ]) &&
      out.findings[0].severity === "nit" &&
      out.findings[1].severity === "major",
    "E IMPROVE-JUDGE-0 OK: judge 0 doubles vivid -> weighted mean 0.67; an addressed axis is a nit, a missed axis is a major",
  );
}
{
  const { out } = workerRun("improve-judge", { item: IMPROVE_ITEM, rubric: IMPROVE_RUBRIC, judge: 1 });
  check(
    out.summary === "judge 1: 1 of 2 axes addressed (weighted mean 0.33)",
    "E IMPROVE-JUDGE-1 OK: judge 1 doubles concrete -> weighted mean 0.33 on the same item (independent judges)",
  );
}
{
  // The full chain, fed with real judge outputs: two parallel
  // judges -> scorecards -> aggregate -> decide.
  const sc0 = workerRun("improve-judge", { item: IMPROVE_ITEM, rubric: IMPROVE_RUBRIC, judge: 0 }).out;
  const sc1 = workerRun("improve-judge", { item: IMPROVE_ITEM, rubric: IMPROVE_RUBRIC, judge: 1 }).out;
  const agg = workerRun("improve-aggregate", { scorecards: [sc0, sc1] }).out;
  check(
    same(agg.findings.map((f: any) => f.id), ["finding-concrete"]) &&
      agg.dropped.length === 3 &&
      same(
        agg.dropped.map((d: any) => d.reason).sort(),
        ["duplicate", "duplicate", "nit filtered: higher-severity findings present"].sort(),
      ) &&
      agg.meanScore === 0.5 &&
      agg.summary === "1 findings, 3 dropped, mean 0.5",
    "E IMPROVE-AGGREGATE OK: duplicate findings drop (2), nits filter when a major exists (1) -> only the major survives; mean 0.5 over the two scorecards",
  );
  const dec = workerRun("improve-decide", { aggregated: agg }).out;
  check(
    dec.needsFix === true &&
      same(dec.fixes, [
        {
          findingId: "finding-concrete",
          action: 'Address the "concrete" criterion: Give concrete details.',
        },
      ]) &&
      dec.reason === "1 finding(s) need fixes: finding-concrete",
    "E IMPROVE-DECIDE-MAJOR OK: a surviving major finding needs a fix, and the fix is the finding's suggestion",
  );
  const fixed = workerRun("improve-fix", {
    item: IMPROVE_ITEM,
    rubric: IMPROVE_RUBRIC,
    decision: dec,
    aggregated: agg,
  }).out;
  check(
    fixed.item.content ===
      "A vivid, golden example brings the point to life. (revised 1). In 2026, 3 pilot teams ran this process end to end." &&
      fixed.changes.length === 1 &&
      fixed.changes[0].round === 0 &&
      fixed.changes[0].findingId === "finding-concrete",
    "E IMPROVE-FIX OK: the fix appends the concrete sentence plus the revision marker, and records the change at round 0",
  );
}
{
  // Nits only: nothing severe, so nothing is filtered and no fix
  // is needed.
  const allAddressed = { content: "A vivid, golden example with 3 concrete details." };
  const sc0 = workerRun("improve-judge", { item: allAddressed, rubric: IMPROVE_RUBRIC, judge: 0 }).out;
  const sc1 = workerRun("improve-judge", { item: allAddressed, rubric: IMPROVE_RUBRIC, judge: 1 }).out;
  const agg = workerRun("improve-aggregate", { scorecards: [sc0, sc1] }).out;
  const dec = workerRun("improve-decide", { aggregated: agg }).out;
  check(
    same(agg.findings.map((f: any) => f.id), ["finding-vivid", "finding-concrete"]) &&
      dec.needsFix === false &&
      same(dec.fixes, []) &&
      dec.reason === "no blocking/major findings — no fixes needed",
    "E IMPROVE-NITS-ONLY OK: all-nit findings are kept (nothing severe to filter them) and the decide is no-fix",
  );
}
{
  // "concise" cannot be fixed by appending (appending makes text
  // longer) — it is skipped, no change recorded.
  const { out } = workerRun("improve-fix", {
    item: { content: "Some content here." },
    rubric: IMPROVE_RUBRIC,
    decision: {
      needsFix: true,
      fixes: [{ findingId: "finding-concise", action: "Tighten it." }],
      reason: "x",
    },
    aggregated: {
      findings: [{ id: "finding-concise", criterion: "concise", severity: "major", detail: "d", suggestion: "Tighten it." }],
      dropped: [],
      meanScore: 0,
      summary: "x",
    },
  });
  check(
    out.item.content === "Some content here." && same(out.changes, []),
    "E IMPROVE-FIX-CONCISE OK: a concise fix is skipped — the content is unchanged and no change is recorded",
  );
}
{
  const { out } = workerRun("judge", {
    item: { kind: "rubric", text: "Coverage: every dimension is scored. Anchored scores: 0, 5 and 10 are defined." },
    rubric: { criteria: [], threshold: 0.8 },
    judge: 0,
  });
  check(
    out.score === 0.2 &&
      out.label === "weak" &&
      out.notes.includes("coverage: addressed") &&
      out.notes.includes("discrimination: missing"),
    "E RUBRIC-JUDGE OK: a rubric naming 2 of 14 meta-criteria stems scores 0.2 (3 of 15 weighted, judge 0 doubles coverage), weak",
  );
  check(
    out.scores.length === 14 &&
      out.scores[0].score === 10 &&
      out.scores[1].score === 0 &&
      out.guidedAnswers[0].answer.includes("discrimination"),
    "E RUBRIC-JUDGE-GUIDED OK: per-criterion 0/10 scores (coverage 10, discrimination 0) and the Q1 answer names the missed dimension",
  );
}
{
  const { out } = workerRun("rubric-update", {
    rubric: { criteria: ["vivid", "concrete"], threshold: 0.8 },
    verdicts: [{ score: 0.5, label: "weak", notes: "vivid: addressed; concrete: missing" }],
  });
  check(
    same(out.criteria, ["vivid", "concrete", "concrete example"]) && out.threshold === 0.8,
    "E RUBRIC-UPDATE OK: a repeated miss the rubric does not name yet becomes a criterion ('concrete example')",
  );
}
{
  const plan = {
    request: "Ship the widget",
    phases: [
      { name: "build", description: "Build it", acceptance: "It builds", kind: "agent", dependsOn: [] },
      { name: "test", description: "Test it", acceptance: "Tests pass", kind: "agent", dependsOn: ["build"] },
    ],
    reviewPoints: ["Review build.", "Review test."],
    gatePlacement: "Gate before test.",
    text: "Plan: Ship the widget\nPhase 1: build — Build it\n  Executes via: agent (plan-phase)\n  Acceptance: It builds\n  Depends on: none\nPhase 2: test — Test it\n  Executes via: agent (plan-phase)\n  Acceptance: Tests pass\n  Depends on: build",
  };
  const { out } = workerRun("judge", {
    item: plan,
    rubric: {
      criteria: ["covers-request", "sequenced", "jobspec", "acceptance", "review-points", "gate-placement"],
      threshold: 0.8,
    },
    judge: 0,
  });
  check(
    out.score === 0.98 &&
      out.label === "approved" &&
      out.notes ===
        "covers-request: addressed; sequenced: addressed; jobspec: addressed; acceptance: addressed; review-points: addressed; gate-placement: addressed",
    "E PLAN-JUDGE OK: a valid plan scores 0.98 (cap) with all six structural criteria addressed",
  );
}
{
  const deck = {
    title: "Deck",
    slides: [
      { title: "One", bullets: ["First point", "Second point"] },
      { title: "Two", bullets: ["In 2026, 3 teams ran it."] },
    ],
  };
  const { out } = workerRun("judge", {
    item: deck,
    rubric: { criteria: ["one-idea", "concise", "concrete", "complete"], threshold: 0.8 },
    judge: 0,
  });
  check(
    out.score === 0.98 &&
      out.label === "approved" &&
      out.notes === "one-idea: addressed; concise: addressed; concrete: addressed; complete: addressed",
    "E DECK-JUDGE OK: a valid deck scores 0.98 (cap) with all four presentation criteria addressed",
  );
}
{
  const { out } = workerRun("fix", {
    item: {
      title: "Deck",
      slides: [
        { title: "One", bullets: [] },
        { title: "Two", bullets: ["one two three four five six seven eight nine ten eleven twelve thirteen words here"] },
      ],
    },
    rubric: { criteria: ["one-idea", "concise", "concrete", "complete"], threshold: 0.8 },
    verdicts: [{ score: 0.25, label: "weak", notes: "one-idea: addressed; concise: missing; concrete: missing; complete: missing" }],
  });
  check(
    same(out.slides[0].bullets, ["Key point: One.", "In 2026, 3 pilot teams ran this process end to end."]) &&
      same(out.slides[1].bullets, ["one two three four five six seven eight nine ten eleven twelve …"]) &&
      out.revisions === 1 &&
      out.text.includes("(revised 1)."),
    "E DECK-FIX OK: the fix fills the empty slide, shortens the long bullet to 12 words + ellipsis, adds the concrete bullet to the slide with the fewest bullets, and bumps revisions",
  );
}
{
  const res = Bun.spawnSync(["bun", WORKER, JSON.stringify({ spec: "nope", input: {} })]);
  check(
    res.exitCode === 2 && res.stderr.toString().includes('worker: unknown spec "nope"'),
    "E UNKNOWN-SPEC OK: an unknown spec exits 2 and names the spec on stderr — a loud refusal, never a silent default",
  );
}

// ------------------------------------------------------- verdict
if (FAILURES.length > 0) {
  console.log(`\nFAIL bra142 unit tests for workflow-library pure functions (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra142 unit tests for workflow-library pure functions (diagnosePhaseReview; decideLocal; resolveTextBlob/resolveTextRubric; planWaves/splitExecuted; direct worker judge/fix/aggregate scoring)");
