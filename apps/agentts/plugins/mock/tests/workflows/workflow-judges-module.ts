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

import { job, all, type Outcome } from "../../src/agentts";

declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
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
  return { done: true };
}
