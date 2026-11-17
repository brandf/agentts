interface StepInput {
  op: string;
  value?: number;
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

  try {
    const r = step({ op: "score", value: 7 });
    print("first got:", JSON.stringify(r));
  } catch (e) {
    print("first threw:", (e as Error).name);
  } finally {
    print("first finally ran");
  }

  try {
    const s = step({ op: "score", value: 3 });
    print("second got:", JSON.stringify(s));
  } catch (e) {
    print("second threw:", (e as Error).name);
  } finally {
    print("second finally ran");
  }

  print("done");
  return { done: true };
}
