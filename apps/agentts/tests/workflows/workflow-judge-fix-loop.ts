// JudgeFixLoop end-to-end (BRA-44): the concrete workflow that runs
// the generic library loop. The trap calls live in the loop itself
// (workflows/library/judge-fix-loop.ts), specialized per instantiation by the
// extractor (BRA-106); this workflow supplies only (item, rubric,
// maxLoops).
//
// Work item: one sentence to polish. Rubric: vivid, concrete, concise;
// threshold 0.8. Mock judges score 0.55/0.62/0.48 first (mean 0.55),
// +0.15 per revision, so the run revises twice, keeps at loop 3,
// updates the rubric at loop 3 (3 missed criteria), and converges at
// loop 5 (2 loops after the rubric change). The direct adapter runs
// the same workflow through real worker processes instead.

import {
  judgeFixLoop,
  type AggregateScore,
  type JudgeVerdict,
} from "../../workflows/library/judge-fix-loop";

declare function print(...args: unknown[]): void;

export interface WorkItem {
  text: string;
  goal: string;
}

export interface Rubric {
  criteria: string[];
  threshold: number;
}

export interface JudgeFixLoopInput {
  item: WorkItem;
  rubric: Rubric;
  maxLoops: number;
}

export interface JudgeFixLoopWorkflowResult {
  item: WorkItem;
  rubric: Rubric;
  loops: number;
  converged: boolean;
  lastAggregate: AggregateScore | null;
  // Carries the shared JudgeFixLoopResult shape (added with rubricReview):
  // the final round's verdicts, including per-criterion scores and the
  // open-ended feedback, must be part of the declared output or the host's
  // strict result validation rejects the run's output as having additional
  // properties (BRA-112 regression, Nov 18).
  lastVerdicts: JudgeVerdict[];
}

export default function run(input: JudgeFixLoopInput): JudgeFixLoopWorkflowResult {
  const result = judgeFixLoop<WorkItem, Rubric>(input.item, input.rubric, input.maxLoops);

  print("result:", JSON.stringify(result));
  print("done");
  return result;
}
