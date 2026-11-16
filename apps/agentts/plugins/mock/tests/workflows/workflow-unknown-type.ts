// Negative extraction fixture (BRA-46): a trap call whose output type
// argument is `unknown` — it has nothing to extract. The host must
// FAIL LOUDLY at first run.

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface ScoreInput {
  op: string;
  value?: number;
}

const r = trap<ScoreInput, unknown>("job", { op: "score", value: 7 });
print("got:", JSON.stringify(r));
