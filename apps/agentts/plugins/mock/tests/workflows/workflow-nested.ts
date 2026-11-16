// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// Nested all(): a branch that itself calls all(). Branch 0 fans out to
// two sub-judges and joins them; branch 1 is a plain judge. The same
// suspend-snapshot-spawn-join machinery must run recursively, with the
// nested fork recorded in the branch's journal (parent fork id = the
// nested fork), and the parent's verdicts must still match the reference.

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
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }
declare function print(...args: unknown[]): void;
declare function all(thunks: (() => string)[]): Outcome[];

function subJudge(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  return a.label;
}

function judgePath(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  if (x === 7) {
    const subs = all([() => subJudge(11), () => subJudge(12)]);
    return a.label + "/nested=" + JSON.stringify(subs);
  }
  const b = step({ op: "verify", value: x }) as StepResult;
  return a.label + "/" + b.label;
}

const verdicts = all([() => judgePath(7), () => judgePath(3)]);
print("verdicts:", JSON.stringify(verdicts));
