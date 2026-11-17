// Checker fixture (BRA-29): a trap output typed as an EMPTY
// interface. tsc passes and the extractor passes (the schema is
// `{type:"object", additionalProperties:false}` — not an empty `{}`,
// so the empty-subschema check cannot see it). The M2 checker must
// refuse it: the contract can carry no data — a degenerate contract
// (BRA-45 known limitation).

import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}

interface EmptyResult {}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const j = job<ScoreInput, EmptyResult>({ spec: "score", input: { value: 7 } });
  print("job:", JSON.stringify(j));
  print("done");
  return { done: true };
}
