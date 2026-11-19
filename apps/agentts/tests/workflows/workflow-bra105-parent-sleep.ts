// Parent workflow for BRA-105 S2: calls the sleeping child and
// returns its result.

import { run as runChild } from "../../src/agentts";
import type {
  Bra105SleepChildInput,
  Bra105SleepChildOutput,
} from "./workflow-bra105-child-sleep";

declare function print(...args: unknown[]): void;

export default function run(): Bra105SleepChildOutput {
  const r = runChild<Bra105SleepChildInput, Bra105SleepChildOutput>({
    workflow: "./workflow-bra105-child-sleep.ts",
    input: { ms: 50 },
  });
  print("parent got:", JSON.stringify(r));
  return r;
}
