// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// race() (Linear BRA-26): first settler wins — its bare value if it
// succeeded, its error if it failed (Promise.race's shape). The rest
// are cancelled. In this experiment the driver runs branches
// sequentially, so the first branch is always the first settler; the
// test proves the join/cancel/journal mechanics for both settle
// outcomes, and true time-based racing needs the real scheduler (M3).

interface Outcome {
  ok: boolean;
  value?: string;
  error?: { name: string; message: string };
}

interface StepInput {
  op: string;
  value?: number;
  verdicts?: Outcome[];
}

interface StepResult {
  score: number;
  label: string;
}

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;
declare function race(thunks: (() => string)[]): string;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  // step() is a thin wrapper over the trap builtin: trap("job", input).
  function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }

  function judgePath(x: number): string {
    const a = step({ op: "score", value: x }) as StepResult;
    if (x === 5) throw new Error("judge crashed");
    if (x === 9) throw new Error("judge timed out");
    const b = step({ op: "verify", value: x }) as StepResult;
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
  return { done: true };
}
