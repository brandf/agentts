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

  function raceFn(fs: (() => string)[]): string {
    return fs[0]();
  }

  const winner = raceFn([() => judgePath(7), () => judgePath(5), () => judgePath(3)]);

  print("winner:", winner);

  let caught = "";

  try {
    raceFn([() => judgePath(5), () => judgePath(7)]);
  } catch (e) {
    caught = (e as Error).message;
    print("caught is Error:", e instanceof Error);
  } finally {
    print("finally ran");
  }

  print("caught:", caught);
  return { done: true };
}
