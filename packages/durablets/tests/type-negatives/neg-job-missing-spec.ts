import { job } from "../../src/agentts";
import type { ScoreInput, ScoreResult } from "./_common";
job<ScoreInput, ScoreResult>({ input: { value: 7 } });
