interface StepInput {
  op: string;
  value?: number;
  verdicts?: Outcome[];
}

interface StepResult {
  score: number;
  label: string;
}

interface AggregateResult {
  approved: number;
  failed: number;
  summary: string;
}

type JobResult = StepResult | AggregateResult;

interface Outcome {
  ok: boolean;
  value?: string;
  error?: { name: string; message: string };
}

declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function step(input: StepInput): JobResult { return trap<StepInput, JobResult>("job", input) as JobResult; }

  function judgePath(x: number): string {
    const a = step({ op: "score", value: x }) as StepResult;
    if (x === 5) throw new Error("judge crashed");
    const b = step({ op: "verify", value: x }) as StepResult;
    return a.label + "/" + b.label;
  }

  function runBranch(f: () => string): Outcome {
    try {
      return { ok: true, value: f() };
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: { name: err.name, message: err.message } };
    }
  }

  const verdicts = [runBranch(() => judgePath(7)), runBranch(() => judgePath(3)), runBranch(() => judgePath(5))];

  print("verdicts:", JSON.stringify(verdicts));

  const agg = step({ op: "aggregate", verdicts: verdicts }) as AggregateResult;

  print("aggregate:", JSON.stringify(agg));
  return { done: true };
}
