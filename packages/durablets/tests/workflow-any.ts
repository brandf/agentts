// any() (Linear BRA-26): first success wins (bare value), the rest
// cancelled; if every branch fails it throws an AggregateError holding
// all the branch errors in branch order (Promise.any's shape). any([])
// throws an AggregateError with no errors, immediately.

interface StepInput {
  op: string;
  value?: number;
  verdicts?: unknown;
}

interface StepResult {
  score: number;
  label: string;
}

declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;
declare function any(thunks: (() => string)[]): string;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  // step() is a thin wrapper over the trap builtin: trap("job", input).
  function step(input: StepInput): StepResult { return trap("job", input) as StepResult; }

  function judgePath(x: number): string {
    const a = step({ op: "score", value: x }) as StepResult;
    if (x === 5) throw new Error("judge crashed");
    if (x === 9) throw new Error("judge timed out");
    const b = step({ op: "verify", value: x }) as StepResult;
    return a.label + "/" + b.label;
  }

  // First success wins: branch 0 fails, branch 1 succeeds, branch 2 never runs.
  const winner = any([() => judgePath(5), () => judgePath(7), () => judgePath(3)]);
  print("winner:", winner);

  // All fail: AggregateError, errors in branch order.
  try {
    any([() => judgePath(5), () => judgePath(9)]);
  } catch (e) {
    const agg = e as AggregateError;
    print("all-fail is AggregateError:", e instanceof AggregateError);
    print("all-fail errors:", JSON.stringify((agg.errors as Error[]).map((x) => x.message)));
  }

  // Empty: AggregateError with no errors.
  try {
    any([]);
  } catch (e) {
    const agg = e as AggregateError;
    print("empty any is AggregateError:", e instanceof AggregateError);
    print("empty any errors:", agg.errors.length);
  }
  return { done: true };
}
