// improve-loop — the improve-loop standard-library workflow.
//
// Takes a work item (almost anything: a document, a presentation, a
// pull request, ...) and a rubric (inline, or a reference to a rubric
// file), and runs an improvement loop: two parallel judges critique
// the item against the rubric and return a scorecard each; a job
// aggregates, de-duplicates and filters the two scorecards; a job
// decides if/what fixes are needed; if fixes are needed they are
// applied before looping back to another round of judging. At most
// THREE rounds; then the workflow completes and presents the improved
// work item along with a report of what changes were made and why.
//
// Shape (settled, Brandon 05:51 PST): a workflow is a function with
// a trap-like signature — ONE JSON-capable input in, ONE JSON-capable
// output out. The default export IS the workflow:
//   export default function improveLoop(input: ImproveLoopInput): ImproveLoopResult
// The host generates a driver (global code) that calls it with the
// input JSON; the C host captures the completion value as the run
// result. The loop logic lives in improveLoopCore (generic core,
// trap-calling steps injected as callbacks — a deliberate test seam;
// JudgeFixLoop used this shape before BRA-106 and now calls its
// traps directly) so tests can import it and drive it with fake steps
// without the engine. The default export defines the concrete steps
// (job traps) and calls the core.
//
// Inputs (ImproveLoopInput): workItem (kind + description + content
// text + optional ref) and rubric (an inline Rubric, or { file } — a
// path to a rubric JSON file, resolved with an exec trap that reads
// the file). outDir is where the improved item + change report are
// written (default .agentts-scratch/improve-loop-out).
//
// Result (ImproveLoopResult): the improved item, the change report
// (rounds, converged, every change + why, outstanding findings,
// final mean score), and the paths of the two written files.
//
// v1 limits, stated plainly: the v0 judge/fix workers are
// deterministic keyword/coverage workers (see plugins/muse/jobspecs
// improve-*.md), not LLM judgement — the fix appends addressing
// sentences rather than rewriting prose. A criterion the fix cannot
// address by appending (notably "concise": appending makes text
// longer) stays outstanding and the loop hits the 3-round cap
// honestly instead of pretending to improve. The result-passing gap
// (no programmatic return-value channel for a caller — the result
// is files + stdout + journal) is the Q12 follow-on, not this file.

import { job, exec, all, type Outcome } from "../../src/agentts";

declare function print(...args: unknown[]): void;

// ---------------------------------------------------------------- types
/** The thing being improved. `content` is the item's text (or a
 * textual rendering of it); `ref` is an optional path/URL to the
 * item itself. `kind` is free-form: "document", "presentation",
 * "pull-request", anything. */
export interface WorkItem {
  kind: string;
  description: string;
  content: string;
  ref?: string;
}

export interface RubricCriterion {
  name: string;
  description: string;
}

/** A rubric: named criteria plus the mean-score threshold the
 * judges score against (threshold is advisory — the decide job
 * drives fix-or-stop from the findings, not the threshold). */
export interface Rubric {
  criteria: RubricCriterion[];
  threshold: number;
}

export interface RubricFileRef {
  file: string;
}

/** A rubric inline, or a reference to a rubric JSON file. */
export type RubricInput = Rubric | RubricFileRef;

export interface ImproveLoopInput {
  workItem: WorkItem;
  rubric: RubricInput;
  outDir?: string;
}

export interface Finding {
  id: string;
  criterion: string;
  severity: "blocking" | "major" | "minor" | "nit";
  detail: string;
  suggestion: string;
}

export interface AxisScore {
  criterion: string;
  score: number;
  note: string;
}

export interface Scorecard {
  judge: number;
  axisScores: AxisScore[];
  findings: Finding[];
  summary: string;
}

export interface DroppedFinding {
  finding: Finding;
  reason: string;
}

export interface AggregatedFeedback {
  findings: Finding[];
  dropped: DroppedFinding[];
  meanScore: number;
  summary: string;
}

export interface FixAction {
  findingId: string;
  action: string;
}

export interface FixDecision {
  needsFix: boolean;
  fixes: FixAction[];
  reason: string;
}

export interface Change {
  round: number;
  findingId: string;
  description: string;
  why: string;
}

export interface FixApplication {
  item: WorkItem;
  changes: Change[];
}

export interface ChangeReport {
  rounds: number;
  converged: boolean;
  changes: Change[];
  outstanding: Finding[];
  finalMeanScore: number;
  summary: string;
}

export interface WriteResult {
  ok: boolean;
  error: string;
  improvedPath: string;
  reportPath: string;
  bytes: number;
}

export interface ImproveLoopResult {
  item: WorkItem;
  report: ChangeReport;
  improvedPath: string;
  reportPath: string;
}

// Job trap contracts (concrete, named types at every call site).
export interface JudgeInput {
  item: WorkItem;
  rubric: Rubric;
  judge: number;
}

export interface AggregateInput {
  scorecards: Scorecard[];
  failed: number;
}

export interface DecideInput {
  aggregated: AggregatedFeedback;
  round: number;
}

export interface FixInput {
  item: WorkItem;
  rubric: Rubric;
  decision: FixDecision;
  aggregated: AggregatedFeedback;
}

export interface WriteInput {
  item: WorkItem;
  report: ChangeReport;
  outDir: string;
}

export interface ImproveLoopSteps {
  judge(item: WorkItem, rubric: Rubric, judge: number): Scorecard;
  aggregate(scorecards: Scorecard[], failed: number): AggregatedFeedback;
  decideFix(aggregated: AggregatedFeedback, round: number): FixDecision;
  applyFix(
    item: WorkItem,
    rubric: Rubric,
    decision: FixDecision,
    aggregated: AggregatedFeedback,
  ): FixApplication;
  write(item: WorkItem, report: ChangeReport, outDir: string): WriteResult;
}

// ------------------------------------------------------- rubric resolve
/** Resolve a rubric input: inline rubrics pass through; a file
 * reference is read with an exec trap (`cat`) and parsed as JSON.
 * A malformed file (unreadable, bad JSON, wrong shape) throws a
 * clear error — the run fails loudly rather than judging against
 * a rubric that is not there. */
export function resolveRubric(rubric: RubricInput): Rubric {
  if (!("file" in rubric)) {
    return rubric;
  }
  const read = exec({ cmd: "cat", args: [rubric.file] });
  if (read.exitCode !== 0) {
    throw new Error(
      `improve-loop: could not read rubric file ${rubric.file} (exit ${read.exitCode}): ${(read.stderr ?? "").slice(0, 200)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.stdout);
  } catch {
    throw new Error(`improve-loop: rubric file ${rubric.file} is not valid JSON`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { criteria?: unknown }).criteria) ||
    typeof (parsed as { threshold?: unknown }).threshold !== "number"
  ) {
    throw new Error(
      `improve-loop: rubric file ${rubric.file} must be a JSON object with a criteria array and a numeric threshold`,
    );
  }
  return parsed as Rubric;
}

// ------------------------------------------------------------------ core
export const MAX_ROUNDS = 3;

/** The loop. Generic over nothing — WorkItem/Rubric are the
 * contracts — but the trap-calling steps are injected, so the core
 * is testable without the engine (pass fake steps) and the workflow
 * entry below supplies the real ones. */
export function improveLoopCore(
  input: ImproveLoopInput,
  steps: ImproveLoopSteps,
): ImproveLoopResult {
  const rubric = resolveRubric(input.rubric);
  let item = input.workItem;
  const changes: Change[] = [];
  let lastAgg: AggregatedFeedback | null = null;
  let converged = false;
  let rounds = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rounds = round;
    // Two independent judges in parallel (collect-all: a failed
    // judge is an outcome, not a loop failure).
    const outcomes: Outcome<Scorecard>[] = all([
      () => steps.judge(item, rubric, 0),
      () => steps.judge(item, rubric, 1),
    ]);
    const scorecards: Scorecard[] = [];
    let failed = 0;
    for (const o of outcomes) {
      if (o.ok) scorecards.push(o.value);
      else failed++;
    }
    const agg = steps.aggregate(scorecards, failed);
    lastAgg = agg;
    print(`round ${round}: ${agg.summary}`);

    const decision = steps.decideFix(agg, round);
    if (!decision.needsFix) {
      converged = true;
      print(`round ${round}: no fixes needed (${decision.reason})`);
      break;
    }
    const applied = steps.applyFix(item, rubric, decision, agg);
    item = applied.item;
    // The fix worker does not know the round (it is not in FixInput)
    // — the workflow owns the round, so it stamps it onto the
    // changes the worker recorded.
    changes.push(...applied.changes.map((c) => ({ ...c, round })));
    print(`round ${round}: applied ${applied.changes.length} fix(es)`);
  }

  const outstanding: Finding[] =
    converged || !lastAgg
      ? []
      : lastAgg.findings.filter((f) => f.severity === "blocking" || f.severity === "major");
  const finalMeanScore = lastAgg?.meanScore ?? 0;
  const summary = converged
    ? changes.length === 0
      ? `no fixes needed after ${rounds} round(s); final mean score ${finalMeanScore}`
      : `converged after ${rounds} round(s) with ${changes.length} change(s); final mean score ${finalMeanScore}`
    : `stopped at the ${MAX_ROUNDS}-round cap with ${outstanding.length} finding(s) still outstanding (${outstanding.map((f) => f.id).join(", ")}); ${changes.length} change(s) applied; final mean score ${finalMeanScore}`;
  const report: ChangeReport = {
    rounds,
    converged,
    changes,
    outstanding,
    finalMeanScore,
    summary,
  };
  print(`report: ${JSON.stringify(report)}`);

  const outDir = input.outDir ?? ".agentts-scratch/improve-loop-out";
  const written = steps.write(item, report, outDir);
  if (!written.ok) {
    throw new Error(`improve-loop: write failed: ${written.error}`);
  }
  print(`improved: ${written.improvedPath}`);
  print(`report: ${written.reportPath}`);
  print(`rounds: ${rounds}, converged: ${converged}, changes: ${changes.length}`);
  return {
    item,
    report,
    improvedPath: written.improvedPath,
    reportPath: written.reportPath,
  };
}

// -------------------------------------------------------- workflow entry
/** The workflow: one JSON-capable input in, one JSON-capable output
 * out. The host generates a driver (global code) that calls this
 * with the input JSON; the C host captures the return value as the
 * run result. */
export default function improveLoop(input: ImproveLoopInput): ImproveLoopResult {
  return improveLoopCore(input, {
    judge: (item, rubric, judge) =>
      job<JudgeInput, Scorecard>({ spec: "improve-judge", input: { item, rubric, judge } }),
    aggregate: (scorecards, failed) =>
      job<AggregateInput, AggregatedFeedback>({
        spec: "improve-aggregate",
        input: { scorecards, failed },
      }),
    decideFix: (aggregated, round) =>
      job<DecideInput, FixDecision>({ spec: "improve-decide", input: { aggregated, round } }),
    applyFix: (item, rubric, decision, aggregated) =>
      job<FixInput, FixApplication>({
        spec: "improve-fix",
        input: { item, rubric, decision, aggregated },
      }),
    write: (item, report, outDir) =>
      job<WriteInput, WriteResult>({ spec: "improve-write", input: { item, report, outDir } }),
  });
}
