// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// Straight-through reference for workflow-nested.ts: the nested all()
// is modelled by running the sub-branches sequentially inside runBranch,
// exactly as the outer all() is modelled.

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

function subJudge(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  return a.label;
}

function judgePath(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  if (x === 7) {
    const subs = [runBranch(() => subJudge(11)), runBranch(() => subJudge(12))];
    return a.label + "/nested=" + JSON.stringify(subs);
  }
  const b = step({ op: "verify", value: x }) as StepResult;
  return a.label + "/" + b.label;
}

function runBranch(f: () => string): Outcome {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: { name: err.name, message: err.message } };
  }
}

const verdicts = [runBranch(() => judgePath(7)), runBranch(() => judgePath(3))];
print("verdicts:", JSON.stringify(verdicts));
