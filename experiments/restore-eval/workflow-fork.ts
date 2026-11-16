// Parent workflow: forks two judge branches with `all`, then (in a real
// engine) would join on the verdicts. In this experiment the parent only
// proves the fork suspends and snapshots; the children run the branches.
//
// The thunks close over their inputs (7 and 3): the closure environment
// must survive the snapshot for the child to run them.

interface StepInput {
  op: string;
  value: number;
}

interface StepResult {
  score: number;
  label: string;
}

declare function step(input: StepInput): StepResult;
declare function print(...args: unknown[]): void;
declare function all(thunks: (() => string)[]): unknown;

function judgePath(x: number): string {
  const a = step({ op: "score", value: x });
  const b = step({ op: "verify", value: x });
  return a.label + "/" + b.label;
}

const verdicts = all([() => judgePath(7), () => judgePath(3)]);
print("verdicts:", JSON.stringify(verdicts));
