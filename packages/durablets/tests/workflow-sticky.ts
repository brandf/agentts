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

declare function trap(type: string, arg: unknown): unknown;
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): StepResult { return trap("job", input) as StepResult; }
declare function print(...args: unknown[]): void;
declare function all(thunks: (() => string)[]): unknown[];

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
