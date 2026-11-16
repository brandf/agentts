import { job } from "../../src/agentts";
import type { ScoreInput, ScoreResult } from "./_common";
job<ScoreInput, ScoreResult>({ spec: "score", input: { value: "seven" } });
