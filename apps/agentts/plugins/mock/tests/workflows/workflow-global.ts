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

  let sharedCount = 0;

  function readBranch(x: number): string {
    step({ op: "score", value: x });
    return "read:" + sharedCount;
  }

  function writeBranch(x: number): string {
    step({ op: "score", value: x });
    sharedCount = 99;
    return "read:" + sharedCount;
  }

  const verdicts = all([() => readBranch(21), () => writeBranch(22), () => readBranch(23)]);

  print("verdicts:", JSON.stringify(verdicts));

  print("empty all:", JSON.stringify(all([])));

  print("sharedCount after join:", sharedCount);
  return { done: true };
}
