// Parent workflow for BRA-105 S7a: calls a child file that does not
// exist. Submit must refuse loudly — the child is pinned in the
// parent's frozen closure at submit, so a missing child cannot be
// a runtime surprise.

import { run as runChild } from "../../src/agentts";
import type { Bra105ChildInput, Bra105ChildOutput } from "./workflow-bra105-child";

export default function run(): Bra105ChildOutput {
  return runChild<Bra105ChildInput, Bra105ChildOutput>({
    workflow: "./workflow-bra105-nope.ts",
    input: { n: 1 },
  });
}
