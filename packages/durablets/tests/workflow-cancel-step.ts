// Behavior 1: cancel a pending step. The driver runs this workflow,
// lets it suspend at the step, then delivers a cancellation instead
// of a result. The workflow must see a CancellationError at the step
// call site, run its finally block, and complete.

interface StepInput {
  op: string;
  value?: number;
}

interface StepResult {
  score: number;
  label: string;
}

declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  // step() is a thin wrapper over the trap builtin: trap("job", input).
  function step(input: StepInput): StepResult { return trap("job", input) as StepResult; }

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
