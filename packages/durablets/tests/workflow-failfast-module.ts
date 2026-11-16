// Module variant of workflow-failfast.ts: identical behavior, but the
// combinator and the job wrapper come from the agentts module import.
// The driver runs this bundled and compares byte-identical output
// against the direct-trap reference workflow-failfast-direct.ts.
// Fail-fast bool on all() (Linear BRA-25): all([...], true) returns
// bare values on success and throws the first branch error at the call
// site. The parent catches it with ordinary try/catch, its finally
// block runs, and the parent keeps working afterwards (the run itself
// is NOT cancelled — only the siblings were). Two branches failing
// proves firstness is journal order: the first failure's error is
// thrown, the later failure never runs. Also exercises explicit
// all([...], false), which behaves exactly like all([...]).

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

function judgePath(x: number): string {
  const a = job<JobInput, StepResult>({ spec: "score", input: { value: x } });
  if (x === 5) throw new Error("judge crashed");
  if (x === 9) throw new Error("judge timed out");
  const b = job<JobInput, StepResult>({ spec: "verify", input: { value: x } });
  return a.label + "/" + b.label;
}

// Success: bare values, in order.
const values = all([() => judgePath(7), () => judgePath(3)], true);
print("values:", JSON.stringify(values));

// Collect-all with explicit false: outcome objects, as all([...]).
const collected = all([() => judgePath(7), () => judgePath(5)], false);
print("collected false:", JSON.stringify(collected));

// Throw + catch + finally + continue: branch 1 fails, branch 2 never runs.
let caught = "";
try {
  all([() => judgePath(7), () => judgePath(5), () => judgePath(3)], true);
} catch (e) {
  caught = (e as Error).message;
  print("caught is Error:", e instanceof Error);
} finally {
  print("finally ran");
}
print("caught:", caught);
const resumed = job<JobInput, StepResult>({ spec: "score", input: { value: 11 } });
print("continued:", JSON.stringify(resumed));

// Firstness: branches 1 and 2 both fail; the first failure's error wins.
let first = "";
try {
  all([() => judgePath(7), () => judgePath(9), () => judgePath(5)], true);
} catch (e) {
  first = (e as Error).message;
}
print("first failure:", first);
