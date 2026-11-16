// Error rehydration (Linear BRA-41), mock-plugin port (BRA-45): a throwing
// trap must arrive as a real Error, not a raw string or plain object. The
// mock plugin answers the first trap with throw:{"name":"Error","message":
// "boom"} and the second with throw:"plain failure" (a non-Error throw,
// which crosses as-is). The direct reference throws the same values
// locally; the two outputs must be byte-identical. Both trap calls carry
// <Input, Output> type args (BRA-46 typed-trap regime) — the declared
// output type applies even though these calls throw.

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface ScoreInput {
  op: string;
  value?: number;
}
interface ScoreResult {
  score: number;
  label: string;
}

try {
  trap<ScoreInput, ScoreResult>("job", { op: "score", value: 7 });
  print("ERROR: first trap did not throw");
} catch (e) {
  print("caught is Error:", e instanceof Error);
  print("caught:", (e as Error).name + ": " + (e as Error).message);
}

try {
  trap<ScoreInput, ScoreResult>("job", { op: "score", value: 3 });
  print("ERROR: second trap did not throw");
} catch (e) {
  print("plain is Error:", e instanceof Error);
  print("plain:", String(e));
}

print("done");
