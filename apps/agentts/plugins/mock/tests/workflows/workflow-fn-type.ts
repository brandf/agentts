declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

interface ScoreInput {
  op: string;
  value?: number;
}

interface FnResult {
  score: number;
  compute: (x: number) => string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const r = trap<ScoreInput, FnResult>("job", { op: "score", value: 7 });

  print("got:", JSON.stringify(r));
  return { done: true };
}
