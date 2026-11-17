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

declare function all(thunks: (() => string)[]): unknown[];

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }

  let caught = "";

  try {
    const a = step({ op: "score", value: 7 });
    print("a:", JSON.stringify(a));
  } catch (e) {
    caught = (e as Error).name;
    print("caught:", caught);
  } finally {
    print("finally ran");
  }

  try {
    const b = step({ op: "score", value: 3 });
    print("ERROR: second step dispatched:", JSON.stringify(b));
  } catch (e) {
    print("second threw:", (e as Error).name);
  }

  try {
    const v = all([() => "x"]);
    print("ERROR: all dispatched:", JSON.stringify(v));
  } catch (e) {
    print("all threw:", (e as Error).name);
  }

  print("done");
  return { done: true };
}
