// BRA-61 test workflow: a single job trap (spec "slow-sleeper").
//
// The test takes the job as a fake silent worker, lets it be nudged
// and re-queued, then a real loop worker completes it — the run's
// journal must show the nudge and the re-queue as they happened.
import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface SlowInput {
  sleepMs: number;
}

interface SlowResult {
  sleptMs: number;
}

export interface RunResult {
  sleptMs: number;
}

export default function run(input: SlowInput): RunResult {
  const r = job<SlowInput, SlowResult>({ spec: "slow-sleeper", input });
  print("slept:", r.sleptMs);
  return { sleptMs: r.sleptMs };
}
