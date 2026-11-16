import { job } from "../../src/agentts";
import type { ScoreInput, ScoreResult } from "./_common";
const n: number = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } });
void n;
