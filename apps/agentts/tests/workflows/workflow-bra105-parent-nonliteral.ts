// Parent workflow for BRA-105 S7b: the workflow path is a variable,
// not a string literal. The extractor must refuse loudly — the site
// key (run:<workflow-literal>) and the frozen closure both need a
// literal path at first run.

import { run as runChild } from "../../src/agentts";
import type { Bra105ChildInput, Bra105ChildOutput } from "./workflow-bra105-child";

export default function run(): Bra105ChildOutput {
  const childPath = "./workflow-bra105-child.ts";
  return runChild<Bra105ChildInput, Bra105ChildOutput>({
    workflow: childPath,
    input: { n: 1 },
  });
}
