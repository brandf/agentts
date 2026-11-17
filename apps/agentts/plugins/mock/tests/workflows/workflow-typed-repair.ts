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
