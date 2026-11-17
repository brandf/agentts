// Error rehydration (Linear BRA-41): a throwing trap must arrive as
// a real Error, not a raw string or plain object. The reference plugin
// answers the first trap with throw:{"name":"Error","message":"boom"}
// and the second with throw:"plain failure" (a non-Error throw, which
// crosses as-is). The direct reference throws the same values locally;
// the two outputs must be byte-identical.

declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  try {
    trap("job", { op: "score", value: 7 });
    print("ERROR: first trap did not throw");
  } catch (e) {
    print("caught is Error:", e instanceof Error);
    print("caught:", (e as Error).name + ": " + (e as Error).message);
  }

  try {
    trap("job", { op: "score", value: 3 });
    print("ERROR: second trap did not throw");
  } catch (e) {
    print("plain is Error:", e instanceof Error);
    print("plain:", String(e));
  }

  print("done");
  return { done: true };
}
