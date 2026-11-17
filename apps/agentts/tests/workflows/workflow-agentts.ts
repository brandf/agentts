// Module resolution (Linear BRA-46): a workflow that imports the
// agentts module. The TS host bundles workflow + agentts module into
// one self-contained script (Bun.build) and hands that to the C host
// to eval; the C host never resolves imports. The wrappers call trap()
// with the right type, so the plugin answers each with its canned
// result — the same literals as workflow-trap-types.ts.
//
// Every trap call here uses a concrete, named type at the call site:
// that is the author pattern the host's type extractor relies on (the
// extractor reads the type arguments off these calls). No casts: the
// wrappers' generic return types carry the result type.

import { job, exec, gate, sleep, cron, decide } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}

interface ScoreResult {
  score: number;
  label: string;
}

// This workflow names its own decide result type at the call site
// (the canonical Decision shape is in the agentts module since
// BRA-47, but this workflow is not a cascade — it keeps its own
// local DecideResult).
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
