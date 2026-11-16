// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// Straight-through reference for workflow-any.ts: the same thunk
// bodies, run directly with no combinator. anyFn() models any():
// first success wins (bare value), the rest never run; if every
// branch fails it throws an AggregateError of all errors in branch
// order; any([]) throws an AggregateError with no errors. The parent
// output must be byte-identical to the fork version's.

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
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }
declare function print(...args: unknown[]): void;

function judgePath(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  if (x === 5) throw new Error("judge crashed");
  if (x === 9) throw new Error("judge timed out");
  const b = step({ op: "verify", value: x }) as StepResult;
  return a.label + "/" + b.label;
}

function anyFn(fs: (() => string)[]): string {
  const errors: Error[] = [];
  for (const f of fs) {
    try {
      return f();
    } catch (e) {
      errors.push(e as Error);
    }
  }
  throw new AggregateError(errors, "All branches failed");
}

const winner = anyFn([() => judgePath(5), () => judgePath(7), () => judgePath(3)]);
print("winner:", winner);

try {
  anyFn([() => judgePath(5), () => judgePath(9)]);
} catch (e) {
  const agg = e as AggregateError;
  print("all-fail is AggregateError:", e instanceof AggregateError);
  print("all-fail errors:", JSON.stringify((agg.errors as Error[]).map((x) => x.message)));
}

try {
  anyFn([]);
} catch (e) {
  const agg = e as AggregateError;
  print("empty any is AggregateError:", e instanceof AggregateError);
  print("empty any errors:", agg.errors.length);
}
