// Checker fixture (BRA-29): an empty interface NESTED inside a
// contract type. The root type carries data (score), but its `meta`
// member is empty — the slot constrains to `{}`. The M2 checker
// must refuse it at $.meta, not just at the root.

import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}

interface EmptyMeta {}

interface ScoredResult {
  score: number;
  meta: EmptyMeta;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const j = job<ScoreInput, ScoredResult>({ spec: "score", input: { value: 7 } });
  print("job:", JSON.stringify(j));
  print("done");
  return { done: true };
}
