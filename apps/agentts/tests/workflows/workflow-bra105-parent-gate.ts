// Parent workflow for BRA-105 S5/S8: calls the gating child inside
// try/catch. On success it returns the child's answer; on
// cancellation it reports the caught error name.

import { run as runChild } from "../../src/agentts";
import type {
  Bra105GateChildInput,
  Bra105GateChildOutput,
} from "./workflow-bra105-child-gate";

declare function print(...args: unknown[]): void;

export interface Bra105GateParentOutput {
  approved?: string;
  caught?: string;
}

export default function run(): Bra105GateParentOutput {
  try {
    const r = runChild<Bra105GateChildInput, Bra105GateChildOutput>({
      workflow: "./workflow-bra105-child-gate.ts",
      input: { question: "approve child?" },
    });
    print("parent got:", JSON.stringify(r));
    return { approved: r.approved };
  } catch (e) {
    const err = e as Error;
    print(`caught: ${err.name}: ${err.message}`);
    return { caught: err.name };
  }
}
