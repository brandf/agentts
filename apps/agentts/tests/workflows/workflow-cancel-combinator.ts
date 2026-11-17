// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
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

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;
declare function all(thunks: (() => string)[]): Outcome[];

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  // step() is a thin wrapper over the trap builtin: trap("job", input).
  function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }

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
  return { done: true };
}
