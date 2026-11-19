// Child workflow for BRA-105 S5/S8: holds at a gate, then returns
// the delivered answer. The parent must stay suspended at the run
// trap while the child is held, and resume when the gate is
// answered (or catch CancellationError when the tree is cancelled).

import { gate } from "../../src/agentts";

declare function print(...args: unknown[]): void;

export interface Bra105GateChildInput {
  question: string;
}

export interface Bra105GateChildOutput {
  approved: string;
}

export default function run(input: Bra105GateChildInput): Bra105GateChildOutput {
  const g = gate({ question: input.question });
  print("child gate answered:", JSON.stringify(g));
  return { approved: g.answer };
}
