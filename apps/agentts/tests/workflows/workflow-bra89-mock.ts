// BRA-89 test workflow (mock adapter): a gate trap first (the mock
// adapter answers no trap slowly — its exec is canned — so the run
// strands at a held gate instead of a sleeping exec), then a
// bugfix-reproduce job served in-process by workflows/bugfix-worker.ts
// via the mock adapter's live runBugfix import. The reproduce step
// runs simulated (a fast static check, no build), so the control run
// completes deterministically. The test edits bugfix-worker.ts
// mid-run and restores the original in a finally block.
import { gate, job } from "../../src/agentts";

interface Bra89MockInput {
  repoRoot: string;
  workflow: string;
}

interface ReproduceInput {
  repoRoot: string;
  workflow: string;
}

interface ReproduceResult {
  reproduced: boolean;
  loops: number;
  converged: boolean;
  mean: number;
  evidence: string;
  runnableCopy: string;
  hostBin: string;
  error: string;
  simulated: boolean;
}

export interface RunResult {
  gateAnswer: string;
  reproduced: boolean;
  loops: number;
  converged: boolean;
  mean: number;
  simulated: boolean;
}

export default function run(input: Bra89MockInput): RunResult {
  const g = gate({ question: "proceed with the bugfix reproduce step?" });
  const r = job<ReproduceInput, ReproduceResult>({
    spec: "bugfix-reproduce",
    input: { repoRoot: input.repoRoot, workflow: input.workflow },
  });
  return {
    gateAnswer: g.answer,
    reproduced: r.reproduced,
    loops: r.loops,
    converged: r.converged,
    mean: r.mean,
    simulated: r.simulated,
  };
}
