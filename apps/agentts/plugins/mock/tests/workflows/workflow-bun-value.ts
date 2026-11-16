// M2-BUN negative fixture (BRA-58): a workflow that calls the Bun
// global in a VALUE position. The gate's tsc half passes (the gate
// program includes bun-types for type-checking), so the M2-BUN
// checker rule must refuse it — the engine (dquickts) provides no
// Bun global, so Bun.sleepSync would fail at runtime.

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}
interface ScoreResult {
  score: number;
  label: string;
}

Bun.sleepSync(1);

const j = trap<ScoreInput, ScoreResult>("job", { spec: "score", input: { value: 7 } }) as ScoreResult;
print("job:", JSON.stringify(j));
print("done");
