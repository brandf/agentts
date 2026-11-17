// BRA-67 test workflow: a single job trap (spec "bra67-marker").
// The worker is tests/fixtures/marker-worker.ts: it appends one
// line to input.markerFile, sleeps input.sleepMs, and returns
// { sleptMs }. The test's ghost worker does the same work but never
// completes the job, so the marker proves the work was done twice
// (once by the ghost, once by the retry) while the job itself
// completes exactly once.
import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface MarkerInput {
  markerFile: string;
  sleepMs: number;
}
interface MarkerResult {
  sleptMs: number;
}
export interface RunResult {
  sleptMs: number;
}

export default function run(input: MarkerInput): RunResult {
  const r = job<MarkerInput, MarkerResult>({ spec: "bra67-marker", input });
  print("slept:", r.sleptMs);
  return { sleptMs: r.sleptMs };
}
