interface StepInput {
  op: string;
  value?: number;
  verdicts?: Outcome[];
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

declare function all(thunks: (() => string)[], failFast?: boolean): Outcome[] | string[];

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

  const values = all([() => judgePath(7), () => judgePath(3)], true) as string[];

  print("values:", JSON.stringify(values));

  const collected = all([() => judgePath(7), () => judgePath(5)], false) as Outcome[];

  print("collected false:", JSON.stringify(collected));

  let caught = "";

  try {
    all([() => judgePath(7), () => judgePath(5), () => judgePath(3)], true);
  } catch (e) {
    caught = (e as Error).message;
    print("caught is Error:", e instanceof Error);
  } finally {
    print("finally ran");
  }

  print("caught:", caught);

  const resumed = step({ op: "score", value: 11 }) as StepResult;

  print("continued:", JSON.stringify(resumed));

  let first = "";

  try {
    all([() => judgePath(7), () => judgePath(9), () => judgePath(5)], true);
  } catch (e) {
    first = (e as Error).message;
  }

  print("first failure:", first);
  return { done: true };
}
