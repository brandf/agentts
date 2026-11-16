// JudgeFixLoop-shaped workflow: three simulated judges (canned results,
// NOT real LLMs) run via all(), then an aggregate step combines their
// verdicts. One judge throws after scoring — collect-all must still
// return every outcome, the failed branch as { ok: false, error }.

interface StepInput {
  op: string;
  value?: number;
  verdicts?: unknown;
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

interface Outcome {
  ok: boolean;
  value?: string;
  error?: { name: string; message: string };
}

declare function step(input: StepInput): StepResult | AggregateResult;
declare function print(...args: unknown[]): void;
declare function all(thunks: (() => string)[]): Outcome[];

function judgePath(x: number): string {
  const a = step({ op: "score", value: x }) as StepResult;
  if (x === 5) throw new Error("judge crashed");
  const b = step({ op: "verify", value: x }) as StepResult;
  return a.label + "/" + b.label;
}

const verdicts = all([() => judgePath(7), () => judgePath(3), () => judgePath(5)]);
print("verdicts:", JSON.stringify(verdicts));
const agg = step({ op: "aggregate", verdicts: verdicts }) as AggregateResult;
print("aggregate:", JSON.stringify(agg));
