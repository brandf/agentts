import { job, exec, gate, sleep, cron, decide } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}

interface ScoreResult {
  score: number;
  label: string;
}

interface DecideResult {
  choice: string;
  confidence: number;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const j = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } });

  print("job:", JSON.stringify(j));

  const e = exec({ cmd: "echo hi" });

  print("exec:", JSON.stringify(e));

  const g = gate({ question: "approve?" });

  print("gate:", JSON.stringify(g));

  const s = sleep({ ms: 1000 });

  print("sleep:", JSON.stringify(s));

  const c = cron({ at: "2027-04-09T00:00:00Z" });

  print("cron:", JSON.stringify(c));

  const d = decide<DecideResult>({ question: "pick one", options: ["a", "b"] });

  print("decide:", JSON.stringify(d));

  print("done");
  return { done: true };
}
