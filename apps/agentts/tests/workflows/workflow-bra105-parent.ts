// Parent workflow for BRA-105 S1: calls the child by path and
// returns its result as the trap result.

import { run as runChild } from "../../src/agentts";
import type { Bra105ChildInput, Bra105ChildOutput } from "./workflow-bra105-child";

declare function print(...args: unknown[]): void;

export interface Bra105ParentOutput {
  doubled: number;
  label: string;
}

export default function run(): Bra105ParentOutput {
  const r = runChild<Bra105ChildInput, Bra105ChildOutput>({
    workflow: "./workflow-bra105-child.ts",
    input: { n: 21 },
  });
  print("parent got:", JSON.stringify(r));
  return r;
}
