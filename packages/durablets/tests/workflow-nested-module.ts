// Module variant of workflow-nested.ts: identical behavior, but the
// combinator and the job wrapper come from the agentts module import.
// The driver runs this bundled and compares byte-identical output
// against the direct-trap reference workflow-nested-direct.ts.
// Nested all(): a branch that itself calls all(). Branch 0 fans out to
// two sub-judges and joins them; branch 1 is a plain judge. The same
// suspend-snapshot-spawn-join machinery must run recursively, with the
// nested fork recorded in the branch's journal (parent fork id = the
// nested fork), and the parent's verdicts must still match the reference.

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
