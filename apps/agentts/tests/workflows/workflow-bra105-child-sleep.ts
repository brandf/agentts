// Child workflow for BRA-105 S2: suspends on a sleep trap, then
// returns. The parent must see the child resume and complete.

import { sleep } from "../../src/agentts";

declare function print(...args: unknown[]): void;

export interface Bra105SleepChildInput {
  ms: number;
}

export interface Bra105SleepChildOutput {
  slept: boolean;
  sleptMs: number;
}

export default function run(input: Bra105SleepChildInput): Bra105SleepChildOutput {
  const r = sleep({ ms: input.ms });
  print("child slept:", r.sleptMs);
  return { slept: true, sleptMs: r.sleptMs };
}
