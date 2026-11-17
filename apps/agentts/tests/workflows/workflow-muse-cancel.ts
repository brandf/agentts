// Cancel through the worker pool (BRA-48): one slow job in a
// try/catch. When the adapter's wait sees the job cancelled (via
// POST /cancel-job from another process), it throws JobCancelled and
// the workflow catches it at the call site, runs its finally block,
// and completes normally.

import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface SlowInput {
  sleepMs: number;
}

interface SlowResult {
  sleptMs: number;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  let caught = "";
  try {
    const r = job<SlowInput, SlowResult>({ spec: "slow-sleeper", input: { sleepMs: 30000 } });
    print("got:", JSON.stringify(r));
  } catch (e) {
    caught = (e as Error).name + ": " + (e as Error).message;
    print("caught:", caught);
    print("caught is Error:", (e as Error) instanceof Error);
  } finally {
    print("finally ran");
  }
  print("done, caught:", caught);
  return { done: true };
}
