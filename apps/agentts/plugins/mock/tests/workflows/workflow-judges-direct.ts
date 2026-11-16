// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// Straight-through reference for workflow-judges.ts: the same thunk
// bodies, run directly with no combinator. Each branch runs inside
// runBranch, which models collect-all: a throw becomes a failed outcome
// instead of escaping. The parent output must be byte-identical to the
// fork version's.

interface StepInput {
  op: string;
  value?: number;
  verdicts?: Outcome[];
}

interface StepResult {
  score: number;
  label: string;
}

interface AggregateResult {
  approved: number;
  failed: number;
  summary: string;
}

type JobResult = StepResult | AggregateResult;

interface Outcome {
  ok: boolean;
  value?: string;
  error?: { name: string; message: string };
}

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): JobResult { return trap<StepInput, JobResult>("job", input) as JobResult; }
declare function print(...args: unknown[]): void;

function judgePath(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  if (x === 5) throw new Error("judge crashed");
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

const verdicts = [runBranch(() => judgePath(7)), runBranch(() => judgePath(3)), runBranch(() => judgePath(5))];
print("verdicts:", JSON.stringify(verdicts));
const agg = step({ op: "aggregate", verdicts: verdicts }) as AggregateResult;
print("aggregate:", JSON.stringify(agg));
