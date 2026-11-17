// Checker fixture (BRA-29): a trap output typed as a CLASS.
// tsc passes (a class is a perfectly good type) and the extractor
// passes too (the generator silently drops the class-ness — a
// data-only class generates the same schema as the equivalent plain
// interface). The M2 checker must refuse it: class instances cannot
// cross a trap boundary (toJsonValue rejects them; a resumed result
// is a plain JSON object, no prototype, no methods).

import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}

// The class MUST stay at top level: the schema generator resolves
// the trap output type by name from the program's top-level
// declarations, and a function-local class is not findable as a root
// type (the extractor would throw before the checker ever runs).
class ScoreResult {
  score = 0;
  label = "";
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const j = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } });
  print("job:", JSON.stringify(j));
  print("done");
  return { done: true };
}
