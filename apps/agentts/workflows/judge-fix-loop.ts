// judge-fix-loop — the JudgeFixLoop<X, R> library workflow (BRA-44).
//
// The generic loop: send work item X + rubric R to 3 independent judge
// agents in parallel (the `all` combinator), reduce/dedupe/aggregate
// into an aggregate score, decide whether to change X (a `decide`
// trap, not a job), loop; every 3 loops consider whether R itself
// needs updating; if R improves, do at least 2 more loops before
// declaring convergence.
//
// The loop owns its trap calls like any concrete workflow: it calls
// `job`/`decide` directly, with contract types parameterized by X and
// R (JudgeInput<X, R>, FixInput<X, R>, RubricUpdateInput<R>). The
// extractor specializes those types per instantiation (BRA-106): at
// each `judgeFixLoop<FixItem, FixRubric>(...)` call site it reads the
// concrete type arguments and re-resolves the inner trap sites under
// them, so the loop needs no injected callbacks. The caller supplies
// only (initial, rubric, maxLoops); the threshold the loop's questions
// and aggregate input carry comes from the rubric itself, which is why
// R is constrained to `{ threshold: number }`.
//
// Convergence rule (settled): a `decide` each loop asks whether the
// run has converged; the answer only counts once at least 2 loops have
// passed since the last rubric improvement (loopsSinceRubricChange >=
// 2). A rubric update resets the counter to 0.

import { job, decide, all, type Outcome } from "../src/agentts";

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

/** Trap contracts, parameterized by the item/rubric types: the
 * extractor specializes these per instantiation (BRA-106), so each
 * `judgeFixLoop<X, R>` call site gets the concrete contracts for its
 * own X and R. */
export interface JudgeInput<X, R> {
  item: X;
  rubric: R;
  judge: number;
}

export interface AggregateInput {
  verdicts: JudgeVerdict[];
  failed: number;
  threshold: number;
}

export interface FixInput<X, R> {
  item: X;
  rubric: R;
  verdicts: JudgeVerdict[];
}

export interface RubricUpdateInput<R> {
  rubric: R;
  verdicts: JudgeVerdict[];
}

export interface JudgeFixLoopResult<X, R> {
  item: X;
  rubric: R;
  loops: number;
  converged: boolean;
  lastAggregate: AggregateScore | null;
}

export function judgeFixLoop<X, R extends { threshold: number }>(
  initial: X,
  rubric: R,
  maxLoops: number,
): JudgeFixLoopResult<X, R> {
  let item = initial;
  let rub = rubric;
  // No rubric change yet: convergence is allowed from the first loop.
  let loopsSinceRubricChange = 99;
  let lastAggregate: AggregateScore | null = null;

  for (let loop = 1; loop <= maxLoops; loop++) {
    // 3 independent judges in parallel (collect-all: a failed judge
    // is an outcome, not a loop failure). A trap inside an `all()`
    // branch thunk suspends the branch exactly as a direct trap call
    // would.
    const outcomes: Outcome<JudgeVerdict>[] = all([
      () => job<JudgeInput<X, R>, JudgeVerdict>({ spec: "judge", input: { item, rubric: rub, judge: 0 } }),
      () => job<JudgeInput<X, R>, JudgeVerdict>({ spec: "judge", input: { item, rubric: rub, judge: 1 } }),
      () => job<JudgeInput<X, R>, JudgeVerdict>({ spec: "judge", input: { item, rubric: rub, judge: 2 } }),
    ]);
    const verdicts: JudgeVerdict[] = [];
    let failed = 0;
    for (const o of outcomes) {
      if (o.ok) verdicts.push(o.value);
      else failed++;
    }
    const agg = job<AggregateInput, AggregateScore>({
      spec: "aggregate",
      input: { verdicts, failed, threshold: rub.threshold },
    });
    lastAggregate = agg;
    print(`loop ${loop}: ${agg.summary}`);

    const rev = decide<LoopDecision>({
      question: `loop ${loop}: mean score ${agg.meanScore} threshold ${rub.threshold}; ${agg.approved} of 3 approved. Should the work item be revised or kept?`,
      options: ["revise", "keep"],
    });
    if (rev.choice === "revise") {
      item = job<FixInput<X, R>, X>({ spec: "fix", input: { item, rubric: rub, verdicts } });
      print(`loop ${loop}: revised`);
    }

    // Every 3 loops, consider whether the rubric itself needs updating.
    if (loop % 3 === 0) {
      const misses = verdicts.reduce(
        (n, v) => n + (v.notes.includes("missing") ? 1 : 0),
        0,
      );
      const rd = decide<LoopDecision>({
        question: `loop ${loop}: misses: ${misses} missed criteria across judges; update the rubric if misses >= 2. Should the rubric be updated or kept?`,
        options: ["update", "keep"],
      });
      if (rd.choice === "update") {
        rub = job<RubricUpdateInput<R>, R>({ spec: "rubric-update", input: { rubric: rub, verdicts } });
        loopsSinceRubricChange = 0;
        print(`loop ${loop}: rubric updated`);
      }
    }

    const conv = decide<LoopDecision>({
      question: `loop ${loop}: mean score ${agg.meanScore} threshold ${rub.threshold}, loops since rubric change ${loopsSinceRubricChange}. Converged?`,
      options: ["converged", "continue"],
    });
    if (conv.choice === "converged" && loopsSinceRubricChange >= 2) {
      print(`loop ${loop}: converged`);
      return { item, rubric: rub, loops: loop, converged: true, lastAggregate };
    }
    loopsSinceRubricChange++;
  }
  return { item, rubric: rub, loops: maxLoops, converged: false, lastAggregate };
}
