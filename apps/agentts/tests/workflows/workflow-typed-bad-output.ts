// Typed trap, bad output (BRA-45/46, mock-only): the test queues a job
// answer whose score is a string, violating the extracted JobResult
// schema (score must be a number). The plugin must throw a
// ValidationError at the call site with the precise error, journaled.
// No repair handler is configured, so the first failure throws.

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
