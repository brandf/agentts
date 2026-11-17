declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

interface JobInput {
  op: string;
  value?: number;
}

interface DatedResult {
  score: number;
  label: string;
  at: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const r = trap<JobInput, DatedResult>("job", { op: "score", value: 7 }) as DatedResult;

  print("job:", JSON.stringify(r));

  print("done");
  return { done: true };
}
