// Typed trap, repair loop (BRA-45/46 + Q10/BRA-38, mock-only): the test
// queues a bad first answer (score is a string) and configures a repair
// handler that returns a good answer. The plugin re-answers the SAME
// trap (same trapId) with the error attached; the repaired value
// validates and the workflow completes with it. The journal shows one
// validation-error (attempt 0) and then the trap-result.

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
  const r = trap<JobInput, JobResult>("job", { op: "score", value: 7 }) as JobResult;
  print("job:", JSON.stringify(r));
  print("done");
  return { done: true };
}
