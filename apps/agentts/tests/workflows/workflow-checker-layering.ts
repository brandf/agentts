// Checker fixture (BRA-29): a workflow importing the muse adapter
// directly. The host loads adapters; a workflow never imports one —
// and never touches anything Muse-specific. The M2 checker must
// refuse it at the layering boundary (M2-LAYER-MUSE and
// M2-LAYER-PLUGIN), before anything runs. The import itself
// type-checks (the adapter module exists and is typed), so the
// refusal is the checker's, not tsc's.

import { createAdapter } from "../../plugins/muse/src/adapter";
import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}
interface ScoreResult {
  score: number;
  label: string;
}

void createAdapter;
const j = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } });
print("job:", JSON.stringify(j));
print("done");
