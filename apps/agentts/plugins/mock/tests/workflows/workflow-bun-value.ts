declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}

interface ScoreResult {
  score: number;
  label: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  Bun.sleepSync(1);

  const j = trap<ScoreInput, ScoreResult>("job", { spec: "score", input: { value: 7 } }) as ScoreResult;

  print("job:", JSON.stringify(j));

  print("done");
  return { done: true };
}
