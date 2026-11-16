// M2-BUN positive fixture (BRA-58): a workflow that uses `Bun`
// only in TYPE positions. The gate's tsc half passes (the gate
// program includes bun-types), the M2-BUN checker rule does not
// fire (no value use), and the workflow RUNS under the engine —
// types erase, so no Bun global is ever touched at runtime. The
// cast supplies a plain object with a `name` for the helper; the
// helper only reads `.name`, which the object has.

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}
interface ScoreResult {
  score: number;
  label: string;
}

function label(f: Bun.BunFile): string {
  return f.name ?? "";
}

const fileName = label({ name: "notes.txt" } as unknown as Bun.BunFile);
print("label:", fileName);

const j = trap<ScoreInput, ScoreResult>("job", { spec: "score", input: { value: 7 } }) as ScoreResult;
print("job:", JSON.stringify(j));
print("done");
