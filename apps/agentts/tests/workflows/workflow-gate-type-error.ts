// Gate fixture (BRA-44/29): a workflow with a genuine type error.
// The agentts module's job() takes { spec, input } with input typed
// ScoreInput — but here value is a string where a number is required.
// tsc must refuse it at the first-run gate (TS2322) and the run must
// never start. This file must never execute; the gate test submits it,
// reads the structured diagnostics, fixes it, and resubmits.

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
