// Behavior 2: cancel a whole all() in flight. Three branches, each
// suspended at its first step when the driver cancels the parent
// combinator (and each child). Branches catch their own cancellation
// and return cleanly; the parent catches the CancellationError thrown
// at the all() call site.

interface StepInput {
  op: string;
  value?: number;
}

interface StepResult {
  score: number;
  label: string;
}

interface Outcome {
  ok: boolean;
  value?: string;
  error?: { name: string; message: string };
}

declare function trap(type: string, arg: unknown): unknown;
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): StepResult { return trap("job", input) as StepResult; }
declare function print(...args: unknown[]): void;
declare function all(thunks: (() => string)[]): Outcome[];

function branchPath(x: number): string {
  try {
    const a = step({ op: "score", value: x });
    return a.label;
  } catch (e) {
    return "cancelled:" + (e as Error).name;
  }
}

let caught = "";
try {
  const verdicts = all([
    () => branchPath(7),
    () => branchPath(3),
    () => branchPath(9),
  ]);
  print("verdicts:", JSON.stringify(verdicts));
} catch (e) {
  caught = (e as Error).name;
  print("caught:", caught);
  print("caught is Error:", (e as Error) instanceof Error);
} finally {
  print("finally ran");
}
print("done, caught:", caught);
