// Module variant of workflow-judges.ts: identical behavior, but the
// combinator and the job wrapper come from the agentts module import.
// The driver runs this bundled and compares byte-identical output
// against the direct-trap reference workflow-judges-direct.ts.
// JudgeFixLoop-shaped workflow: three simulated judges (canned results,
// NOT real LLMs) run via all(), then an aggregate step combines their
// verdicts. One judge throws after scoring — collect-all must still
// return every outcome, the failed branch as { ok: false, error }.

interface JobInput {
  value?: number;
  verdicts?: Outcome<string>[];
}

interface StepResult {
  score: number;
  label: string;
}

interface AggregateResult {
  approved: number;
  failed: number;
  summary: string;
}

import { job, all, type Outcome } from "../src/agentts";
declare function print(...args: unknown[]): void;

function judgePath(x: number): string {
  const a = job<JobInput, StepResult>({ spec: "score", input: { value: x } });
  if (x === 5) throw new Error("judge crashed");
  const b = job<JobInput, StepResult>({ spec: "verify", input: { value: x } });
  return a.label + "/" + b.label;
}

const verdicts = all([() => judgePath(7), () => judgePath(3), () => judgePath(5)]);
print("verdicts:", JSON.stringify(verdicts));
const agg = job<JobInput, AggregateResult>({ spec: "aggregate", input: { verdicts: verdicts } });
print("aggregate:", JSON.stringify(agg));
