// Behavior 5: nested propagation. The parent forks all() with two
// branches; branch 0 fans out again (its own all() with two
// sub-branches); branch 1 does one step. The driver cancels the
// whole tree: grandchildren, then branch 0, then branch 1, then the
// parent. Branch 0 and the grandchildren do not catch the
// cancellation (their outcomes are failed CancellationErrors);
// branch 1 catches it and returns cleanly.

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

function innerPath(x: number): string {
  const a = step({ op: "score", value: x });
  return a.label;
}

function branchPath(x: number): string {
  if (x === 7) {
    // This branch fans out again; no try/catch here — the
    // cancellation of its all() is uncaught, so the branch fails
    // with a CancellationError outcome.
    const sub = all([() => innerPath(21), () => innerPath(22)]);
    return "sub:" + JSON.stringify(sub);
  }
  try {
    const a = step({ op: "score", value: x });
    return a.label;
  } catch (e) {
    return "cancelled:" + (e as Error).name;
  }
}

let caught = "";
try {
  const verdicts = all([() => branchPath(7), () => branchPath(3)]);
  print("verdicts:", JSON.stringify(verdicts));
} catch (e) {
  caught = (e as Error).name;
  print("caught:", caught);
} finally {
  print("finally ran");
}
print("done, caught:", caught);
