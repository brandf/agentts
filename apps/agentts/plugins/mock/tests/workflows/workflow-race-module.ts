// Module variant of workflow-race.ts: identical behavior, but the
// combinator and the job wrapper come from the agentts module import.
// The driver runs this bundled and compares byte-identical output
// against the direct-trap reference workflow-race-direct.ts.
// race() (Linear BRA-26): first settler wins — its bare value if it
// succeeded, its error if it failed (Promise.race's shape). The rest
// are cancelled. In this experiment the driver runs branches
// sequentially, so the first branch is always the first settler; the
// test proves the join/cancel/journal mechanics for both settle
// outcomes, and true time-based racing needs the real scheduler (M3).

interface JobInput {
  value?: number;
  verdicts?: Outcome<string>[];
}

interface StepResult {
  score: number;
  label: string;
}

import { job, race, type Outcome } from "../../src/agentts";
declare function print(...args: unknown[]): void;

function judgePath(x: number): string {
  const a = job<JobInput, StepResult>({ spec: "score", input: { value: x } });
  if (x === 5) throw new Error("judge crashed");
  if (x === 9) throw new Error("judge timed out");
  const b = job<JobInput, StepResult>({ spec: "verify", input: { value: x } });
  return a.label + "/" + b.label;
}

// Success: branch 0 wins; branches 1 and 2 never run.
const winner = race([() => judgePath(7), () => judgePath(5), () => judgePath(3)]);
print("winner:", winner);

// Failure: branch 0 throws; the parent catches it, finally runs.
let caught = "";
try {
  race([() => judgePath(5), () => judgePath(7)]);
} catch (e) {
  caught = (e as Error).message;
  print("caught is Error:", e instanceof Error);
} finally {
  print("finally ran");
}
print("caught:", caught);
