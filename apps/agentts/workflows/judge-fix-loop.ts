// judge-fix-loop — the JudgeFixLoop<X, R> library workflow (BRA-44).
//
// The generic loop: send work item X + rubric R to 3 independent judge
// agents in parallel (the `all` combinator), reduce/dedupe/aggregate
// into an aggregate score, decide whether to change X (a `decide`
// trap, not a job), loop; every 3 loops consider whether R itself
// needs updating; if R improves, do at least 2 more loops before
// declaring convergence.
//
// Why the trap calls are NOT in this file: the host extractor needs a
// concrete, named type at every trap call site, and a generic function
// cannot supply one (its type parameters are unresolved at the call
// site — the pre-check rejects them loudly). So the loop is generic
// over X and R, but the trap-calling steps are supplied by the caller
// (the concrete workflow), where the types ARE concrete. The steps
// are plain callbacks; the loop calls them — including inside `all()`
// branch thunks, where a trap suspends the branch exactly as a direct
// trap call would. The library owns the loop logic (fan-out, reduce,
// decide cadence, convergence rule); the workflow owns the contracts.
// See README.md ("Why JudgeFixLoop is shaped this way").
//
// Convergence rule (settled): a `decide` each loop asks whether the
// run has converged; the answer only counts once at least 2 loops have
// passed since the last rubric improvement (loopsSinceRubricChange >=
// 2). A rubric update resets the counter to 0.

import { all, type Outcome } from "../src/agentts";

declare function print(...args: unknown[]): void;

export interface JudgeVerdict {
  score: number;
  label: string;
  notes: string;
}

export interface AggregateScore {
  approved: number;
  failed: number;
  meanScore: number;
  summary: string;
}

/** Decide results — ONE type for every decide call in a workflow.
 * The extractor keys decide sites by the bare trap type, so one key
 * carries one contract: three decide calls with three different
 * result types are a loud extraction conflict, not three contracts.
 * The different meanings live in the question/options, not the type.
 * (BRA-47 owns the canonical Decision shape; until then workflows
 * name their own single result type at the call site.) */
export interface LoopDecision {
  choice: string;
  confidence: number;
}

export interface JudgeFixLoopSteps<X, R> {
  /** One judge agent (a job trap in the caller's workflow). */
  judge(item: X, rubric: R, judge: number): JudgeVerdict;
  /** Reduce/dedupe/aggregate the verdicts (a job trap). */
  aggregate(verdicts: JudgeVerdict[], failed: number): AggregateScore;
  /** Revise the item from the verdicts (a job trap). */
  fix(item: X, rubric: R, verdicts: JudgeVerdict[]): X;
  /** Revise the rubric from the verdicts (a job trap). */
  updateRubric(rubric: R, verdicts: JudgeVerdict[]): R;
  /** Decide: revise the item or keep it (a decide trap). */
  decideRevise(agg: AggregateScore, loop: number): LoopDecision;
  /** Decide: update the rubric or keep it (a decide trap). */
  decideRubric(loop: number, misses: number): LoopDecision;
  /** Decide: converged or continue (a decide trap). */
  decideConverged(agg: AggregateScore, loop: number, loopsSinceRubricChange: number): LoopDecision;
}

export interface JudgeFixLoopResult<X, R> {
  item: X;
  rubric: R;
  loops: number;
  converged: boolean;
  lastAggregate: AggregateScore | null;
}

export function judgeFixLoop<X, R>(
  initial: X,
  rubric: R,
  maxLoops: number,
  steps: JudgeFixLoopSteps<X, R>,
): JudgeFixLoopResult<X, R> {
  let item = initial;
  let rub = rubric;
  // No rubric change yet: convergence is allowed from the first loop.
  let loopsSinceRubricChange = 99;
  let lastAggregate: AggregateScore | null = null;

  for (let loop = 1; loop <= maxLoops; loop++) {
    // 3 independent judges in parallel (collect-all: a failed judge
    // is an outcome, not a loop failure).
    const outcomes: Outcome<JudgeVerdict>[] = all([
      () => steps.judge(item, rub, 0),
      () => steps.judge(item, rub, 1),
      () => steps.judge(item, rub, 2),
    ]);
    const verdicts: JudgeVerdict[] = [];
    let failed = 0;
    for (const o of outcomes) {
      if (o.ok) verdicts.push(o.value);
      else failed++;
    }
    const agg = steps.aggregate(verdicts, failed);
    lastAggregate = agg;
    print(`loop ${loop}: ${agg.summary}`);

    const rev = steps.decideRevise(agg, loop);
    if (rev.choice === "revise") {
      item = steps.fix(item, rub, verdicts);
      print(`loop ${loop}: revised`);
    }

    // Every 3 loops, consider whether the rubric itself needs updating.
    if (loop % 3 === 0) {
      const misses = verdicts.reduce(
        (n, v) => n + (v.notes.includes("missing") ? 1 : 0),
        0,
      );
      const rd = steps.decideRubric(loop, misses);
      if (rd.choice === "update") {
        rub = steps.updateRubric(rub, verdicts);
        loopsSinceRubricChange = 0;
        print(`loop ${loop}: rubric updated`);
      }
    }

    const conv = steps.decideConverged(agg, loop, loopsSinceRubricChange);
    if (conv.choice === "converged" && loopsSinceRubricChange >= 2) {
      print(`loop ${loop}: converged`);
      return { item, rubric: rub, loops: loop, converged: true, lastAggregate };
    }
    loopsSinceRubricChange++;
  }
  return { item, rubric: rub, loops: maxLoops, converged: false, lastAggregate };
}
