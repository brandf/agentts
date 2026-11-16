import { job } from "../../src/agentts";
import type { ScoreResult } from "./_common";
// One type argument fills Input, not Output — so the input value does not
// match ScoreResult, and the result is unknown, not ScoreResult.
const r: ScoreResult = job<ScoreResult>({ spec: "score", input: { value: 7 } });
void r;
