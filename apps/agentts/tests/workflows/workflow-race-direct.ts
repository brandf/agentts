// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// Straight-through reference for workflow-race.ts: the same thunk
// bodies, run directly with no combinator. raceFn() models race():
// the first branch settles the call — its bare value on success, its
// error thrown on failure — and the rest never run. The parent output
// must be byte-identical to the fork version's.

interface Outcome {
  ok: boolean;
  value?: string;
  error?: { name: string; message: string };
}

interface StepInput {
  op: string;
  value?: number;
  verdicts?: Outcome[];
}

interface StepResult {
  score: number;
  label: string;
}

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }
declare function print(...args: unknown[]): void;

function judgePath(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  if (x === 5) throw new Error("judge crashed");
  if (x === 9) throw new Error("judge timed out");
  const b = step({ op: "verify", value: x }) as StepResult;
  return a.label + "/" + b.label;
}

function raceFn(fs: (() => string)[]): string {
  return fs[0]();
}

const winner = raceFn([() => judgePath(7), () => judgePath(5), () => judgePath(3)]);
print("winner:", winner);

let caught = "";
try {
  raceFn([() => judgePath(5), () => judgePath(7)]);
} catch (e) {
  caught = (e as Error).message;
  print("caught is Error:", e instanceof Error);
} finally {
  print("finally ran");
}
print("caught:", caught);
