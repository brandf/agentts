// Module variant of workflow-global.ts: identical behavior, but the
// combinator and the job wrapper come from the agentts module import.
// The driver runs this bundled and compares byte-identical output
// against the direct-trap reference workflow-global-direct.ts.
// Global-state rule (Q13): branches may READ shared state — every branch
// sees the same fork-time snapshot — but must NOT write it. Branch 1
// writes sharedCount in its own heap copy; the write must be discarded
// by construction, so the parent's sharedCount is still 0 after the join.
// Also exercises all([]), which returns [] with no fork and no suspension.

interface JobInput {
  value?: number;
  verdicts?: Outcome<string>[];
}

interface StepResult {
  score: number;
  label: string;
}

import { job, all, type Outcome } from "../src/agentts";
declare function print(...args: unknown[]): void;

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
