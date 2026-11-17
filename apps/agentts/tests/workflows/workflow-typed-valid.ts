// Typed trap, valid path (BRA-45/46, mock-only): a job trap and a decide
// trap with concrete named types. The test queues the decide answer
// ("the next decide returns X at confidence 0.6") and the job uses the
// default canned score:7 result. Both must validate against the
// extracted schemas and complete with no validation-error events.

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
interface DecideInput {
  question: string;
  options?: string[];
}
interface DecideResult {
  choice: string;
  confidence: number;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const r = trap<JobInput, JobResult>("job", { op: "score", value: 7 }) as JobResult;
  print("job:", JSON.stringify(r));

  const d = trap<DecideInput, DecideResult>("decide", {
    question: "pick one",
    options: ["a", "b"],
  }) as DecideResult;
  print("decide:", JSON.stringify(d));
  print("done");
  return { done: true };
}
