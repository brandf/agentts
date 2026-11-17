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
  return { done: true };
}
