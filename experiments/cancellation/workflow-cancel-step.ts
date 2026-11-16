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

declare function step(input: StepInput): StepResult;
declare function print(...args: unknown[]): void;

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
