// BRA-75 test workflow: a single job trap (spec "bra75-slow").
// The test crashes the host after / during dispatch and proves the
// job runs exactly once: the trapId-keyed enqueue dedupe (pool side)
// returns the existing job on re-dispatch, and the trap-dispatched
// journal record lets recovery deliver the first result instead of
// dispatching again. The worker is tests/fixtures/slow-worker.ts
// (sleeps input.sleepMs, returns { sleptMs }).
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
  const r = job<SlowInput, SlowResult>({ spec: "bra75-slow", input });
  print("slept:", r.sleptMs);
  return { sleptMs: r.sleptMs };
}
