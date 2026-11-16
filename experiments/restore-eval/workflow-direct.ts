// Straight-through reference: the same thunk bodies, run directly with
// no combinator and no suspension of a fork. The concatenated branch
// outputs from the fork experiment must be byte-identical to this.

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

function judgePath(x: number): string {
  const a = step({ op: "score", value: x });
  const b = step({ op: "verify", value: x });
  return a.label + "/" + b.label;
}

print("branch 0 result:", JSON.stringify(judgePath(7)));
print("branch 1 result:", JSON.stringify(judgePath(3)));
