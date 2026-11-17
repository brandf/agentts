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
  let sharedCount = 0;

  function readBranch(x: number): string {
    job<JobInput, StepResult>({ spec: "score", input: { value: x } });
    return "read:" + sharedCount;
  }

  function writeBranch(x: number): string {
    job<JobInput, StepResult>({ spec: "score", input: { value: x } });
    sharedCount = 99;
    return "read:" + sharedCount;
  }

  const verdicts = all([() => readBranch(21), () => writeBranch(22), () => readBranch(23)]);

  print("verdicts:", JSON.stringify(verdicts));

  print("empty all:", JSON.stringify(all([])));

  print("sharedCount after join:", sharedCount);
  return { done: true };
}
