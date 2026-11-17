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
