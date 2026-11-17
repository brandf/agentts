// Module variant of workflow-any.ts: identical behavior, but the
// combinator and the job wrapper come from the agentts module import.
// The driver runs this bundled and compares byte-identical output
// against the direct-trap reference workflow-any-direct.ts.
// any() (Linear BRA-26): first success wins (bare value), the rest
// cancelled; if every branch fails it throws an AggregateError holding
// all the branch errors in branch order (Promise.any's shape). any([])
// throws an AggregateError with no errors, immediately.

interface JobInput {
  value?: number;
  verdicts?: Outcome<string>[];
}

interface StepResult {
  score: number;
  label: string;
}

import { job, any, type Outcome } from "../../src/agentts";
declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function judgePath(x: number): string {
    const a = job<JobInput, StepResult>({ spec: "score", input: { value: x } });
    if (x === 5) throw new Error("judge crashed");
    if (x === 9) throw new Error("judge timed out");
    const b = job<JobInput, StepResult>({ spec: "verify", input: { value: x } });
    return a.label + "/" + b.label;
  }

  // First success wins: branch 0 fails, branch 1 succeeds, branch 2 never runs.
  const winner = any([() => judgePath(5), () => judgePath(7), () => judgePath(3)]);
  print("winner:", winner);

  // All fail: AggregateError, errors in branch order.
  try {
    any([() => judgePath(5), () => judgePath(9)]);
  } catch (e) {
    const agg = e as AggregateError;
    print("all-fail is AggregateError:", e instanceof AggregateError);
    print("all-fail errors:", JSON.stringify((agg.errors as Error[]).map((x) => x.message)));
  }

  // Empty: AggregateError with no errors.
  try {
    any([]);
  } catch (e) {
    const agg = e as AggregateError;
    print("empty any is AggregateError:", e instanceof AggregateError);
    print("empty any errors:", agg.errors.length);
  }
  return { done: true };
}
