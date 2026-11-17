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

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }

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
  return { done: true };
}
