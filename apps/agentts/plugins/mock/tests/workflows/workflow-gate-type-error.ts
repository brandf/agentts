import { job } from "../../src/agentts";

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
  const j = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: "seven" } });

  print("job:", JSON.stringify(j));

  print("done");
  return { done: true };
}
