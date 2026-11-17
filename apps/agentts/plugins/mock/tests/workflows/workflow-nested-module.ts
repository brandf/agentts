interface JobInput {
  value?: number;
  verdicts?: Outcome<string>[];
}

interface StepResult {
  score: number;
  label: string;
}

import { job, all, type Outcome } from "../../src/agentts";

declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function subJudge(x: number): string {
    const a = job<JobInput, StepResult>({ spec: "score", input: { value: x } });
    return a.label;
  }

  function judgePath(x: number): string {
    const a = job<JobInput, StepResult>({ spec: "score", input: { value: x } });
    if (x === 7) {
      const subs = all([() => subJudge(11), () => subJudge(12)]);
      return a.label + "/nested=" + JSON.stringify(subs);
    }
    const b = job<JobInput, StepResult>({ spec: "verify", input: { value: x } });
    return a.label + "/" + b.label;
  }

  const verdicts = all([() => judgePath(7), () => judgePath(3)]);

  print("verdicts:", JSON.stringify(verdicts));
  return { done: true };
}
