// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// Fail-fast bool on all() (Linear BRA-25): all([...], true) returns
// bare values on success and throws the first branch error at the call
// site. The parent catches it with ordinary try/catch, its finally
// block runs, and the parent keeps working afterwards (the run itself
// is NOT cancelled — only the siblings were). Two branches failing
// proves firstness is journal order: the first failure's error is
// thrown, the later failure never runs. Also exercises explicit
// all([...], false), which behaves exactly like all([...]).

interface StepInput {
  op: string;
  value?: number;
  verdicts?: Outcome[];
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
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }
declare function print(...args: unknown[]): void;
declare function all(thunks: (() => string)[], failFast?: boolean): Outcome[] | string[];

function judgePath(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  if (x === 5) throw new Error("judge crashed");
  if (x === 9) throw new Error("judge timed out");
  const b = step({ op: "verify", value: x }) as StepResult;
  return a.label + "/" + b.label;
}

// Success: bare values, in order.
const values = all([() => judgePath(7), () => judgePath(3)], true) as string[];
print("values:", JSON.stringify(values));

// Collect-all with explicit false: outcome objects, as all([...]).
const collected = all([() => judgePath(7), () => judgePath(5)], false) as Outcome[];
print("collected false:", JSON.stringify(collected));

// Throw + catch + finally + continue: branch 1 fails, branch 2 never runs.
let caught = "";
try {
  all([() => judgePath(7), () => judgePath(5), () => judgePath(3)], true);
} catch (e) {
  caught = (e as Error).message;
  print("caught is Error:", e instanceof Error);
} finally {
  print("finally ran");
}
print("caught:", caught);
const resumed = step({ op: "score", value: 11 }) as StepResult;
print("continued:", JSON.stringify(resumed));

// Firstness: branches 1 and 2 both fail; the first failure's error wins.
let first = "";
try {
  all([() => judgePath(7), () => judgePath(9), () => judgePath(5)], true);
} catch (e) {
  first = (e as Error).message;
}
print("first failure:", first);
