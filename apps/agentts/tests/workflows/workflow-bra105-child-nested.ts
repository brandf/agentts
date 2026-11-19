// Child workflow for BRA-105 S4: itself calls the grandchild by
// path — nested run/call. Its result is the grandchild's result.

import { run as runChild } from "../../src/agentts";
import type {
  Bra105GrandchildInput,
  Bra105GrandchildOutput,
} from "./workflow-bra105-grandchild";

declare function print(...args: unknown[]): void;

export interface Bra105NestedChildInput {
  word: string;
}

export default function run(input: Bra105NestedChildInput): Bra105GrandchildOutput {
  const r = runChild<Bra105GrandchildInput, Bra105GrandchildOutput>({
    workflow: "./workflow-bra105-grandchild.ts",
    input: { word: input.word },
  });
  print("middle got:", JSON.stringify(r));
  return r;
}
