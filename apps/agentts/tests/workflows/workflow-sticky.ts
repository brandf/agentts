// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// Behavior 3: sticky cancellation. After the run is cancelled, every
// further step() or combinator call throws a CancellationError
// immediately — no dispatch, no suspension, no fork. The workflow
// catches each refusal and completes.

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
  // step() is a thin wrapper over the trap builtin: trap("job", input).
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
  // Every call below must throw at once — if any of them dispatches,
  // the run suspends again and the driver reports it.
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
