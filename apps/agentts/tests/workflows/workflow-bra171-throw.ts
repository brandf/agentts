// BRA-171 test workflow: a job trap whose answer is a throw; the
// workflow catches it and returns (and prints) the caught message's
// length. The THROW is what crosses argv to the C host on resume —
// with a ~200KB message it exceeds Linux's 128KB single-argument cap
// (MAX_ARG_STRLEN) and the resume spawn fails E2BIG on un-fixed code.
// Both trap calls carry <Input, Output> type args (BRA-46 typed-trap
// regime) — the declared output type applies even though the call
// throws.
declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export interface ScoreInput {
  op: string;
}
export interface ScoreResult {
  score: number;
  label: string;
}
export interface RunResult {
  caughtLen: number;
  caughtIsError: boolean;
}

export default function run(): RunResult {
  let caughtLen = -1;
  let caughtIsError = false;
  try {
    trap<ScoreInput, ScoreResult>("job", { op: "score" });
    print("ERROR: trap did not throw");
  } catch (e) {
    caughtIsError = e instanceof Error;
    caughtLen = e instanceof Error ? e.message.length : String(e).length;
  }
  print("caughtLen:", caughtLen);
  print("caughtIsError:", caughtIsError);
  return { caughtLen, caughtIsError };
}
