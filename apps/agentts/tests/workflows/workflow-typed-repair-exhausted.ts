// Typed trap, repair exhausted (BRA-45/46 + Q10/BRA-38, mock-only): the
// test configures a repair handler that keeps returning a bad answer.
// After maxRepairAttempts repairs the plugin throws the ValidationError
// at the call site; the workflow catches it. The journal must show one
// validation-error per attempt (initial + each repair).

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface JobInput {
  op: string;
  value?: number;
}
interface JobResult {
  score: number;
  label: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  try {
    const r = trap<JobInput, JobResult>("job", { op: "score", value: 7 }) as JobResult;
    print("ERROR: bad output was accepted:", JSON.stringify(r));
  } catch (e) {
    print("caught:", (e as Error).name + ": " + (e as Error).message);
    print("caught is Error:", e instanceof Error);
  }
  print("done");
  return { done: true };
}
