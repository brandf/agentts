// JudgeFixLoop end-to-end (BRA-44): the concrete workflow that runs
// the generic library loop. The trap calls live HERE (concrete, named
// types — the extractor needs them at the call site); the loop logic
// lives in workflows/judge-fix-loop.ts.
//
// Work item: one sentence to polish. Rubric: vivid, concrete, concise;
// threshold 0.8. Mock judges score 0.55/0.62/0.48 first (mean 0.55),
// +0.15 per revision, so the run revises twice, keeps at loop 3,
// updates the rubric at loop 3 (3 missed criteria), and converges at
// loop 5 (2 loops after the rubric change). The direct adapter runs
// the same workflow through real worker processes instead.

import { job, decide } from "../../src/agentts";
import {
  judgeFixLoop,
  type AggregateScore,
  type JudgeVerdict,
  type LoopDecision,
} from "../../workflows/judge-fix-loop";

declare function print(...args: unknown[]): void;

interface WorkItem {
  text: string;
  goal: string;
}

interface Rubric {
  criteria: string[];
  threshold: number;
}

interface JudgeInput {
  item: WorkItem;
  rubric: Rubric;
  judge: number;
}

interface AggregateInput {
  verdicts: JudgeVerdict[];
  failed: number;
  threshold: number;
}

interface FixInput {
  item: WorkItem;
  rubric: Rubric;
  verdicts: JudgeVerdict[];
}

interface RubricUpdateInput {
  rubric: Rubric;
  verdicts: JudgeVerdict[];
}

const result = judgeFixLoop<WorkItem, Rubric>(
  {
    text: "The quick brown fox jumps over the lazy dog.",
    goal: "A vivid one-sentence story opening.",
  },
  { criteria: ["vivid", "concrete", "concise"], threshold: 0.8 },
  6,
  {
    judge: (item, rubric, judge) =>
      job<JudgeInput, JudgeVerdict>({ spec: "judge", input: { item, rubric, judge } }),
    aggregate: (verdicts, failed) =>
      job<AggregateInput, AggregateScore>({
        spec: "aggregate",
        input: { verdicts, failed, threshold: 0.8 },
      }),
    fix: (item, rubric, verdicts) =>
      job<FixInput, WorkItem>({ spec: "fix", input: { item, rubric, verdicts } }),
    updateRubric: (rubric, verdicts) =>
      job<RubricUpdateInput, Rubric>({ spec: "rubric-update", input: { rubric, verdicts } }),
    decideRevise: (agg, loop) =>
      decide<LoopDecision>({
        question: `loop ${loop}: mean score ${agg.meanScore} threshold 0.8; ${agg.approved} of 3 approved. Should the work item be revised or kept?`,
        options: ["revise", "keep"],
      }),
    decideRubric: (loop, misses) =>
      decide<LoopDecision>({
        question: `loop ${loop}: misses: ${misses} missed criteria across judges; update the rubric if misses >= 2. Should the rubric be updated or kept?`,
        options: ["update", "keep"],
      }),
    decideConverged: (agg, loop, since) =>
      decide<LoopDecision>({
        question: `loop ${loop}: mean score ${agg.meanScore} threshold 0.8, loops since rubric change ${since}. Converged?`,
        options: ["converged", "continue"],
      }),
  },
);

print("result:", JSON.stringify(result));
print("done");
