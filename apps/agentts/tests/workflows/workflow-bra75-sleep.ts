// BRA-75 test workflow: a single sleep trap (real clock mode).
// The test kills the host mid-sleep and proves the recovery waits
// only the REMAINING time (from the trap's journaled wallTs), not
// the full duration — the total wait across both attempts is the
// requested ms, not twice it.
import { sleep } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface SleepInput {
  sleepMs: number;
}
export interface RunResult {
  sleptMs: number;
}

export default function run(input: SleepInput): RunResult {
  const r = sleep({ ms: input.sleepMs });
  print("slept:", r.sleptMs);
  return { sleptMs: r.sleptMs };
}
