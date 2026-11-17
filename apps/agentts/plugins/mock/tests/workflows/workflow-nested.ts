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
  function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }

  function subJudge(x: number): string {
    const a = step({ op: "score", value: x }) as StepResult;
    return a.label;
  }

  function judgePath(x: number): string {
    const a = step({ op: "score", value: x }) as StepResult;
    if (x === 7) {
      const subs = all([() => subJudge(11), () => subJudge(12)]);
      return a.label + "/nested=" + JSON.stringify(subs);
    }
    const b = step({ op: "verify", value: x }) as StepResult;
    return a.label + "/" + b.label;
  }

  const verdicts = all([() => judgePath(7), () => judgePath(3)]);

  print("verdicts:", JSON.stringify(verdicts));
  return { done: true };
}
