// BRA-74 test workflow: a single job trap whose spec has no worker anywhere, so the job is
// never picked up and the server never settles it. The test drives it through the muse adapter
// and proves the adapter's derived job timeout (G14) fires — the drive fails with JobTimeout in
// ~leaseMs x maxAttempts + margin, not after the old fixed 600s default.
import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface NeverInput {
  sleepMs: number;
}
interface NeverResult {
  sleptMs: number;
}
export interface RunResult {
  sleptMs: number;
}

export default function run(input: NeverInput): RunResult {
  const r = job<NeverInput, NeverResult>({ spec: "bra74-never", input });
  print("slept:", r.sleptMs);
  return { sleptMs: r.sleptMs };
}
