import { decide } from "../../src/agentts";
import type { DecideResult } from "./_common";
decide<DecideResult>({ question: "pick one", options: "ab" });
