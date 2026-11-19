// Parent workflow for BRA-105 S4: calls the nested child and
// returns the grandchild's result, two levels down.

import { run as runChild } from "../../src/agentts";
import type { Bra105NestedChildInput } from "./workflow-bra105-child-nested";
import type { Bra105GrandchildOutput } from "./workflow-bra105-grandchild";

declare function print(...args: unknown[]): void;

export default function run(): Bra105GrandchildOutput {
  const r = runChild<Bra105NestedChildInput, Bra105GrandchildOutput>({
    workflow: "./workflow-bra105-child-nested.ts",
    input: { word: "hello" },
  });
  print("parent got:", JSON.stringify(r));
  return r;
}
