// Host-only fixture (BRA-44): real exec + real decide through the
// direct adapter. No job traps (the direct adapter has no worker for
// the score spec); the gate is NOT used here (direct holds gates).

import { exec, sleep, decide } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface DecideResult {
  choice: string;
  confidence: number;
}

const e = exec({ cmd: "echo", args: ["hi"] });
print("exec:", JSON.stringify(e));

const s = sleep({ ms: 50 });
print("sleep:", JSON.stringify(s));

const d = decide<DecideResult>({
  question: "mean score 0.9 threshold 0.8; the work is ready. Converged?",
  options: ["converged", "continue"],
});
print("decide:", JSON.stringify(d));
print("done");
