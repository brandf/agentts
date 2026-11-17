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

  const winner = any([() => judgePath(5), () => judgePath(7), () => judgePath(3)]);

  print("winner:", winner);

  try {
    any([() => judgePath(5), () => judgePath(9)]);
  } catch (e) {
    const agg = e as AggregateError;
    print("all-fail is AggregateError:", e instanceof AggregateError);
    print("all-fail errors:", JSON.stringify((agg.errors as Error[]).map((x) => x.message)));
  }

  try {
    any([]);
  } catch (e) {
    const agg = e as AggregateError;
    print("empty any is AggregateError:", e instanceof AggregateError);
    print("empty any errors:", agg.errors.length);
  }
  return { done: true };
}
