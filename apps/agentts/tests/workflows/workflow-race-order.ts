// Mock-plugin port (BRA-45): identical runtime behavior to the core
// suite original; every trap call carries <Input, Output> type args
// (BRA-46 typed-trap regime) so the host extractor can derive schemas.
// Behavior 4: the cancel-versus-complete race, both orders, one
// workflow. Scenario A (result-first): the driver delivers the first
// step's result, then cancels the second step — the first result is
// kept. Scenario B (cancel-first): the driver cancels the first step
// before any result arrives — the result never lands, and the run is
// sticky afterwards, so the second step also throws at once.

interface StepInput {
  op: string;
  value?: number;
}

interface StepResult {
  score: number;
  label: string;
}

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): StepResult { return trap<StepInput, StepResult>("job", input) as StepResult; }
declare function print(...args: unknown[]): void;

try {
  const r = step({ op: "score", value: 7 });
  print("first got:", JSON.stringify(r));
} catch (e) {
  print("first threw:", (e as Error).name);
} finally {
  print("first finally ran");
}
try {
  const s = step({ op: "score", value: 3 });
  print("second got:", JSON.stringify(s));
} catch (e) {
  print("second threw:", (e as Error).name);
} finally {
  print("second finally ran");
}
print("done");
