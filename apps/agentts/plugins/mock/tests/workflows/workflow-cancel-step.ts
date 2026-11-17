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

  let caught = "";

  try {
    const r = step({ op: "slow", value: 1 });
    print("got:", JSON.stringify(r));
  } catch (e) {
    caught = (e as Error).name + ": " + (e as Error).message;
    print("caught:", caught);
    print("caught is Error:", (e as Error) instanceof Error);
  } finally {
    print("finally ran");
  }

  print("done, caught:", caught);
  return { done: true };
}
